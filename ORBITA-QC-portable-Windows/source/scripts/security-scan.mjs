import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const git = (...args) => spawnSync('git', args, { encoding: 'utf8', cwd: process.cwd() })
const rootResult = git('rev-parse', '--show-toplevel')
if (rootResult.status !== 0) throw new Error('Не удалось определить корень Git')
const root = rootResult.stdout.trim()
const trackedResult = git('-C', root, 'ls-files')
if (trackedResult.status !== 0) throw new Error('Не удалось получить список файлов Git')
const tracked = trackedResult.stdout.split(/\r?\n/).filter(Boolean)
const forbiddenNames = tracked.filter(file => /(^|\/)(root\.key|\.env(?:\..*)?|server\.lock)$/i.test(file) || /(^|\/)data\//i.test(file))
if (forbiddenNames.length) throw new Error(`В Git обнаружены runtime-секреты или данные:\n${forbiddenNames.join('\n')}`)

const textExtensions = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.md', '.yml', '.yaml', '.cmd', '.ps1'])
const privateKeys = []
for (const relative of tracked) {
  if (!textExtensions.has(path.extname(relative).toLowerCase())) continue
  let content
  try { content = await readFile(path.join(root, relative), 'utf8') }
  catch (error) { if (error.code === 'ENOENT') continue; throw error }
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content)) privateKeys.push(relative)
}
if (privateKeys.length) throw new Error(`В Git обнаружен приватный ключ:\n${privateKeys.join('\n')}`)
console.log(`Security scan: ${tracked.length} tracked files, runtime data and private keys are absent.`)
