import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { digest, equal } from './crypto.mjs';
import { fail } from './repository.mjs';

const scrypt = promisify(scryptCallback);
export const roles = ['controller', 'master', 'technologist', 'leader', 'administrator'];
export async function passwordHash(password, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: Buffer.from(await scrypt(password, salt, 64)).toString('hex') };
}

/** Sessions and throttling live in PostgreSQL, including across replica restarts. */
export function createAuth(repo, crypto) {
  const auth = {
    async limited(client, id, limit, seconds) {
      const { rows } = await client.query('INSERT INTO rate_limits(id,count,resets_at) VALUES($1,1,now()+$2 * interval \'1 second\') ON CONFLICT(id) DO UPDATE SET count=CASE WHEN rate_limits.resets_at<now() THEN 1 ELSE rate_limits.count+1 END,resets_at=CASE WHEN rate_limits.resets_at<now() THEN EXCLUDED.resets_at ELSE rate_limits.resets_at END RETURNING count', [id, seconds]);
      return rows[0].count > limit;
    },
    async session(client, request) {
      const token = /(?:^|;\s*)orbita_session=([A-Za-z0-9_-]+)/.exec(request.headers.cookie ?? '')?.[1];
      if (!token) return null;
      const hash = digest(token);
      const { rows } = await client.query('UPDATE sessions SET idle_until=now()+interval \'30 minutes\' WHERE token_hash=$1 AND expires_at>now() AND idle_until>now() RETURNING payload', [hash]);
      if (!rows[0]) return null;
      const session = crypto.open(rows[0].payload, `session:${hash}`);
      if (process.env.DEMO_MODE !== 'true' && session.method !== 'password') return null;
      const account = await repo.get(client, 'users', session.user.id);
      if (!account || account.value.disabled) return null;
      return { ...session, user: { id: account.value.id, role: account.value.role, lineIds: account.value.lineIds }, hash };
    },
    async demoSession(client, body) {
      if (process.env.DEMO_MODE !== 'true') throw fail(404, 'Режим демонстрации выключен');
      if (!roles.includes(body.role)) throw fail(422, 'Недопустимая роль');
      const account = await repo.get(client, 'users', `${body.role}-01`);
      const user = { id: account.value.id, role: account.value.role, lineIds: account.value.lineIds };
      const token = randomBytes(32).toString('base64url'), hash = digest(token);
      const session = { method: 'demo', user, csrfToken: randomBytes(32).toString('base64url'), createdAt: new Date().toISOString() };
      await client.query("INSERT INTO sessions(token_hash,user_id,payload,expires_at,idle_until) VALUES($1,$2,$3,now()+interval '8 hours',now()+interval '30 minutes')", [hash, user.id, crypto.seal(session, `session:${hash}`)]);
      await repo.append(client, 'security', { type: 'auth.demo_role_selected', actor: user.id, role: user.role, at: new Date().toISOString() });
      return { status: 200, body: { authenticated: true, ...session }, headers: { 'Set-Cookie': `orbita_session=${token}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800` } };
    },
    async login(client, request, body) {
      if (typeof body.id !== 'string' || typeof body.password !== 'string' || body.id.length > 128 || body.password.length > 256) throw fail(422, 'Некорректные учётные данные');
      const source = request.headers['x-real-ip'] ?? request.socket.remoteAddress;
      const blockedAccount = await auth.limited(client, `login:${body.id}`, 8, 300);
      const blockedSource = await auth.limited(client, `ip:${source}`, 40, 300);
      if (blockedAccount || blockedSource) return { status: 429, body: { error: 'Слишком много попыток. Повторите через 5 минут.' } };
      const account = await repo.get(client, 'users', body.id);
      const candidate = await passwordHash(body.password, account?.value.password.salt ?? '00000000000000000000000000000000');
      if (!account || account.value.disabled || !equal(candidate.hash, account.value.password.hash)) {
        await repo.append(client, 'security', { type: 'auth.failed', actor: body.id, at: new Date().toISOString(), source });
        return { status: 401, body: { error: 'Неверные учётные данные' } };
      }
      const user = { id: account.value.id, role: account.value.role, lineIds: account.value.lineIds };
      const token = randomBytes(32).toString('base64url');
      const hash = digest(token);
      const session = { method: 'password', user, csrfToken: randomBytes(32).toString('base64url'), createdAt: new Date().toISOString() };
      await client.query('INSERT INTO sessions(token_hash,user_id,payload,expires_at,idle_until) VALUES($1,$2,$3,now()+interval \'8 hours\',now()+interval \'30 minutes\')', [hash, user.id, crypto.seal(session, `session:${hash}`)]);
      await client.query('DELETE FROM rate_limits WHERE id=$1', [`login:${body.id}`]);
      await repo.append(client, 'security', { type: 'auth.login', actor: user.id, role: user.role, at: new Date().toISOString() });
      return { status: 200, body: { authenticated: true, ...session }, headers: { 'Set-Cookie': `orbita_session=${token}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800` } };
    },
    require(request, session, allowed = roles) {
      if (!session) throw fail(401, 'Требуется вход');
      if (!allowed.includes(session.user.role)) throw fail(403, 'Недостаточно прав');
      if (!['GET','HEAD'].includes(request.method) && !equal(String(request.headers['x-csrf-token'] ?? ''), session.csrfToken)) throw fail(403, 'Недействительный CSRF-токен');
      return session.user;
    },
  };
  return auth;
}
