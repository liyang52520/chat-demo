/* oxlint-disable no-console -- 服务端需要在终端输出启动信息与错误 */
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const root = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.join(root, 'dist')
const authDir = path.resolve(process.env.CHAT_DEMO_AUTH_DIR ?? path.join(root, '.chat-demo-auth'))
const passwordFile = path.join(authDir, 'password.json')
const secretFile = path.join(authDir, 'secret')

const port = Number(process.env.PORT ?? 8090)
const host = process.env.CHAT_DEMO_HOST ?? '0.0.0.0'
/** 环境变量密码优先；为空时使用首次进入时设置并保存在服务端的密码 */
const envPassword = process.env.CHAT_DEMO_PASSWORD?.trim() ?? ''

const COOKIE = 'chat_demo_session'
const SESSION_MAX_AGE = 30 * 24 * 60 * 60
const MAX_BODY = 4 * 1024
const LOGIN_ATTEMPT_LIMIT = 5
const LOGIN_ATTEMPT_WINDOW = 10 * 60 * 1000

const scryptAsync = promisify(scrypt)

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

await mkdir(authDir, { recursive: true, mode: 0o700 })

const sessionSecret = await loadSessionSecret()

async function loadSessionSecret() {
  try {
    return Buffer.from((await readFile(secretFile, 'utf8')).trim(), 'base64url')
  } catch {
    const secret = randomBytes(32)
    await writeFile(secretFile, secret.toString('base64url'), { mode: 0o600 })
    return secret
  }
}

const loadStoredPassword = async () => {
  try {
    const stored = JSON.parse(await readFile(passwordFile, 'utf8'))
    return typeof stored?.salt === 'string' && typeof stored?.hash === 'string' ? stored : null
  } catch {
    return null
  }
}

const sha256 = (value) => createHash('sha256').update(value).digest()

const safeEqual = (a, b) => a.length === b.length && timingSafeEqual(a, b)

const verifyPassword = async (password) => {
  if (!password || password.length > 1024) {
    return false
  }
  if (envPassword) {
    return safeEqual(sha256(password), sha256(envPassword))
  }
  const stored = await loadStoredPassword()
  if (!stored) {
    return false
  }
  const hash = await scryptAsync(password, Buffer.from(stored.salt, 'base64'), 64)
  return safeEqual(hash, Buffer.from(stored.hash, 'base64'))
}

const createStoredPassword = async (password) => {
  const salt = randomBytes(16)
  const hash = await scryptAsync(password, salt, 64)
  const serialized = JSON.stringify({
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
  })
  const temporary = `${passwordFile}.tmp`
  await writeFile(temporary, serialized, { mode: 0o600 })
  await rename(temporary, passwordFile)
}

const signature = (payload) => createHmac('sha256', sessionSecret).update(payload).digest('base64url')

const createSession = () => {
  const expiresAt = String(Date.now() + SESSION_MAX_AGE * 1000)
  return `${expiresAt}.${signature(expiresAt)}`
}

const parseCookies = (header = '') => {
  const cookies = {}
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index > 0) {
      cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim()
    }
  }
  return cookies
}

const isAuthenticated = (req) => {
  const token = parseCookies(req.headers.cookie)[COOKIE]
  if (!token) {
    return false
  }
  const [expiresAt, value] = token.split('.')
  if (!expiresAt || !value) {
    return false
  }
  const expected = signature(expiresAt)
  if (!safeEqual(Buffer.from(value), Buffer.from(expected))) {
    return false
  }
  return Number(expiresAt) > Date.now()
}

const isSecureRequest = (req) =>
  Boolean(req.socket.encrypted) || req.headers['x-forwarded-proto'] === 'https'

const sessionCookie = (req, token) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}` +
  (isSecureRequest(req) ? '; Secure' : '')

const expiredCookie = `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`

const sendJson = (res, status, body, headers = {}) => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(JSON.stringify(body))
}

const redirect = (res, location) => {
  res.writeHead(302, { location, 'cache-control': 'no-store' })
  res.end()
}

const readJsonBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let tooLarge = false
    req.on('data', (chunk) => {
      if (tooLarge) {
        return
      }
      size += chunk.length
      if (size > MAX_BODY) {
        tooLarge = true
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) {
        reject(new Error('too-large'))
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('invalid-json'))
      }
    })
    req.on('error', reject)
  })

const attempts = new Map()

const clientAddress = (req) => req.socket.remoteAddress ?? 'unknown'

const allowLoginAttempt = (address) => {
  const now = Date.now()
  if (attempts.size > 1000) {
    for (const [key, entry] of attempts) {
      if (entry.resetAt < now) {
        attempts.delete(key)
      }
    }
  }
  const entry = attempts.get(address)
  if (!entry || entry.resetAt < now) {
    attempts.set(address, { count: 1, resetAt: now + LOGIN_ATTEMPT_WINDOW })
    return true
  }
  if (entry.count >= LOGIN_ATTEMPT_LIMIT) {
    return false
  }
  entry.count += 1
  return true
}

const resolveStaticPath = (pathname) => {
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes('\0')) {
    return null
  }
  const target = path.resolve(distDir, decoded === '/' ? 'index.html' : decoded.slice(1))
  return target === distDir || target.startsWith(`${distDir}${path.sep}`) ? target : null
}

const serveFile = async (res, filePath) => {
  const info = await stat(filePath).catch(() => null)
  if (!info?.isFile()) {
    return false
  }
  const immutable = /-[a-z0-9]{6,}\./.test(path.basename(filePath))
  res.writeHead(200, {
    'content-type': mimeTypes[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': immutable ? 'private, max-age=31536000, immutable' : 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  })
  createReadStream(filePath).pipe(res)
  return true
}

const loginTemplate = await readFile(path.join(root, 'server', 'login.html'), 'utf8')
const wordmark = await readFile(path.join(root, 'server', 'wordmark.svg'), 'utf8')
const loginPage = loginTemplate.replace('<!--WORDMARK-->', wordmark)

const handleAuthApi = async (req, res, pathname) => {
  if (pathname === '/api/auth/status' && req.method === 'GET') {
    const configured = Boolean(envPassword) || Boolean(await loadStoredPassword())
    sendJson(res, 200, { configured, authenticated: isAuthenticated(req) })
    return true
  }

  if (pathname === '/api/auth/setup' && req.method === 'POST') {
    if (envPassword || (await loadStoredPassword())) {
      sendJson(res, 409, { error: 'already-configured' })
      return true
    }
    let body
    try {
      body = await readJsonBody(req)
    } catch {
      sendJson(res, 400, { error: 'invalid-request' })
      return true
    }
    const password = typeof body?.password === 'string' ? body.password : ''
    if (!password.trim()) {
      sendJson(res, 400, { error: 'invalid-password' })
      return true
    }
    await createStoredPassword(password)
    res.setHeader('set-cookie', sessionCookie(req, createSession()))
    sendJson(res, 200, { ok: true })
    return true
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    if (!allowLoginAttempt(clientAddress(req))) {
      sendJson(res, 429, { error: 'too-many-attempts' }, { 'retry-after': '600' })
      return true
    }
    let body
    try {
      body = await readJsonBody(req)
    } catch {
      sendJson(res, 400, { error: 'invalid-request' })
      return true
    }
    const password = typeof body?.password === 'string' ? body.password : ''
    if (!(await verifyPassword(password))) {
      sendJson(res, 401, { error: 'invalid-password' })
      return true
    }
    attempts.delete(clientAddress(req))
    res.setHeader('set-cookie', sessionCookie(req, createSession()))
    sendJson(res, 200, { ok: true })
    return true
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    res.setHeader('set-cookie', expiredCookie)
    sendJson(res, 200, { ok: true })
    return true
  }

  return false
}

const handle = async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const pathname = url.pathname

  if (await handleAuthApi(req, res, pathname)) {
    return
  }

  if ((pathname === '/login' || pathname === '/login/') && req.method === 'GET') {
    if (isAuthenticated(req)) {
      redirect(res, '/')
      return
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
    })
    res.end(loginPage)
    return
  }

  // 登录页自带样式，favicon 无需鉴权；其余静态资源全部要求登录
  if (pathname === '/favicon.svg') {
    if (!(await serveFile(res, path.join(distDir, 'favicon.svg')))) {
      res.writeHead(404).end()
    }
    return
  }

  if (!isAuthenticated(req)) {
    if (req.method === 'GET' || req.method === 'HEAD') {
      redirect(res, '/login')
    } else {
      res.writeHead(401, { 'cache-control': 'no-store' }).end()
    }
    return
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end()
    return
  }

  const filePath = resolveStaticPath(pathname)
  if (!filePath || !(await serveFile(res, filePath))) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found')
  }
}

const server = createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error(error)
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('Internal error')
    } else {
      res.end()
    }
  })
})

server.listen(port, host, async () => {
  const stored = await loadStoredPassword()
  console.log(`chat-demo auth server listening on http://${host}:${port}`)
  console.log(
    envPassword
      ? 'password: from CHAT_DEMO_PASSWORD'
      : stored
        ? `password: stored in ${authDir}`
        : 'password: not set — the first visitor will set it'
  )
})
