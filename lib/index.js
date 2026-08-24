/**
 * @dsh-external/dsh-mobile-remote a��� Host half.
 *
 * ?��????????��?��????�� DSH???
 *  - ?????? HTTP ?????��??��???��????�� 0.0.0.0:3580??��???serve ?��???? PWA ��???�??��???????
 *  - PIN ����???? + Bearer token ??��??????token ?��?????????��??�C???????���訦���??��???
 *  - ??? DSH ??? apiProxy???sessions / respond / events.mux??��?????????????�C?????��????????��???????
 *    ????��?��?? Web GUI ????����?????�??�� /api ??��?��??????????client-request / server-response??��???
 *  - ??�� DSH ??? webServer ?????��??? loopback ?????? /dsh-mobile-remote/panel*???
 *    ????����??��??? Web GUI ��????????????????�C����??????��??? / ?���訦���??��?��????Origin ??����??��?? CSRF??��?�?
 *
 * ��???��C��?��????��??��?????�̨C???node:http / node:crypto ????��??����??�� + @deepseek-ai/schemastery ����??????��?�?
 */
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { createSecureContext, TLSSocket } from 'node:tls'
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, appendFileSync } from 'node:fs'
import { gzipSync, createGzip } from 'node:zlib'
import { dirname, join } from 'node:path'
import { homedir, networkInterfaces } from 'node:os'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-mobile-remote'

export const inject = ['apiProxy']

/** ?��???????????��??����??? apiProxy ?�C??????????????????�?��????��?????session ????������?�� + ?��??��?????�C??????��?�? */
const ALLOWED_METHODS = new Set([
  'session.list',
  'session.search',
  'session.create',
  'session.history',
  'session.models',
  'session.selectModel',
  'session.rename',
  'session.fork',
  'session.prompt',
  'session.attachment',
  'session.updateQueue',
  'session.cancel',
])

/** ????��?��?? client-connection ??�??��????��?????�C????????��?????????�?????��??????settings/credentials/host.* ?-��??��?�? */
const PRIVILEGED_METHODS = new Set([
  'agentPreset.read',
  'agentPreset.copy',
  'agentPreset.openDocument',
  'agentPreset.remove',
  'host.pickDirectory',
  'host.openPath',
  'settings.describe',
  'settings.openDocument',
  'settings.update',
  'settings.replace',
  'settings.mutate',
  'credentials.describe',
  'credentials.set',
  'credentials.unset',
  'llm.discoverModels',
])

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex')
const secureEqual = (a, b) => {
  const ba = Buffer.from(String(a), 'hex')
  const bb = Buffer.from(String(b), 'hex')
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

/**
 * ????????????????????��??�?????��??��??��????��??�?
 *  - lan????��???��???10/8?�?172.16/12?�?192.168/16??��?-��?���?????��??��??�
 *  - tailscale???100.64.0.0/10???Tailscale CGNAT ??��??��??��a���a��� ?��??????��?��C??��?????????����?
 * @returns {{lan: string[], tailscale: string[]}} ?????��??��??? http URL ??��?����
 */
function networkUrls(port) {
  const lan = []
  const tailscale = []
  try {
    for (const addrs of Object.values(networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (a.family !== 'IPv4' || a.internal) continue
        const parts = a.address.split('.').map(Number)
        const first = parts[0]
        const url = `http://${a.address}:${port}`
        if (first === 100 && parts[1] !== void 0 && (parts[1] & 0x40) === 0x40) {
          // 100.64.0.0/10???Tailscale ????????��??��
          tailscale.push(url)
        } else if (first === 10 || (first === 172 && parts[1] >= 16 && parts[1] <= 31) || (first === 192 && parts[1] === 168)) {
          lan.push(url)
        } else {
          // ?��???�C��????��?????��??�???????��???��?????��?��? lan ?��??��?
          lan.push(url)
        }
      }
    }
  } catch { /* ???????���?��?????????��?????? */ }
  if (lan.length === 0 && tailscale.length === 0) lan.push(`http://127.0.0.1:${port}`)
  return { lan, tailscale }
}

/** ?������?��????????��??�???lan + tailscale??��?�? */
function allUrls(port) {
  const n = networkUrls(port)
  return [...n.lan, ...n.tailscale]
}

function loadAssets() {
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'assets')
  const files = {}
  try {
    for (const f of readdirSync(dir)) {
      const data = readFileSync(join(dir, f))
      files[f] = { data, type: MIME[extnameOf(f)] ?? 'application/octet-stream' }
    }
  } catch (err) {
    return { files, error: String(err) }
  }
  return { files, error: null }
}
const extnameOf = (f) => {
  const i = f.lastIndexOf('.')
  return i < 0 ? '' : f.slice(i).toLowerCase()
}

/** ?????��????????|?????�� gzip????��?????��?����??��???? JSON ?????? 10-20 ?�?????���??��???���???��?�? */
function acceptsGzip(req) {
  const ae = req.headers['accept-encoding']
  return typeof ae === 'string' && /\bgzip\b/.test(ae)
}

function sendJson(res, status, body, req) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  if (req && acceptsGzip(req) && payload.length > 512) {
    const gz = gzipSync(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-encoding': 'gzip',
      'content-length': String(gz.length),
      'vary': 'accept-encoding',
    })
    res.end(gz)
    return
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
  })
  res.end(payload)
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (c) => {
      total += c.length
      if (total > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export function apply(ctx, config) {
  const cfg = config ?? {}
  const port = cfg.port ?? 3580
  const host = cfg.host ?? '0.0.0.0'
  const pinLifetimeMs = cfg.pinLifetimeMs ?? 10 * 60 * 1000
  const maxPinAttempts = cfg.maxPinAttempts ?? 5
  const lockoutMs = cfg.lockoutMs ?? 5 * 60 * 1000

  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const stateDir = join(dshHome, 'plugins', 'dsh-mobile-remote')
  const stateFile = join(stateDir, 'state.json')

  // a���a��� ??��???????�? a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���
  /** @type {{pin: string, pinExpiresAt: number, pinAttempts: number, lockedUntil: number}} */
  let pinState = { pin: '', pinExpiresAt: 0, pinAttempts: 0, lockedUntil: 0 }
  /** @type {Map<string, number>} hash a?�� createdAt */
  let tokens = new Map()
  let dirty = false

  const loadState = () => {
    try {
      const raw = JSON.parse(readFileSync(stateFile, 'utf8'))
      if (raw && typeof raw.tokens === 'object' && raw.tokens !== null) {
        tokens = new Map(Object.entries(raw.tokens).map(([h, v]) => [h, Number(v)]))
      }
    } catch { /* ?��?????�??�C???? = ��|�C??��????��? */ }
  }
  const persist = () => {
    if (!dirty) return
    try {
      mkdirSync(stateDir, { recursive: true })
      writeFileSync(stateFile, JSON.stringify({
        tokens: Object.fromEntries(tokens.entries()),
      }))
      dirty = false
    } catch (err) {
      ctx.logger?.warn?.('dsh-mobile-remote: 状态持久化失败: %s', String(err))
    }
  }
  const rotatePin = () => {
    const pin = String(randomInt(0, 1000000)).padStart(6, '0')
    pinState = { pin, pinExpiresAt: Date.now() + pinLifetimeMs, pinAttempts: 0, lockedUntil: 0 }
    return pin
  }
  const revokeAllTokens = () => {
    tokens.clear()
    dirty = true
    persist()
    return rotatePin()
  }
  const issueToken = () => {
    const token = randomBytes(32).toString('hex')
    tokens.set(sha256(token), Date.now())
    dirty = true
    persist()
    return token
  }
  const verifyToken = (value) => {
    if (typeof value !== 'string') return false
    // ?????�� "Bearer <token>" ??�C??? token???EventSource query ????????��
    const m = /^Bearer\s+([A-Za-z0-9_-]+)$/.exec(value.trim())
    const raw = m ? m[1] : value.trim()
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(raw)) return false
    const hash = sha256(raw)
    return tokens.has(hash)
  }
  const tokenCount = () => tokens.size
  const pinInfo = () => ({
    pin: pinState.pin,
    pinExpiresAt: pinState.pinExpiresAt,
    pinLifetimeMs,
    lockedUntil: pinState.lockedUntil,
  })

  const pairingStatus = () => {
    const nets = networkUrls(port)
    return {
      enabled: serverState.ready,
      version: '0.1.0',
      urls: [...nets.lan, ...nets.tailscale],
      tailscaleUrls: nets.tailscale,
      port,
      ...pinInfo(),
      tokenCount: tokenCount(),
      error: serverState.error,
    }
  }

  loadState()
  if (!pinState.pin) rotatePin()

  // a���a��� ��???�??��???? a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���
  const assets = loadAssets()

  // a���a��� ?????��??��????�????????????��??? a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���
  const serverState = { ready: false, starting: false, error: null }
  let listenRetries = 0
  let retryTimer = null
  const MAX_LISTEN_RETRIES = 6
  const startServer = () => {
    if (serverState.ready || serverState.starting) return
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
    serverState.starting = true
    serverState.error = null
    try {
      netServer.listen(port, host)
    } catch (err) {
      serverState.starting = false
      serverState.error = String(err)
      ctx.logger?.error?.('dsh-mobile-remote: 启动手机服务器失败: %s', String(err))
    }
  }
  const stopServer = () => {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
    if (!serverState.ready && !serverState.starting) return
    serverState.starting = false
    try { netServer.closeAllConnections?.() } catch { /* ?��??????? */ }
    try { netServer.close() } catch { /* ?????��??? */ }
  }

  // a���a��� API ?��???? a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���
  const api = ctx.apiProxy

  async function handleUnary(req, res, method) {
    let body
    try {
      body = await readBody(req, 64 * 1024 * 1024)
    } catch {
      sendJson(res, 413, { error: 'body-too-large' }, req)
      return
    }
    let envelope
    try {
      envelope = JSON.parse(body.toString('utf8'))
    } catch {
      sendJson(res, 400, { error: 'invalid-json' }, req)
      return
    }
    if (!envelope || envelope.type !== 'client-request' ||
        typeof envelope.rpcId !== 'string' || envelope.method !== method ||
        typeof envelope.payload !== 'object' || envelope.payload === null) {
      sendJson(res, 400, { error: 'invalid-envelope' }, req)
      return
    }
    let result
    try {
      const raw = await routeInvoke(method, { rpcId: envelope.rpcId, payload: envelope.payload })
      // host ??? api.sessions.* ??��??? { rpcId, result: { ok, value|error } }????��???�� result ?��?
      result = raw && typeof raw === 'object' && raw.result !== void 0 ? raw.result : raw
    } catch (err) {
      ctx.logger?.warn?.('dsh-mobile-remote: %s 调用失败: %s', method, String(err))
      result = { ok: false, error: { code: 'internal', message: String(err), details: {} } }
    }
    sendJson(res, 200, { type: 'server-response', rpcId: envelope.rpcId, result }, req)
  }

  function routeInvoke(method, request) {
    switch (method) {
      case 'session.list': return api.sessions.list(request)
      case 'session.search': return api.sessions.search(request)
      case 'session.create': return api.sessions.create(request)
      case 'session.history': return api.sessions.history(request)
      case 'session.models': return api.sessions.models(request)
      case 'session.selectModel': return api.sessions.selectModel(request)
      case 'session.rename': return api.sessions.rename(request)
      case 'session.fork': return api.sessions.fork(request)
      case 'session.prompt': return api.sessions.prompt(request)
      case 'session.attachment': return api.sessions.attachment(request)
      case 'session.updateQueue': return api.sessions.updateQueue(request)
      case 'session.cancel': return api.sessions.cancel(request)
      default: throw new Error(`unmapped method ${method}`)
    }
  }

  async function handleRespond(req, res) {
    let body
    try {
      body = await readBody(req, 4 * 1024 * 1024)
    } catch {
      sendJson(res, 413, { error: 'body-too-large' }, req)
      return
    }
    let envelope
    try {
      envelope = JSON.parse(body.toString('utf8'))
    } catch {
      sendJson(res, 400, { error: 'invalid-json' }, req)
      return
    }
    if (!envelope || envelope.type !== 'client-response' ||
        typeof envelope.rpcId !== 'string' ||
        typeof envelope.result !== 'object' || envelope.result === null) {
      sendJson(res, 400, { error: 'invalid-envelope' }, req)
      return
    }
    try {
      const receipt = await api.respond(envelope)
      sendJson(res, 200, receipt, req)
    } catch (err) {
      ctx.logger?.warn?.('dsh-mobile-remote: respond 失败: %s', String(err))
      sendJson(res, 200, { accepted: false, reason: 'bad-response' }, req)
    }
  }

  /** SSE?????? apiProxy.events.mux / events.host ?????��?��??????��????��????????????�� server-request ??��??��?�? */
  function handleEventStream(req, res, kind) {
    const abort = new AbortController()
    res.on('close', () => abort.abort())
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write(': connected\n\n')
    const open = kind === 'mux'
      ? api.events.mux({ rpcId: randomBytes(16).toString('hex'), payload: {} }, abort.signal)
      : api.events.host({ rpcId: randomBytes(16).toString('hex'), payload: {} }, abort.signal)
    ;(async () => {
      for await (const frame of open) {
        const payload = frame && frame.payload ? frame.payload : {}
        res.write(`data: ${JSON.stringify({
          type: 'server-request',
          rpcId: frame.rpcId,
          method: payload.type,
          payload,
        })}\n\n`)
      }
    })().catch((err) => {
      if (!abort.signal.aborted) {
        ctx.logger?.warn?.('dsh-mobile-remote: 事件流中断: %s', String(err))
        try {
          res.write(`data: ${JSON.stringify({ type: 'server-request', rpcId: 'stream-error', method: 'stream/error', payload: { type: 'stream/error', error: { code: 'internal', message: String(err), details: {} } } })}\n\n`)
        } catch { /* ?????��????��??�C-??� */ }
      }
    }).finally(() => {
      try { res.end() } catch { /* ?��??�C-??� */ }
    })
  }

  // a���a��� HTTP ?????��??�� a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���
  const logAccess = (msg) => {
    try {
      mkdirSync(stateDir, { recursive: true })
      appendFileSync(join(stateDir, 'access.log'), new Date().toISOString() + ' ' + msg + '\n')
    } catch { /* ?��???��?���?��?��??��?? */ }
  }

  /** HTTP ??��?��??��??????��???????�C???? TLS ?��????????����?����??��?�? */
  const handleRequest = (req, res) => {
    const remoteAddr = req.socket?.remoteAddress ?? '?'
    logAccess(`REQ ${req.method} ${req.url ?? '/'} from ${remoteAddr}`)
    ctx.logger?.info?.('dsh-mobile-remote: 收到请求 %s %s 来自 %s', req.method, req.url ?? '/', remoteAddr)
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://dsh-mobile-remote.internal')
      const path = url.pathname
      try {
        // ����????
        if (path === '/pair' && req.method === 'POST') {
          let body
          try { body = await readBody(req, 4096) } catch { sendJson(res, 413, { ok: false, error: 'body-too-large' }, req); return }
          let parsed
          try { parsed = JSON.parse(body.toString('utf8')) } catch { sendJson(res, 400, { ok: false, error: 'invalid-json' }, req); return }
          const now = Date.now()
          if (pinState.lockedUntil > now) {
            sendJson(res, 429, { ok: false, error: 'locked', retryAfterMs: pinState.lockedUntil - now }, req)
            return
          }
          if (pinState.pinExpiresAt < now) rotatePin()
          if (String(parsed?.pin ?? '') !== pinState.pin) {
            pinState.pinAttempts += 1
            if (pinState.pinAttempts >= maxPinAttempts) {
              pinState.lockedUntil = now + lockoutMs
              sendJson(res, 429, { ok: false, error: 'locked', retryAfterMs: lockoutMs }, req)
            } else {
              sendJson(res, 403, { ok: false, error: 'bad-pin', attemptsLeft: maxPinAttempts - pinState.pinAttempts }, req)
            }
            return
          }
          pinState.pinAttempts = 0
          const token = issueToken()
          sendJson(res, 200, { ok: true, token, urls: allUrls(port) }, req)
          return
        }
        // ?���訦���????��???��?????��
        if (path === '/revoke' && req.method === 'POST') {
          if (!verifyToken(req.headers.authorization)) { sendJson(res, 401, { ok: false, error: 'unauthorized' }, req); return }
          const pin = revokeAllTokens()
          sendJson(res, 200, { ok: true, pin, pinExpiresAt: pinState.pinExpiresAt }, req)
          return
        }
        // ???????��????token ??? query ???�����a���a���EventSource ????��????????????�� header??��
        if ((path === '/api/events.mux' || path === '/api/events.host') && req.method === 'GET') {
          if (!verifyToken(url.searchParams.get('token') ?? '')) { sendJson(res, 401, { error: 'unauthorized' }, req); return }
          handleEventStream(req, res, path === '/api/events.mux' ? 'mux' : 'host')
          return
        }
        // respond
        if (path === '/api/respond' && req.method === 'POST') {
          if (!verifyToken(req.headers.authorization)) { sendJson(res, 401, { error: 'unauthorized' }, req); return }
          await handleRespond(req, res)
          return
        }
        // ??�??? method ?????��
        if (path.startsWith('/api/') && req.method === 'POST') {
          if (!verifyToken(req.headers.authorization)) { sendJson(res, 401, { error: 'unauthorized' }, req); return }
          const method = path.slice(5)
          if (!ALLOWED_METHODS.has(method) || PRIVILEGED_METHODS.has(method)) {
            sendJson(res, 403, { error: 'method-not-allowed', method }, req)
            return
          }
          await handleUnary(req, res, method)
          return
        }
        // ��???�??��????
        if (req.method === 'GET' || req.method === 'HEAD') {
          const file = path === '/' ? 'index.html' : path.slice(1)
          const entry = assets.files[file]
          if (!entry) { sendJson(res, 404, { error: 'not-found' }, req); return }
          res.writeHead(200, {
            'content-type': entry.type,
            'content-length': String(entry.data.length),
            'cache-control': 'no-cache',
          })
          res.end(req.method === 'HEAD' ? undefined : entry.data)
          return
        }
        sendJson(res, 405, { error: 'method-not-allowed' }, req)
      } catch (err) {
        ctx.logger?.warn?.('dsh-mobile-remote: 请求处理失败: %s', String(err))
        try { sendJson(res, 500, { error: 'internal' }, req) } catch { /* ?��???�����? */ }
      }
    })()
  }

  // a���a��� ??????????????��??��????????�???????????��?????? HTTP / HTTPS??��a���a���a���a���a���a���a���a���a���a���
  // ????-??????|?-???��???????���� HTTPS????��?????��??��???��?????? https ?��????????????��
  let secureContext = null
  try {
    const certPem = readFileSync(join(stateDir, 'cert.pem'))
    const keyPem = readFileSync(join(stateDir, 'key.pem'))
    if (certPem && keyPem) secureContext = createSecureContext({ cert: certPem, key: keyPem })
  } catch { /* ?��??????|?????�� HTTP */ }

  const httpServer = createServer(handleRequest)
  const httpsServer = secureContext ? createServer(handleRequest) : null

  // ????�C-???socket ?��???��?????��????????????"??��?????��??��"???"http ?��?????���?��?"??��
  const logSocketData = (socket) => {
    const addr = socket.remoteAddress ?? '?'
    socket.on('data', (chunk) => {
      const head = chunk.subarray(0, 8).toString('hex')
      const asc = chunk.subarray(0, 8).toString('latin1').replace(/[^\x20-\x7e]/g, '.')
      logAccess(`SOCKDATA ${addr} ${chunk.length}B head=${head} ascii=${asc}`)
    })
  }
  httpServer.on('connection', logSocketData)
  if (httpsServer) {
    httpsServer.on('connection', (socket) => {
      socket.on('secureConnect', () => logAccess(`TLS-CONN ${socket.remoteAddress ?? '?'}`))
    })
  }

  // ???????����??????0x16 = TLS ??��?��? a?�� https?????|???????�C? a?�� http
  const netServer = createNetServer((socket) => {
    socket.on('error', () => { try { socket.destroy() } catch { /* ?��??��?����- */ } })
    socket.once('data', (buf) => {
      if (buf.length > 0 && buf[0] === 0x16 && httpsServer) {
        const tlsSock = new TLSSocket(socket, { isServer: true, secureContext })
        tlsSock.on('error', () => { try { socket.destroy() } catch { /* ?��??��?����- */ } })
        httpsServer.emit('connection', tlsSock)
      } else {
        socket.unshift(buf)
        httpServer.emit('connection', socket)
      }
    })
  })

  netServer.on('error', (err) => {
    serverState.starting = false
    serverState.error = String(err)
    ctx.logger?.error?.('dsh-mobile-remote: 手机服务器错误: %s', String(err))
    // EADDRINUSE????����??????/?????? socket ?-???����???��???????????��?????????����??????????��
    if (err?.code === 'EADDRINUSE' && listenRetries < MAX_LISTEN_RETRIES) {
      listenRetries += 1
      retryTimer = setTimeout(() => { retryTimer = null; startServer() }, 1200)
    }
  })
  netServer.on('close', () => {
    serverState.ready = false
  })

  // a���a��� ?����??��???��??????????????loopback + Origin ??����????��a���a���a���a���a���a���a���a���a���a���a���a���a���a���
  const isTrustedLocalRequest = (req) => {
    const host = req.headers.host
    const origin = req.headers.origin
    if (typeof host !== 'string' || typeof origin !== 'string') return false
    const hostname = host.split(':')[0].toLowerCase().replace(/^\[|\]$/g, '')
    if (!['127.0.0.1', 'localhost', '::1'].includes(hostname)) return false
    let o
    try { o = new URL(origin) } catch { return false }
    if (o.protocol !== 'http:' && o.protocol !== 'https:') return false
    return o.host === host
  }

  const panelHandler = async (req, res) => {
    if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST-only' }, req); return }
    if (!isTrustedLocalRequest(req)) { sendJson(res, 403, { error: 'forbidden' }, req); return }
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (path === '/dsh-mobile-remote/panel') {
      sendJson(res, 200, pairingStatus(), req)
      return
    }
    if (path === '/dsh-mobile-remote/panel/revoke') {
      const pin = revokeAllTokens()
      sendJson(res, 200, { ok: true, pin, pinExpiresAt: pinState.pinExpiresAt }, req)
      return
    }
    if (path === '/dsh-mobile-remote/panel/stop') {
      stopServer()
      sendJson(res, 200, { ok: true, enabled: false }, req)
      return
    }
    if (path === '/dsh-mobile-remote/panel/start') {
      startServer()
      sendJson(res, 200, { ok: true, enabled: serverState.ready || serverState.starting }, req)
      return
    }
    sendJson(res, 404, { error: 'not-found' }, req)
  }

  const ws = ctx.get('webServer')
  if (ws) {
    ctx.effect(() => ws.register({
      kind: 'prefix',
      path: '/dsh-mobile-remote/panel',
      handler: panelHandler,
    }), 'dsh-mobile-remote: panel routes')
  }

  // a���a��� ?��??��??����??? a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���a���
  ctx.effect(() => {
    startServer()
    return () => {
      // ?��????????�C-??�?������?��?????????????��?����-/??��?-??????????��???��? close ?????��?????????��???��? a?�� EADDRINUSE??��
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
      try { netServer.closeAllConnections?.() } catch { /* ?��??��?����- */ }
      try { netServer.close() } catch { /* ?��??��?����- */ }
      try { httpServer.closeAllConnections?.() } catch { /* ?��??��?����- */ }
      try { httpServer.close() } catch { /* ?��??��?����- */ }
      try { httpsServer?.closeAllConnections?.() } catch { /* ?��??��?����- */ }
      try { httpsServer?.close() } catch { /* ?��??��?����- */ }
    }
  }, 'dsh-mobile-remote: http server')

  netServer.once('listening', () => {
    serverState.ready = true
    serverState.starting = false
    serverState.error = null
    listenRetries = 0
    const actualPort = netServer.address()?.port ?? port
    const urls = allUrls(actualPort)
    ctx.logger?.info?.('dsh-mobile-remote: 手机远程已就绪 —— 手机浏览器打开 %s（配对 PIN: %s，%d 分钟内有效，%s）',
      urls.join(' 或 '), pinState.pin, Math.round(pinLifetimeMs / 60000),
      secureContext ? '已启用 HTTPS（浏览器强制 https 也可直连）' : '仅 HTTP（未找到证书）')
  })
}

