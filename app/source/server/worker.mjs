import { randomUUID } from 'node:crypto';
import { transaction } from './db.mjs';
import { erpQualityStatus } from './integration-policy.mjs';
import { withAdapters } from './adapters.mjs';

/** Claim with SKIP LOCKED and a fenced lease. Stable message IDs make a lost acknowledgement safe to retry. */
export async function dispatchOne(pool, repo, crypto, directory, contracts) {
  const lease = randomUUID();
  const job = await transaction(pool, async client => {
    const { rows } = await client.query(`SELECT o.* FROM outbox o WHERE
      ((o.status IN ('pending','retry_wait') AND o.available_at<=now()) OR (o.status='sending' AND o.lease_until<now()))
      AND NOT EXISTS(SELECT 1 FROM outbox earlier WHERE earlier.item_id=o.item_id AND earlier.destination=o.destination
        AND (earlier.created_at,earlier.id)<(o.created_at,o.id) AND earlier.status <> 'accepted')
      ORDER BY o.created_at,o.id FOR UPDATE SKIP LOCKED LIMIT 1`);
    if (!rows[0]) return null;
    await client.query("UPDATE outbox SET status='sending',attempts=attempts+1,lease_id=$2,lease_until=now()+interval '60 seconds',updated_at=now() WHERE id=$1", [rows[0].id, lease]);
    return { ...rows[0], attempts: rows[0].attempts + 1 };
  });
  if (!job) return false;
  try {
    const event = crypto.open(job.payload, `outbox:${job.id}`);
    const receipt = await transaction(pool, client => withAdapters(client, repo, directory, contracts, async adapters => {
      if (job.destination === 'mes') return adapters.invoke(adapters.plant, '/api/plant/mes/decisions', event);
      if (job.destination === 'executive') {
        if (!await repo.get(client, 'executive-inbox', job.id)) {
          await repo.put(client, 'executive-inbox', job.id, event);
          await repo.append(client, 'executive-inbox', { type: 'executive.delivered', messageId: job.id, payload: event, at: new Date().toISOString() });
        }
        return { status: 'accepted', message_id: job.id };
      }
      const dataset = (await repo.get(client, 'system', 'dataset')).value;
      const item = dataset.items.find(row => row.id === event.item_id);
      await adapters.invoke(adapters.integration, '/api/integrations/pull', { work_order_id: item.work_order_id });
      return adapters.invoke(adapters.integration, '/api/integrations/results', {
        item_id: event.item_id,
        quality_status: erpQualityStatus(event),
        basis_event_ids: [event.event_id],
      });
    }));
    if (receipt.status !== 'accepted') throw new Error(receipt.last_error ?? 'Получатель ещё не подтвердил доставку');
    await transaction(pool, async client => {
      const updated = await client.query("UPDATE outbox SET status='accepted',receipt=$3,lease_until=NULL,last_error=NULL,updated_at=now() WHERE id=$1 AND lease_id=$2", [job.id, lease, crypto.seal(receipt, `receipt:${job.id}`)]);
      if (updated.rowCount) await repo.append(client, `delivery:${job.item_id}`, { type: 'integration.accepted', id: job.id, destination: job.destination, attempts: job.attempts, at: new Date().toISOString() });
    });
  } catch (error) {
    await pool.query("UPDATE outbox SET status=$3,last_error=$4,available_at=now()+$5*interval '1 second',lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_id=$2", [job.id, lease, job.attempts >= 8 ? 'failed' : 'retry_wait', String(error.message).slice(0,1000), Math.min(300, 2 ** job.attempts + Math.random())]);
  }
  return true;
}

/** One shared poll cursor across replicas; MES ingestion continues without an open browser. */
export async function synchronizePlant(pool, repo, directory, contracts) {
  return transaction(pool, async client => {
    const held = await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended('mes-poll',0)) AS acquired");
    if (!held.rows[0].acquired) return;
    const state = await repo.get(client, 'system', 'mes-poll');
    if (state && Date.now() - state.value.at < 5000) return;
    await withAdapters(client, repo, directory, contracts, adapters => adapters.invoke(adapters.plant, '/api/plant/mes/sync', {}));
    await repo.put(client, 'system', 'mes-poll', { at: Date.now() });
  });
}
