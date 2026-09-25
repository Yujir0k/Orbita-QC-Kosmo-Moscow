import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  inspectionPlan: config.inspectionPlan,
  profiles: config.profiles,
};
await writeFile(path.join(source, 'src/demo-data.json'), JSON.stringify(data));
const publicMedia = path.join(source, 'public/media');
await mkdir(publicMedia, { recursive: true });
for (const asset of data.media) await copyFile(path.join(quality, asset.path_from_quality_dataset), path.join(publicMedia, path.basename(asset.path_from_quality_dataset)));
const demo = path.join(source, 'public/demo');
await mkdir(demo, { recursive: true });
await copyFile(path.join(dataset, 'events/source_deliveries.jsonl'), path.join(demo, 'source_deliveries.jsonl'));
await copyFile(path.join(dataset, 'events/ingest_stream.jsonl'), path.join(demo, 'ingest_stream.jsonl'));
process.stdout.write(`Подготовлено ${data.items.length} изделий, ${data.source.length} внешних доставок и ${data.media.length} фото. Решения людей не импортированы.\n`);
