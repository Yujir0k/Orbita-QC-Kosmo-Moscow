import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createAuditLog, createCrypto } from './security-crypto.mjs'

const json = (response, status, body) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  response.end(JSON.stringify(body))
}
const sha256 = value => createHash('sha256').update(value).digest('hex')
const safeName = value => value.replace(/[^a-zA-Z0-9_.-]/g, '_')

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1)
  return value >>> 0
})
const crc32 = value => {
  let crc = 0xffffffff
  for (const byte of value) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
const dosTime = date => ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((date.getSeconds() / 2) & 31)
const dosDate = date => (((Math.max(1980, date.getFullYear()) - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31)

function createStoredZip(entries) {
  const local = []
  const central = []
  let offset = 0
  const now = new Date()
  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/g, '/'))
    const data = Buffer.from(entry.data)
    const crc = crc32(data)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0, 6); header.writeUInt16LE(0, 8)
    header.writeUInt16LE(dosTime(now), 10); header.writeUInt16LE(dosDate(now), 12); header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26); header.writeUInt16LE(0, 28)
    local.push(header, name, data)
    const directory = Buffer.alloc(46)
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6)
    directory.writeUInt16LE(0, 8); directory.writeUInt16LE(0, 10); directory.writeUInt16LE(dosTime(now), 12); directory.writeUInt16LE(dosDate(now), 14)
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(name.length, 28)
    directory.writeUInt16LE(0, 30); directory.writeUInt16LE(0, 32); directory.writeUInt16LE(0, 34); directory.writeUInt16LE(0, 36); directory.writeUInt32LE(0, 38); directory.writeUInt32LE(offset, 42)
    central.push(directory, name)
    offset += header.length + name.length + data.length
  }
  const centralData = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralData.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20)
  return Buffer.concat([...local, centralData, end])
}

async function extractStoredZip(archive, destination) {
  let offset = 0
  while (offset + 4 <= archive.length && archive.readUInt32LE(offset) === 0x04034b50) {
    const method = archive.readUInt16LE(offset + 8)
    const expectedCrc = archive.readUInt32LE(offset + 14)
    const size = archive.readUInt32LE(offset + 18)
    const nameLength = archive.readUInt16LE(offset + 26)
    const extraLength = archive.readUInt16LE(offset + 28)
    if (method !== 0) throw new Error('Резервная копия использует неподдерживаемое сжатие')
    const nameStart = offset + 30
    const name = archive.subarray(nameStart, nameStart + nameLength).toString('utf8')
    if (!name || path.isAbsolute(name) || name.split('/').includes('..')) throw new Error('Небезопасный путь в резервной копии')
    const dataStart = nameStart + nameLength + extraLength
    const data = archive.subarray(dataStart, dataStart + size)
    if (data.length !== size || crc32(data) !== expectedCrc) throw new Error(`Повреждён файл ${name}`)
    const target = path.join(destination, ...name.split('/'))
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, data, { mode: 0o600 })
    offset = dataStart + size
  }
}

async function collectFiles(root, relative = '') {
  let entries
  try { entries = await readdir(path.join(root, relative), { withFileTypes: true }) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
  const result = []
  for (const entry of entries) {
    const child = path.join(relative, entry.name)
    if (!relative && ['backups', 'server.lock'].includes(entry.name)) continue
    if (child === path.join('security', 'key-rotation-backups') || child === path.join('security', 'rotation-in-progress.json')) continue
    if (entry.isDirectory()) result.push(...await collectFiles(root, child))
    else if (entry.isFile()) result.push(child)
  }
  return result
}

async function backupStatus(file) {
  try { return JSON.parse(await readFile(file, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

export async function createOperations({ directory, security, contracts, integration, plant, startedAt = new Date() }) {
  const dataDirectory = path.join(directory, 'data')
  const backupDirectory = path.join(dataDirectory, 'backups')
  const statusFile = path.join(backupDirectory, 'status.json')

  async function createBackup(actor = 'system') {
    await security.audit.verify()
    const backupId = randomUUID()
    const createdAt = new Date().toISOString()
    await security.audit.append({ type: 'backup.started', at: createdAt, actor, backupId })
    const files = await collectFiles(dataDirectory)
    const entries = []
    const manifestFiles = []
    for (const relative of files.sort()) {
      const data = await readFile(path.join(dataDirectory, relative))
      const name = `data/${relative.replace(/\\/g, '/')}`
      entries.push({ name, data })
      manifestFiles.push({ path: name, bytes: data.length, sha256: sha256(data) })
    }
    const manifest = { format: 'ORBITA-QC-backup/v1', backupId, createdAt, files: manifestFiles }
    entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) })
    const archive = createStoredZip(entries)
    await mkdir(backupDirectory, { recursive: true, mode: 0o700 })
    const filename = safeName(`orbita-backup-${createdAt.replace(/[:.]/g, '-')}-${backupId.slice(0, 8)}.zip`)
    const archivePath = path.join(backupDirectory, filename)
    await writeFile(archivePath, archive, { mode: 0o600, flag: 'wx' })
    const verified = await verifyBackup(archivePath)
    const result = { backupId, createdAt, filename, bytes: archive.length, files: manifestFiles.length, verifiedAt: verified.verifiedAt, sha256: sha256(archive) }
    await writeFile(statusFile, JSON.stringify(result, null, 2), { mode: 0o600 })
    await security.audit.append({ type: 'backup.verified', at: result.verifiedAt, actor, backupId, filename, files: result.files, sha256: result.sha256 })
    return result
  }

  async function verifyBackup(archivePath) {
    const archive = await readFile(archivePath)
    const temporary = await mkdtemp(path.join(tmpdir(), 'orbita-restore-check-'))
    try {
      await extractStoredZip(archive, temporary)
      const manifest = JSON.parse(await readFile(path.join(temporary, 'manifest.json'), 'utf8'))
      if (manifest.format !== 'ORBITA-QC-backup/v1' || !Array.isArray(manifest.files)) throw new Error('Некорректный манифест резервной копии')
      for (const entry of manifest.files) {
        const target = path.resolve(temporary, ...entry.path.split('/'))
        if (!target.startsWith(temporary + path.sep)) throw new Error('Манифест содержит небезопасный путь')
        const data = await readFile(target)
        if (data.length !== entry.bytes || sha256(data) !== entry.sha256) throw new Error(`Контрольная сумма не совпала: ${entry.path}`)
      }
      const restoredData = path.join(temporary, 'data')
      const restoredKey = await readFile(path.join(restoredData, 'security', 'root.key'))
      const restoredCrypto = createCrypto(restoredKey)
      await (await createAuditLog(path.join(restoredData, 'security', 'audit.jsonl'), restoredCrypto)).verify()
      for (const entry of manifest.files.filter(row => row.path.endsWith('.json'))) {
        const target = path.resolve(temporary, ...entry.path.split('/'))
        const value = JSON.parse(await readFile(target, 'utf8'))
        if (value?.profile === 'AES-256-GCM') restoredCrypto.openData(value, path.basename(target))
      }
      return { valid: true, files: manifest.files.length, verifiedAt: new Date().toISOString() }
    } finally { await rm(temporary, { recursive: true, force: true }) }
  }

  async function health() {
    const [audit, disk, files, lastBackup] = await Promise.all([
      security.audit.verify().catch(error => ({ valid: false, error: error.message })),
      statfs(directory).catch(() => null),
      collectFiles(dataDirectory),
      backupStatus(statusFile),
    ])
    let dataBytes = 0
    for (const file of files) dataBytes += (await stat(path.join(dataDirectory, file))).size
    const erp = integration.status()
    const production = plant.status()
    const sessions = security.sessionStatus()
    return {
      status: audit.valid ? 'ok' : 'degraded', checkedAt: new Date().toISOString(), startedAt: startedAt.toISOString(), uptimeSeconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
      process: { node: process.version, pid: process.pid, memoryBytes: process.memoryUsage().rss },
      storage: { dataBytes, files: files.length, freeBytes: disk ? Number(disk.bavail * disk.bsize) : null, totalBytes: disk ? Number(disk.blocks * disk.bsize) : null },
      audit, contracts: contracts.describe(), sessions,
      queues: {
        erp: { pending: erp.outbox.filter(row => row.status !== 'accepted').length, failed: erp.outbox.filter(row => row.status === 'failed').length, total: erp.outbox.length },
        mes: { pending: production.mes.outbox.filter(row => row.status !== 'accepted').length, failed: production.mes.outbox.filter(row => row.status === 'failed').length, total: production.mes.outbox.length },
      },
      components: {
        erp: { configured: erp.configured, mode: erp.mode, lastActivityAt: [...erp.orders.map(row => row.received_at), ...erp.outbox.map(row => row.updated_at ?? row.created_at)].filter(Boolean).sort().at(-1) ?? null },
        mes: { configured: production.mes.configured, lastError: production.mes.last_error, lastActivityAt: production.mes.deliveries.map(row => row.deliver_at).filter(Boolean).sort().at(-1) ?? null },
        cad: { configured: production.cad.configured, imports: production.cad.imports.length, lastActivityAt: production.cad.imports.map(row => row.imported_at).filter(Boolean).sort().at(-1) ?? null },
      },
      backup: lastBackup,
      crypto: security.cryptoStatus(),
    }
  }

  async function handle(request, response, pathname, principal) {
    try {
      if (pathname === '/api/operations/health' && request.method === 'GET') return json(response, 200, await health())
      if (pathname === '/api/operations/backups' && request.method === 'GET') return json(response, 200, { last: await backupStatus(statusFile) })
      if (pathname === '/api/operations/backups' && request.method === 'POST') return json(response, 201, await createBackup(principal.user.id))
      return json(response, 404, { error: 'Неизвестный эксплуатационный маршрут' })
    } catch (error) { return json(response, error.status ?? 503, { error: error.message ?? 'Эксплуатационная операция не выполнена' }) }
  }

  return { handle, health, createBackup, verifyBackup }
}
