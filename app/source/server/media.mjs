import { digest } from './crypto.mjs';
import { fail } from './repository.mjs';

/** Store encrypted binary payloads in the independent media database; primary DB contains references only. */
export async function putMedia(client, crypto, { id, item, line, filename, bytes, contentType }) {
  if (bytes.length > 12 * 1024 * 1024) throw fail(413, 'Файл превышает 12 МиБ');
  const png = bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP';
  if (!(png && contentType === 'image/png' || jpeg && contentType === 'image/jpeg' || webp && contentType === 'image/webp')) throw fail(422, 'Формат изображения не соответствует содержимому');
  const hash = digest(bytes);
  const payload = crypto.seal({ data: bytes.toString('base64') }, `media:${id}`);
  const existing = await client.query('SELECT sha256 FROM media WHERE id=$1', [id]);
  if (existing.rows[0] && existing.rows[0].sha256 !== hash) throw fail(409, 'Материал уже существует с другим содержимым');
  await client.query('INSERT INTO media(id,item_id,line_id,filename,content_type,sha256,bytes,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING', [id,item,line,filename,contentType,hash,bytes.length,payload]);
  return { id, sha256: hash, bytes: bytes.length };
}

export async function getMedia(client, crypto, filename, lines) {
  const { rows } = await client.query('SELECT * FROM media WHERE filename=$1 AND line_id=ANY($2)', [filename, lines]);
  if (!rows[0]) throw fail(404, 'Материал не найден');
  const row = rows[0];
  const bytes = Buffer.from(crypto.open(row.payload, `media:${row.id}`).data, 'base64');
  if (digest(bytes) !== row.sha256) throw fail(503, 'Нарушена целостность материала');
  return { bytes, type: row.content_type, hash: row.sha256 };
}
