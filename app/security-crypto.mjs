import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

const keySize = 32
const encode = bytes => Buffer.from(bytes).toString('base64url')
const decode = value => Buffer.from(value, 'base64url')
const same = (left, right) => {
  const a = Buffer.from(left), b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function loadRootKey(directory, provided) {
  if (provided) {
    const key = Buffer.from(provided)
    if (key.length !== keySize) throw new Error('Security root key must be 32 bytes')
    return key
  }
  if (process.env.ORBITA_SECURITY_KEY_HEX) {
    const value = process.env.ORBITA_SECURITY_KEY_HEX
    if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error('ORBITA_SECURITY_KEY_HEX must contain 64 hex digits')
    return Buffer.from(value, 'hex')
  }
  const file = process.env.ORBITA_SECURITY_KEY_FILE ?? path.join(directory, 'data', 'security', 'root.key')
  try {
    const key = await readFile(file)
    if (key.length !== keySize) throw new Error('Security key file must contain exactly 32 bytes')
    return key
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await mkdir(path.dirname(file), { recursive: true })
  const key = randomBytes(keySize)
  try {
    const handle = await open(file, 'wx', 0o600)
    try { await handle.writeFile(key); await handle.sync() } finally { await handle.close() }
    return key
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const existing = await readFile(file)
    if (existing.length !== keySize) throw new Error('Security key file must contain exactly 32 bytes')
    return existing
  }
}

export function createCrypto(rootKey) {
  const derive = label => Buffer.from(hkdfSync('sha256', rootKey, Buffer.from('ORBITA-QC/security/v1'), Buffer.from(label), keySize))
  const dataKey = derive('data/AES-256-GCM')
  const auditKey = derive('audit/AES-256-GCM')
  const chainKey = derive('audit/HMAC-SHA-256')
  const headKey = derive('audit/checkpoint')
  const authKey = derive('demo/accounts')
  const seal = (value, key, aad) => {
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(Buffer.from(aad))
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
    return { format: 1, profile: 'AES-256-GCM', key_id: 'local-v1', nonce: encode(nonce), ciphertext: encode(ciphertext), tag: encode(cipher.getAuthTag()) }
  }
  const openEnvelope = (envelope, key, aad) => {
    if (!envelope || envelope.format !== 1 || envelope.profile !== 'AES-256-GCM' || envelope.key_id !== 'local-v1') throw new Error('Unsupported encrypted record')
    const nonce = decode(envelope.nonce), tag = decode(envelope.tag)
    if (nonce.length !== 12 || tag.length !== 16) throw new Error('Invalid encrypted record')
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(tag)
    return JSON.parse(Buffer.concat([decipher.update(decode(envelope.ciphertext)), decipher.final()]).toString('utf8'))
  }
  const mac = (key, value) => encode(createHmac('sha256', key).update(value).digest())
  return {
    sealData: (value, name) => seal(value, dataKey, `state:${name}`),
    openData: (value, name) => openEnvelope(value, dataKey, `state:${name}`),
    sealAudit: (value, seq) => seal(value, auditKey, `audit:${seq}`),
    openAudit: (value, seq) => openEnvelope(value, auditKey, `audit:${seq}`),
    chainMac: value => mac(chainKey, value),
    headMac: value => mac(headKey, value),
    accountSecret: id => encode(createHmac('sha256', authKey).update(`demo-password:${id}`).digest()).slice(0, 22),
    constantTimeEqual: same,
  }
}

async function atomicWrite(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, value, { mode: 0o600 })
  await rename(temporary, file)
}

export function createEncryptedStore(crypto) {
  const queues = new Map()
  return {
    async readJson(file) {
      let value
      try { value = JSON.parse(await readFile(file, 'utf8')) }
      catch (error) { if (error.code === 'ENOENT') return null; throw error }
      if (value?.profile === 'AES-256-GCM') return crypto.openData(value, path.basename(file))
      // One-time migration of pre-security demo state; no silent fallback for a damaged envelope.
      await this.writeJson(file, value)
      return value
    },
    writeJson(file, value) {
      const snapshot = JSON.stringify(crypto.sealData(value, path.basename(file)))
      const pending = (queues.get(file) ?? Promise.resolve()).then(() => atomicWrite(file, snapshot))
      queues.set(file, pending)
      return pending
    },
  }
}

export async function createAuditLog(file, crypto) {
  const checkpoint = `${file}.head`
  let rows = []
  let head = { seq: 0, mac: '' }
  const readRows = async () => {
    let raw
    try { raw = await readFile(file, 'utf8') }
    catch (error) { if (error.code === 'ENOENT') raw = ''; else throw error }
    if (raw && !raw.endsWith('\n')) throw new Error('Audit log ends with a partial record')
    const result = []
    let previous = ''
    for (const line of raw.split('\n').filter(Boolean)) {
      const row = JSON.parse(line)
      const { mac, ...signed } = row
      if (row.seq !== result.length + 1 || row.prev !== previous || typeof mac !== 'string' || !crypto.constantTimeEqual(mac, crypto.chainMac(JSON.stringify(signed)))) throw new Error('Audit integrity check failed')
      const event = crypto.openAudit(row.payload, row.seq)
      result.push({ ...row, event }); previous = mac
    }
    let saved
    try { saved = JSON.parse(await readFile(checkpoint, 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') saved = null; else throw error }
    if (saved) {
      const { seal, ...checkpointValue } = saved
      if (typeof seal !== 'string' || !crypto.constantTimeEqual(seal, crypto.headMac(JSON.stringify(checkpointValue))) || saved.seq > result.length || (saved.seq === result.length && saved.mac !== previous)) throw new Error('Audit checkpoint integrity check failed')
    } else if (result.length) throw new Error('Audit checkpoint is missing')
    return { result, previous, saved }
  }
  const initial = await readRows()
  rows = initial.result
  head = { seq: rows.length, mac: initial.previous }
  if (initial.saved?.seq < head.seq) await atomicWrite(checkpoint, JSON.stringify({ ...head, seal: crypto.headMac(JSON.stringify(head)) }))
  let queue = Promise.resolve()
  const append = event => {
    const task = queue.then(async () => {
      const seq = head.seq + 1
      const signed = { seq, prev: head.mac, payload: crypto.sealAudit(event, seq) }
      const row = { ...signed, mac: crypto.chainMac(JSON.stringify(signed)) }
      await mkdir(path.dirname(file), { recursive: true })
      const handle = await open(file, 'a', 0o600)
      try { await handle.writeFile(`${JSON.stringify(row)}\n`); await handle.sync() } finally { await handle.close() }
      head = { seq, mac: row.mac }
      rows.push({ ...row, event })
      await atomicWrite(checkpoint, JSON.stringify({ ...head, seal: crypto.headMac(JSON.stringify(head)) }))
      return { seq, mac: row.mac }
    })
    queue = task
    return task
  }
  return {
    append,
    entries: () => rows.map(({ seq, prev, mac, event }) => ({ seq, prev, mac, event })),
    verify: async () => { await queue; const checked = await readRows(); return { valid: true, entries: checked.result.length, head: checked.previous } },
  }
}
