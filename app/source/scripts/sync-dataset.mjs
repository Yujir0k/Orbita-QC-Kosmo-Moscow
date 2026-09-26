import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { technologistFixtures } from './technologist-fixtures.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quality = path.resolve(source, '../../quality_dataset');
const dataset = path.join(quality, 'expanded_dataset');
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const readJsonl = async file => (await readFile(file, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
const config = await readJson(path.join(source, 'src/config.json'));
const data = {
  items: await readJson(path.join(dataset, 'items.json')),
  catalogs: await readJson(path.join(dataset, 'catalogs.json')),
  media: await readJson(path.join(dataset, 'media_index.json')),
  source: await readJsonl(path.join(dataset, 'events/source_deliveries.jsonl')),
  seedDecisions: (await readJsonl(path.join(dataset, 'events/deliveries.jsonl')))
    .filter(row => ['ITEM-004', 'ITEM-007', 'ITEM-028'].includes(row.message.item_id)
      && row.message.event_type === 'quality_decision'
      && row.message.data.decision === 'confirmed')
    .filter((row, index, rows) => rows.findIndex(other => other.message.item_id === row.message.item_id) === index),
  inspectionPlan: config.inspectionPlan,
  profiles: config.profiles,
};
const technicalContext = technologistFixtures(data.source, data.seedDecisions);
data.contextDeliveries = technicalContext.rows;
data.technicalCatalog = technicalContext.catalog;
await writeFile(path.join(source, 'src/demo-data.json'), JSON.stringify(data));
const publicMedia = path.join(source, 'public/media');
await mkdir(publicMedia, { recursive: true });
for (const asset of data.media) await copyFile(path.join(quality, asset.path_from_quality_dataset), path.join(publicMedia, path.basename(asset.path_from_quality_dataset)));
const demo = path.join(source, 'public/demo');
await mkdir(demo, { recursive: true });
await copyFile(path.join(dataset, 'events/source_deliveries.jsonl'), path.join(demo, 'source_deliveries.jsonl'));
await copyFile(path.join(dataset, 'events/ingest_stream.jsonl'), path.join(demo, 'ingest_stream.jsonl'));
await writeFile(path.join(demo, 'technologist_context.jsonl'), technicalContext.rows.map(row => JSON.stringify(row)).join('\n') + '\n');
await writeFile(path.join(source, 'src/integrity-manifest.json'), JSON.stringify(Object.fromEntries([...data.source, ...data.contextDeliveries, ...data.seedDecisions].map(row => [row.delivery_id, createHash('sha256').update(JSON.stringify(row.message)).digest('hex')]))));
process.stdout.write(`Подготовлено ${data.items.length} изделий, ${data.source.length} внешних доставок, ${data.seedDecisions.length} исторических решений ОТК и ${data.media.length} фото.\n`);
