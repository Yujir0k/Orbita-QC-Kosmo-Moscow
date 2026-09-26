import { actionRoles as actions } from './contracts.generated.mjs';
import { randomUUID } from 'node:crypto';
import * as domain from './generated/domain.mjs';
import { digest } from './crypto.mjs';
import { lock } from './db.mjs';
import { fail } from './repository.mjs';

const initialMedia = structuredClone(domain.mediaIndex);
export const initialHistory = structuredClone(domain.deliveries);
domain.useAuthoritativeHistory([]);

/** The domain executes synchronously on a transaction snapshot; no browser event is trusted. */
export function createWorkflow(repo, crypto, contracts) {
  return async (client, user, input, key) => {
    if (!/^[a-zA-Z0-9-]{16,100}$/.test(key ?? '')) throw fail(422, 'Нужен Idempotency-Key длиной 16–100 символов');
    if (!actions[user.role]?.includes(input.action)) throw fail(403, 'Действие недоступно для роли');
    if (typeof input.reason !== 'string' || input.reason.trim().length < 5 || input.reason.length > 4000) throw fail(422, 'Укажите обоснование от 5 до 4000 символов');
    await lock(client, `command:${key}`);
    const requestHash = digest({ user: user.id, input });
    const previous = await client.query('SELECT actor,fingerprint,payload FROM commands WHERE id=$1', [key]);
    if (previous.rows[0]) {
      if (previous.rows[0].actor !== user.id || previous.rows[0].fingerprint !== requestHash) throw fail(409, 'Ключ команды уже использован с другими параметрами');
      return crypto.open(previous.rows[0].payload, `command:${key}`);
    }
    await lock(client, `item:${input.itemId}`);
    const history = await repo.history(client, { item: input.itemId });
    if (!history.length) throw fail(404, 'Изделие не найдено');
    if (history.some(row => !user.lineIds.includes(row.message.line_id))) throw fail(403, 'Линия недоступна');
    const revision = digest(history.map(row => row.message));
    if (input.expectedRevision !== revision) throw fail(409, 'История изменилась. Обновите карточку и повторите решение.');
    if (input.masterDetails?.assetId) {
      const asset = await repo.get(client, 'media-reference', input.masterDetails.assetId);
      if (!asset || asset.value.item_id !== input.itemId) throw fail(422, 'Фотография не относится к изделию');
    }
    const actionId = randomUUID();
    const approval = { actionId, actorId: user.id };
    const media = (await client.query("SELECT id,payload FROM documents WHERE namespace='media-reference'")).rows.map(row => crypto.open(row.payload, `document:media-reference:${row.id}`));
    domain.useMediaCatalog([...initialMedia, ...media]);
    domain.useAuthoritativeHistory(history);
    const selected = domain.cases.find(row => row.item === input.itemId && (input.caseId ? row.id === input.caseId : true));
    if (!selected) throw fail(422, 'Нужна карточка несоответствия');
    const last = history.filter(row => row.message.event_type === 'quality_decision').at(-1)?.message;
    if (['scrap','release'].includes(last?.data.disposition) && ['confirm','confirm_hold','quarantine','additional','reject','accepted_within_spec','release','scrap','master_complete','master_scrap'].includes(input.action)
      && !history.some(row => row.message.event_type === 'inspection_result' && row.message.occurred_at > last.occurred_at)) throw fail(409, 'Решение уже закрыто; требуется новое наблюдение');
    try {
      if (input.action === 'manual_measurement') {
        const m = input.measurement;
        domain.recordManualMeasurement(input.itemId, input.caseId, m.parameter, m.value, m.instrumentId, user.id, m.calibrated, m.criteria, approval);
      } else if (input.action === 'cause_review_detailed') domain.recordCauseReview({ ...input.details, caseId: input.caseId, reason: input.reason, actor: user.id }, approval);
      else if (input.action === 'master_process_report') domain.recordMasterProcessReport({ ...input.details, caseId: input.caseId, comment: input.reason, actor: user.id }, approval);
      else if (input.action === 'evidence_request') domain.requestInvestigationEvidence(input.caseId, input.recipient, input.reason, user.id, approval);
      else if (input.action === 'controller_check') domain.recordControllerCheck(input.itemId, input.caseId, input.checkResult, input.reason, user.id, input.identified, approval);
      else domain.performAction(input.itemId, user.role, input.action, input.reason.trim(), user.id, input.includePhoto ?? false, input.caseId, input.measurement, input.missingPhotoConfirmation, input.masterDetails, approval);
    } catch (error) { throw fail(422, error.message); }
    const generated = structuredClone(domain.actionDeliveries(actionId));
    const now = Date.now();
    for (const [i, row] of generated.entries()) {
      row.message.occurred_at = new Date(now + i).toISOString();
      row.deliver_at = row.message.occurred_at;
      contracts.assert('delivery', row);
      const outcome = await repo.ingest(client, row, domain.validateDelivery, { trusted: true, actor: user.id });
      if (outcome.kind === 'error') throw fail(422, outcome.reason);
      if (row.message.event_type === 'quality_decision') {
        await repo.queue(client, `qc:${row.message.event_id}`, input.itemId, 'erp', row.message);
        if (process.env.ORBITA_MES_BASE_URL) await repo.queue(client, `mes:${row.message.event_id}`, input.itemId, 'mes', row.message);
      }
    }
    await repo.append(client, `item:${input.itemId}`, { type: 'workflow.committed', actor: user.id, role: user.role, action: input.action, reason: input.reason, actionId, at: new Date().toISOString(), beforeRevision: revision, eventIds: generated.map(row => row.message.event_id) });
    const result = { actionId, actorId: user.id, role: user.role, deliveries: generated, result: generated.at(-1)?.message.event_id };
    await client.query('INSERT INTO commands(id,actor,fingerprint,payload) VALUES($1,$2,$3,$4)', [key, user.id, requestHash, crypto.seal(result, `command:${key}`)]);
    return result;
  };
}

export { domain };
