import { randomUUID } from 'node:crypto';
import { digest, equal } from './crypto.mjs';
import { lock } from './db.mjs';

export const fail = (status, message) => Object.assign(new Error(message), { status });

/** Persistence port: callers supply the transaction, so events, decisions and outbox commit together. */
export function createRepository(crypto) {
  const repo = {
    async get(client, namespace, id) {
      const { rows } = await client.query('SELECT payload,revision FROM documents WHERE namespace=$1 AND id=$2', [namespace, id]);
      return rows[0] ? { value: crypto.open(rows[0].payload, `document:${namespace}:${id}`), revision: Number(rows[0].revision) } : null;
    },
    async put(client, namespace, id, value) {
      const { rows } = await client.query('INSERT INTO documents(namespace,id,payload) VALUES($1,$2,$3) ON CONFLICT(namespace,id) DO UPDATE SET payload=EXCLUDED.payload,revision=documents.revision+1,updated_at=now() RETURNING revision', [namespace, id, crypto.seal(value, `document:${namespace}:${id}`)]);
      return Number(rows[0].revision);
    },
    async append(client, stream, event) {
      await lock(client, `journal:${stream}`);
      const { rows } = await client.query('SELECT seq,mac FROM stream_heads WHERE stream=$1', [stream]);
      const seq = Number(rows[0]?.seq ?? 0) + 1;
      const id = randomUUID();
      const record = { stream, seq, id, prev: rows[0]?.mac ?? '', payload: crypto.seal(event, `journal:${stream}:${seq}`) };
      const mac = crypto.mac(record);
      await client.query('INSERT INTO journal(stream,seq,id,prev,payload,mac) VALUES($1,$2,$3,$4,$5,$6)', [stream, seq, id, record.prev, record.payload, mac]);
      await client.query('INSERT INTO stream_heads(stream,seq,mac) VALUES($1,$2,$3) ON CONFLICT(stream) DO UPDATE SET seq=$2,mac=$3', [stream, seq, mac]);
      return { id, seq, mac };
    },
    async history(client, { item, lines } = {}) {
      const { rows } = await client.query('SELECT event_id,payload FROM events WHERE ($1::text IS NULL OR item_id=$1) AND ($2::text[] IS NULL OR line_id=ANY($2)) ORDER BY occurred_at,event_id', [item ?? null, lines ?? null]);
      return rows.map(row => crypto.open(row.payload, `event:${row.event_id}`));
    },
    async ingest(client, row, validate, { trusted = false, actor = 'source' } = {}) {
      const e = row?.message;
      let problem = validate(row);
      const protectedTypes = ['quality_decision','cause_review','master_action','manual_measurement','controller_check','technical_disposition','master_process_report','evidence_request','service_report','manual_inspection'];
      if (!trusted && (protectedTypes.includes(e?.event_type) || ['ORBITA-UI','ORBITA-DEMO'].includes(e?.source_id))) problem = 'Human decisions require an authenticated workflow command';
      let kind = problem ? 'error' : 'accepted';
      if (!problem) {
        await lock(client, `item:${e.item_id}`);
        const existing = await client.query('SELECT fingerprint FROM events WHERE event_id=$1', [e.event_id]);
        if (existing.rows[0]) {
          kind = existing.rows[0].fingerprint === digest(e) ? 'duplicate' : 'error';
          if (kind === 'error') problem = 'Event ID conflicts with immutable original';
        } else {
          const later = await client.query('SELECT 1 FROM events WHERE item_id=$1 AND occurred_at>$2 LIMIT 1', [e.item_id, e.occurred_at]);
          if (later.rowCount) kind = 'late';
          const received = new Date().toISOString();
          const stored = { ...row, received_at: received };
          const journal = await repo.append(client, `item:${e.item_id}`, { type: 'event.accepted', actor, event: stored, fingerprint: digest(e) });
          await client.query('INSERT INTO events(event_id,item_id,line_id,event_type,occurred_at,fingerprint,journal_id,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [e.event_id, e.item_id, e.line_id, e.event_type, e.occurred_at, digest(e), journal.id, crypto.seal(stored, `event:${e.event_id}`)]);
        }
      }
      const result = { delivery_id: row?.delivery_id ?? '?', event_id: e?.event_id ?? '?', item_id: e?.item_id ?? '?', source_id: e?.source_id ?? 'UNKNOWN', kind, reason: problem ?? (kind === 'late' ? 'Позднее событие включено в историю' : kind === 'duplicate' ? 'Точный повтор' : 'Принято'), received_at: new Date().toISOString() };
      await client.query('INSERT INTO ingest_receipts(delivery_id,event_id,outcome,payload) VALUES($1,$2,$3,$4)', [result.delivery_id, result.event_id, kind, crypto.seal({ result, original: row }, 'ingest-receipt')]);
      return result;
    },
    async verify(client) {
      const snapshot = (await client.query("SELECT (SELECT coalesce(json_agg(j ORDER BY stream,seq),'[]') FROM journal j) AS records,(SELECT coalesce(json_agg(h ORDER BY stream),'[]') FROM stream_heads h) AS heads")).rows[0];
      const rows = snapshot.records;
      const heads = new Map();
      for (const row of rows) {
        const prior = heads.get(row.stream) ?? { seq: 0, mac: '' };
        const record = { stream: row.stream, seq: Number(row.seq), id: row.id, prev: row.prev, payload: row.payload };
        if (record.seq !== prior.seq + 1 || record.prev !== prior.mac || !equal(row.mac, crypto.mac(record, row.payload.key_id))) throw fail(503, 'Нарушена целостность журнала');
        crypto.open(row.payload, `journal:${row.stream}:${row.seq}`);
        heads.set(row.stream, { seq: record.seq, mac: row.mac });
      }
      const saved = { rows: snapshot.heads, rowCount: snapshot.heads.length };
      if (saved.rowCount !== heads.size || saved.rows.some(row => Number(row.seq) !== heads.get(row.stream)?.seq || row.mac !== heads.get(row.stream)?.mac)) throw fail(503, 'Нарушена контрольная точка журнала');
      return { valid: true, entries: rows.length, streams: heads.size, head: digest(saved.rows) };
    },
    async queue(client, id, item, destination, payload) {
      await client.query('INSERT INTO outbox(id,item_id,destination,payload) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [id, item, destination, crypto.seal(payload, `outbox:${id}`)]);
    },
  };
  return repo;
}
