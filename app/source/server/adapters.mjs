import path from 'node:path';
import { Readable } from 'node:stream';
import { createIntegration } from '../../integration.mjs';
import { createPlantIntegrations } from '../../plant-integrations.mjs';
import { createMobileOps } from '../../mobileops.mjs';
import { lock } from './db.mjs';
import { fail } from './repository.mjs';
import { digest } from './crypto.mjs';
import { domain } from './workflow.mjs';

/** Adapt existing protocol clients to transaction-scoped durable state; never share mutable state across requests. */
export async function withAdapters(client, repo, directory, contracts, work) {
  await lock(client, 'integration-state');
  const storage = {
    async readJson(file) { return (await repo.get(client, 'adapters', path.basename(file)))?.value ?? null; },
    async writeJson(file, value) { await repo.put(client, 'adapters', path.basename(file), value); },
  };
  const integration = await createIntegration({ directory, contracts, storage,
    getBaseUrl: () => process.env.EMULATOR_URL || 'https://emulator:8443', internalToken: process.env.EMULATOR_TOKEN });
  integration.close();
  const history = await repo.history(client);
  const authorized = new Map(history.filter(row => row.message.event_type === 'quality_decision').map(row => [row.message.event_id, digest(row.message)]));
  const plant = await createPlantIntegrations({ directory, contracts, storage, importAssembly: integration.importAssembly,
    authorizeDecision: event => authorized.get(event?.event_id) === digest(event) });
  plant.close();
  const mobile = await createMobileOps({ directory, contracts, storage, audit: { append: event => repo.append(client, 'mobile', event) } });
  const invoke = async (adapter, route, body, principal, method = body === undefined ? 'GET' : 'POST') => {
    const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    request.method = method; request.url = route; request.headers = { 'content-type': 'application/json' };
    let code = 200, result;
    const response = { writeHead(status) { code = status; return this; }, end(value) { result = JSON.parse(value); } };
    await adapter.handle(request, response, route, principal);
    if (code >= 400) throw fail(code, result?.error ?? 'Ошибка адаптера');
    return result;
  };
  const result = await work({ integration, plant, mobile, invoke });
  for (const row of [...plant.status().mes.deliveries, ...mobile.deliveredEvents({ user: { lineIds: [...new Set(history.map(row => row.message.line_id))] } })]) {
    const existing = await client.query('SELECT 1 FROM events WHERE event_id=$1', [row.message.event_id]);
    if (!existing.rowCount) {
      const outcome = await repo.ingest(client, row, domain.validateDelivery, { actor: 'integration-adapter' });
      if (outcome.kind === 'error') throw fail(422, outcome.reason);
    }
  }
  return result;
}
