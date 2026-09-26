import http from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createIntegration } from './integration.mjs'
import { createPlantIntegrations } from './plant-integrations.mjs'
import { createSecurity } from './security.mjs'

const host = '127.0.0.1'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'site')
const directory = path.dirname(root)
const requestedPort = Number(process.env.ORBITA_PORT || 5173)

if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65525) {
  console.error('Invalid ORBITA_PORT. Use a number from 1 to 65525.')
  process.exit(1)
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

let port = requestedPort
const security = await createSecurity({ directory })
const integration = await createIntegration({ directory, getBaseUrl: () => `http://${host}:${port}`, storage: security.store, internalToken: security.internalToken })
const plant = await createPlantIntegrations({ directory, importAssembly: integration.importAssembly, storage: security.store, authorizeDecision: security.validateMesDecision })
const server = http.createServer(async (request, response) => {
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  let pathname
  try { pathname = decodeURIComponent(new URL(request.url, `http://${host}/`).pathname) }
  catch { response.writeHead(400).end('Bad request'); return }
  if (pathname.startsWith('/api/')) {
    if (await security.handle(request, response, pathname)) return
    try {
      const principal = await security.guard(request, response, pathname)
      if (!principal) return
      if (pathname.startsWith('/api/plant/')) await plant.handle(request, response, pathname, principal)
      else await integration.handle(request, response, pathname)
    } catch (error) {
      console.error('Security bus failure:', error)
      if (!response.headersSent) response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: 'Операция остановлена: проверка безопасности недоступна' }))
    }
    return
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end()
    return
  }

  let target = path.resolve(root, pathname.replace(/^[/\\]+/, '') || 'index.html')
  if (!target.startsWith(root + path.sep)) {
    response.writeHead(403).end('Forbidden')
    return
  }

  try {
    let info = await stat(target)
    if (info.isDirectory()) {
      target = path.join(target, 'index.html')
      info = await stat(target)
    }
    if (!info.isFile()) throw new Error('Not a file')
  } catch {
    if (!path.extname(pathname)) {
      target = path.join(root, 'index.html')
    } else {
      response.writeHead(404).end('Not found')
      return
    }
  }

  try {
    const data = await readFile(target)
    response.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    })
    response.end(request.method === 'HEAD' ? undefined : data)
  } catch (error) {
    console.error(error)
    response.writeHead(500).end('Server error')
  }
})

server.on('error', error => {
  if (error.code === 'EADDRINUSE' && port < requestedPort + 10) {
    port += 1
    server.listen(port, host)
    return
  }
  console.error(`Cannot start local server: ${error.message}`)
  process.exitCode = 1
})

server.listen(port, host, () => {
  const url = `http://${host}:${port}/`
  console.log(`ОРБИТА.QC запущена: ${url}`)
  console.log('Оставьте это окно открытым. Для остановки нажмите Ctrl+C.')
  console.log('Учебные учётные записи (пароли созданы локально и не входят в архив):')
  for (const account of security.demoCredentials()) console.log(`  ${account.id} [${account.role}]: ${account.password}`)
  if (process.env.ORBITA_NO_BROWSER !== '1') {
    try {
      const browser = spawn('explorer.exe', [url], { detached: true, stdio: 'ignore', windowsHide: true })
      browser.unref()
    } catch {
      console.log(`Откройте адрес в браузере: ${url}`)
    }
  }
})
