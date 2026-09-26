import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAuditLog, createCrypto } from '../../security-crypto.mjs'

const fingerprint = key => createHash('sha256').update(key).digest('hex').slice(0, 16)

async function activeServer(lockFile) {
  try {
    const lock = JSON.parse(await readFile(lockFile, 'utf8'))
    try { process.kill(lock.pid, 0); return lock }
    catch (error) { if (error.code === 'EPERM') return lock; if (error.code !== 'ESRCH') throw error }
    await rm(lockFile, { force: true })
    return null
  } catch (error) {
    if (error.code === 'ENOENT') return null
    try { await rm(lockFile, { force: true }) } catch {}
    return null
  }
}

async function encryptedFiles(root, relative = '') {
  let entries
  try { entries = await readdir(path.join(root, relative), { withFileTypes: true }) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
  const result = []
  for (const entry of entries) {
    const child = path.join(relative, entry.name)
    if (!relative && ['backups', 'server.lock'].includes(entry.name)) continue
    if (child.startsWith(`security${path.sep}`) || child === 'security') continue
    if (entry.isDirectory()) result.push(...await encryptedFiles(root, child))
    else if (entry.isFile() && entry.name.endsWith('.json')) {
      try {
        const value = JSON.parse(await readFile(path.join(root, child), 'utf8'))
        if (value?.profile === 'AES-256-GCM') result.push(child)
      } catch {}
    }
  }
  return result
}

export async function rotateKey(directory) {
  const dataDirectory = path.join(directory, 'data')
  const securityDirectory = path.join(dataDirectory, 'security')
  const lockFile = path.join(dataDirectory, 'server.lock')
  const lock = await activeServer(lockFile)
  if (lock) throw new Error(`Остановите сервер ОРБИТА.QC перед ротацией ключа (PID ${lock.pid})`)
  const keyFile = process.env.ORBITA_SECURITY_KEY_FILE ?? path.join(securityDirectory, 'root.key')
  const auditFile = path.join(securityDirectory, 'audit.jsonl')
  const headFile = `${auditFile}.head`
  const markerFile = path.join(securityDirectory, 'rotation-in-progress.json')
  const oldKey = await readFile(keyFile)
  if (oldKey.length !== 32) throw new Error('Текущий корневой ключ имеет неверный размер')
  const oldCrypto = createCrypto(oldKey)
  const oldAudit = await createAuditLog(auditFile, oldCrypto)
  await oldAudit.verify()
  const rotationId = randomUUID()
  const startedAt = new Date().toISOString()
  await oldAudit.append({ type: 'security.key_rotation.started', at: startedAt, actor: 'offline-cli', rotationId, previousFingerprint: fingerprint(oldKey) })
  const stateFiles = await encryptedFiles(dataDirectory)
  const decoded = []
  for (const relative of stateFiles) {
    const envelope = JSON.parse(await readFile(path.join(dataDirectory, relative), 'utf8'))
    decoded.push({ relative, value: oldCrypto.openData(envelope, path.basename(relative)) })
  }

  const newKey = randomBytes(32)
  const newCrypto = createCrypto(newKey)
  const stamp = startedAt.replace(/[:.]/g, '-')
  const recoveryDirectory = path.join(securityDirectory, 'key-rotation-backups', stamp)
  await mkdir(recoveryDirectory, { recursive: true, mode: 0o700 })
  await copyFile(keyFile, path.join(recoveryDirectory, 'root.key'))
  await copyFile(auditFile, path.join(recoveryDirectory, 'audit.jsonl'))
  await copyFile(headFile, path.join(recoveryDirectory, 'audit.jsonl.head'))
  for (const { relative } of decoded) {
    const target = path.join(recoveryDirectory, 'data', relative)
    await mkdir(path.dirname(target), { recursive: true })
    await copyFile(path.join(dataDirectory, relative), target)
  }
  await writeFile(markerFile, JSON.stringify({ rotationId, startedAt, recoveryDirectory }, null, 2), { mode: 0o600 })

  const temporaryAudit = path.join(securityDirectory, `audit.${rotationId}.new.jsonl`)
  const newAudit = await createAuditLog(temporaryAudit, newCrypto)
  for (const row of oldAudit.entries()) await newAudit.append(row.event)
  const completedAt = new Date().toISOString()
  await newAudit.append({ type: 'security.key_rotation.completed', at: completedAt, actor: 'offline-cli', rotationId, previousFingerprint: fingerprint(oldKey), fingerprint: fingerprint(newKey), stateFiles: decoded.length })
  await newAudit.verify()

  const replacements = []
  for (const entry of decoded) {
    const file = path.join(dataDirectory, entry.relative)
    const temporary = `${file}.${rotationId}.tmp`
    await writeFile(temporary, JSON.stringify(newCrypto.sealData(entry.value, path.basename(entry.relative))), { mode: 0o600 })
    replacements.push({ temporary, file })
  }
  const keyTemporary = `${keyFile}.${rotationId}.tmp`
  await writeFile(keyTemporary, newKey, { mode: 0o600 })
  for (const entry of replacements) await rename(entry.temporary, entry.file)
  await rename(temporaryAudit, auditFile)
  await rename(`${temporaryAudit}.head`, headFile)
  await rename(keyTemporary, keyFile)

  const checkAudit = await createAuditLog(auditFile, newCrypto)
  await checkAudit.verify()
  for (const entry of decoded) newCrypto.openData(JSON.parse(await readFile(path.join(dataDirectory, entry.relative), 'utf8')), path.basename(entry.relative))
  const result = { rotationId, startedAt, completedAt, previousFingerprint: fingerprint(oldKey), fingerprint: fingerprint(newKey), stateFiles: decoded.length, recoveryDirectory }
  await writeFile(path.join(securityDirectory, 'key-rotation.json'), JSON.stringify(result, null, 2), { mode: 0o600 })
  await rm(markerFile, { force: true })
  return result
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  if (!process.argv.includes('--confirm')) {
    console.error('Ротация перешифрует состояния и журнал. Остановите сервер и повторите команду с --confirm.')
    process.exitCode = 2
  } else {
    const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
    try {
      const result = await rotateKey(directory)
      console.log(`Ключ заменён и данные проверены. Новый отпечаток: ${result.fingerprint}. Учебные пароли изменились.`)
      console.log(`Копия для восстановления: ${result.recoveryDirectory}`)
    } catch (error) {
      console.error(`Ротация не выполнена: ${error.message}`)
      process.exitCode = 1
    }
  }
}
