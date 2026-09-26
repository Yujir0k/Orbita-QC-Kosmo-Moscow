import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const contractFiles = {
  event: 'production-event.schema.json',
  delivery: 'delivery.schema.json',
  decision: 'quality-decision.schema.json',
  integration: 'integration-exchange.schema.json',
  mobileops: 'mobileops.schema.json',
}
const contractLabels = {
  event: ['Производственное событие', 'Единая оболочка событий истории изделия'],
  delivery: ['Доставка', 'Время приёма и передаваемое производственное событие'],
  decision: ['Решение контролёра', 'Автор, основание, решение и связь с исходными событиями'],
  integration: ['ERP/MES-обмен', 'Задания, результаты качества, пакеты и квитанции шлюзов'],
  mobileops: ['MobileOps', 'Задание комплекса, наблюдение, связь и результат доставки'],
}
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor'])
const fail = (status, message) => Object.assign(new Error(message), { status })
const object = value => !!value && typeof value === 'object' && !Array.isArray(value)
const pointer = (document, fragment = '') => {
  if (!fragment || fragment === '#') return document
  if (!fragment.startsWith('#/')) throw new Error(`Unsupported JSON pointer: ${fragment}`)
  return fragment.slice(2).split('/').reduce((value, token) => value?.[token.replace(/~1/g, '/').replace(/~0/g, '~')], document)
}
const valueType = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'number' && Number.isInteger(value) ? 'integer' : typeof value

function checkJsonShape(root, { maxDepth = 32, maxKeys = 10_000 } = {}) {
  const stack = [{ value: root, depth: 0 }]
  let keys = 0
  while (stack.length) {
    const { value, depth } = stack.pop()
    if (depth > maxDepth) return `JSON exceeds nesting limit ${maxDepth}`
    if (!value || typeof value !== 'object') continue
    const entries = Object.entries(value)
    keys += entries.length
    if (keys > maxKeys) return `JSON exceeds key limit ${maxKeys}`
    for (const [key, child] of entries) {
      if (forbiddenKeys.has(key)) return `Forbidden JSON key: ${key}`
      stack.push({ value: child, depth: depth + 1 })
    }
  }
  return null
}

export async function readJsonObject(request, { maxBytes = 65_536 } = {}) {
  if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) throw fail(415, 'Требуется application/json')
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > maxBytes) throw fail(413, `Запрос превышает ${Math.floor(maxBytes / 1024)} КБ`)
    chunks.push(chunk)
  }
  let value
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }
  catch { throw fail(400, 'Некорректный JSON') }
  if (!object(value)) throw fail(400, 'Ожидается объект JSON')
  const unsafe = checkJsonShape(value)
  if (unsafe) throw fail(400, `Небезопасная структура JSON: ${unsafe}`)
  return value
}

export async function createContractRegistry(directory) {
  const root = path.join(directory, 'contracts')
  const schemas = new Map()
  const loadedAt = new Date().toISOString()
  const fileToName = new Map(Object.entries(contractFiles).map(([name, file]) => [file, name]))
  for (const [name, file] of Object.entries(contractFiles)) {
    const schema = JSON.parse(await readFile(path.join(root, file), 'utf8'))
    if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema' || typeof schema.$id !== 'string' || !schema.$id.startsWith('https://orbita.local/contracts/')) throw new Error(`Invalid contract header: ${file}`)
    schemas.set(name, schema)
  }

  const resolve = (ref, currentName) => {
    const [targetFile, fragment = ''] = ref.split('#')
    const targetName = targetFile ? fileToName.get(targetFile) : currentName
    if (!targetName || !schemas.has(targetName)) throw new Error(`External or unknown contract reference: ${ref}`)
    const schema = pointer(schemas.get(targetName), fragment ? `#${fragment}` : '')
    if (!schema) throw new Error(`Unresolved contract reference: ${ref}`)
    return { schema, name: targetName }
  }

  const seenSchemas = new Set()
  const inspect = (schema, name) => {
    if (!schema || typeof schema !== 'object' || seenSchemas.has(schema)) return
    seenSchemas.add(schema)
    if (schema.$ref) resolve(schema.$ref, name)
    if (schema.pattern) new RegExp(schema.pattern)
    for (const value of Object.values(schema)) {
      if (Array.isArray(value)) for (const child of value) inspect(child, name)
      else inspect(value, name)
    }
  }
  for (const [name, schema] of schemas) inspect(schema, name)

  const validateNode = (schema, value, currentName, at, activeRefs = new Set()) => {
    if (schema.$ref) {
      const key = `${currentName}:${schema.$ref}:${at}`
      if (activeRefs.has(key)) return []
      const target = resolve(schema.$ref, currentName)
      return validateNode(target.schema, value, target.name, at, new Set([...activeRefs, key]))
    }
    const errors = []
    const add = message => errors.push(`${at}: ${message}`)
    if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) add(`must equal ${JSON.stringify(schema.const)}`)
    if (schema.enum && !schema.enum.some(entry => JSON.stringify(entry) === JSON.stringify(value))) add('value is outside enum')
    if (schema.allOf) for (const child of schema.allOf) errors.push(...validateNode(child, value, currentName, at, activeRefs))
    if (schema.anyOf && !schema.anyOf.some(child => !validateNode(child, value, currentName, at, activeRefs).length)) add('must match at least one variant')
    if (schema.oneOf) {
      const matches = schema.oneOf.filter(child => !validateNode(child, value, currentName, at, activeRefs).length).length
      if (matches !== 1) add(`must match exactly one variant; matched ${matches}`)
    }
    if (schema.type) {
      const allowed = Array.isArray(schema.type) ? schema.type : [schema.type]
      const actual = valueType(value)
      const accepted = allowed.includes(actual) || (actual === 'integer' && allowed.includes('number'))
      if (!accepted) { add(`expected ${allowed.join('|')}, got ${actual}`); return errors }
    }
    if (typeof value === 'string') {
      if (schema.minLength !== undefined && value.length < schema.minLength) add(`length must be >= ${schema.minLength}`)
      if (schema.maxLength !== undefined && value.length > schema.maxLength) add(`length must be <= ${schema.maxLength}`)
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) add('does not match pattern')
      if (schema.format === 'date-time' && (!/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(Date.parse(value)))) add('must be an ISO date-time')
    }
    if (typeof value === 'number') {
      if (schema.minimum !== undefined && value < schema.minimum) add(`must be >= ${schema.minimum}`)
      if (schema.maximum !== undefined && value > schema.maximum) add(`must be <= ${schema.maximum}`)
    }
    if (Array.isArray(value)) {
      if (schema.minItems !== undefined && value.length < schema.minItems) add(`must contain at least ${schema.minItems} items`)
      if (schema.maxItems !== undefined && value.length > schema.maxItems) add(`must contain at most ${schema.maxItems} items`)
      if (schema.uniqueItems && new Set(value.map(entry => JSON.stringify(entry))).size !== value.length) add('items must be unique')
      if (schema.items) value.forEach((entry, index) => errors.push(...validateNode(schema.items, entry, currentName, `${at}/${index}`, activeRefs)))
    }
    if (object(value)) {
      if (schema.maxProperties !== undefined && Object.keys(value).length > schema.maxProperties) add(`must contain at most ${schema.maxProperties} properties`)
      for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) errors.push(`${at}/${key}: required property is missing`)
      for (const [key, entry] of Object.entries(value)) {
        const child = schema.properties?.[key]
        if (child) errors.push(...validateNode(child, entry, currentName, `${at}/${key}`, activeRefs))
        else if (schema.additionalProperties === false) errors.push(`${at}/${key}: additional property is not allowed`)
        else if (object(schema.additionalProperties)) errors.push(...validateNode(schema.additionalProperties, entry, currentName, `${at}/${key}`, activeRefs))
      }
    }
    return errors
  }

  const schemaAt = (name, fragment) => {
    if (!schemas.has(name)) throw new Error(`Unknown contract: ${name}`)
    const schema = pointer(schemas.get(name), fragment)
    if (!schema) throw new Error(`Unknown contract fragment: ${name}${fragment}`)
    return schema
  }
  const validate = (name, value, fragment = '') => {
    const unsafe = checkJsonShape(value)
    if (unsafe) return [`$: ${unsafe}`]
    return validateNode(schemaAt(name, fragment), value, name, '$').slice(0, 20)
  }
  const assert = (name, value, fragment = '', message = 'Сообщение не соответствует контракту') => {
    const errors = validate(name, value, fragment)
    if (errors.length) throw fail(422, `${message}: ${errors[0]}`)
    return value
  }
  const describe = () => ({
    status: 'loaded',
    draft: '2020-12',
    loadedAt,
    count: schemas.size,
    policies: {
      remoteReferences: false,
      rejectUnknownFields: true,
      maxDepth: 32,
      maxKeys: 10_000,
      forbiddenKeys: [...forbiddenKeys],
    },
    schemas: [...schemas.entries()].map(([name, schema]) => ({
      name,
      file: contractFiles[name],
      label: contractLabels[name][0],
      purpose: contractLabels[name][1],
      id: schema.$id,
      title: schema.title,
      draft: schema.$schema,
      fingerprint: createHash('sha256').update(JSON.stringify(schema)).digest('hex'),
    })),
  })
  return { files: { ...contractFiles }, validate, assert, describe }
}
