import { createServer as createHttpServer } from 'node:http'
import { createReadStream, statSync } from 'node:fs'
import { extname, normalize, resolve as resolvePath, sep } from 'node:path'

// ----------------------------------------------------------------------
// Minimal zero-dependency HTTP layer for slop-review. Replaces hono +
// @hono/node-server while preserving the slice of API the route handlers
// already use:
//   - createApp().get/post/put/patch/delete/use(pattern, handler)
//   - ctx.req.param(name) / ctx.req.query(name) / ctx.req.json()
//   - ctx.json(body, status?) / ctx.text(body, status?) / ctx.header(k, v)
//   - stream(ctx, async (s) => …) for SSE, with s.write + s.onAbort
//   - serveStatic({ root, rewriteRequestPath }) middleware
//   - serve({ app, port, hostname }, onListen)
// Single-user local-machine app; no auth, CORS, or compression knobs.
// ----------------------------------------------------------------------

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map':  'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.ico':  'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.txt':  'text/plain; charset=utf-8',
}

// Compile a hono-ish path pattern (`/api/repos/:id/threads/:thread_id`,
// `/*`) into a regex + the ordered list of `:param` names. We deliberately
// don't support `*` mid-path or regex constraints — the codebase only
// uses simple segments and a single `/*` catch-all.
function compilePath(pattern) {
  if (pattern === '/*' || pattern === '*') {
    return { regex: /^.*$/, paramNames: [] }
  }
  const paramNames = []
  const compiled = pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        paramNames.push(seg.slice(1))
        return '([^/]+)'
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('/')
  return { regex: new RegExp('^' + compiled + '$'), paramNames }
}

class Context {
  constructor(req, res, url, params) {
    this.rawReq = req
    this.rawRes = res
    this._url = url
    this._params = params
    this._headers = {}
    this.req = {
      param: (name) => this._params[name],
      query: (name) => this._url.searchParams.get(name),
      json: async () => {
        // Mirror hono's behavior: return parsed JSON; reject on parse
        // failure so callers can `.catch(() => ({}))`. Empty body is {}.
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        if (chunks.length === 0) return {}
        const buf = Buffer.concat(chunks).toString('utf8')
        if (!buf) return {}
        return JSON.parse(buf)
      },
    }
  }

  header(name, value) {
    this._headers[name] = value
  }

  _flushHeaders(status, contentType) {
    if (this.rawRes.headersSent) return
    this.rawRes.statusCode = status
    if (contentType && !this._headers['content-type'] && !this._headers['Content-Type']) {
      this.rawRes.setHeader('content-type', contentType)
    }
    for (const [k, v] of Object.entries(this._headers)) {
      this.rawRes.setHeader(k, v)
    }
  }

  // json/text return the context so route helpers can use the
  // `return { error: c.json(...) }` pattern (and check `if (error)`
  // afterwards) the way they did under hono, where `c.json` returned
  // a truthy Response object.
  json(body, status = 200) {
    if (this.rawRes.writableEnded) return this
    this._flushHeaders(status, 'application/json; charset=utf-8')
    this.rawRes.end(JSON.stringify(body))
    return this
  }

  text(body, status = 200) {
    if (this.rawRes.writableEnded) return this
    this._flushHeaders(status, 'text/plain; charset=utf-8')
    this.rawRes.end(body)
    return this
  }
}

export function createApp() {
  const routes = []
  const middlewares = []

  function add(method, pattern, handler) {
    const { regex, paramNames } = compilePath(pattern)
    routes.push({ method, regex, paramNames, handler })
  }

  return {
    get:    (p, h) => add('GET',    p, h),
    post:   (p, h) => add('POST',   p, h),
    put:    (p, h) => add('PUT',    p, h),
    patch:  (p, h) => add('PATCH',  p, h),
    delete: (p, h) => add('DELETE', p, h),
    use: (pattern, handler) => {
      const { regex } = compilePath(pattern)
      middlewares.push({ regex, handler })
    },
    handle: async (req, res) => {
      // The host part is irrelevant — we only need pathname + query.
      const url = new URL(req.url, 'http://localhost')
      const pathname = url.pathname

      for (const r of routes) {
        if (r.method !== req.method) continue
        const m = pathname.match(r.regex)
        if (!m) continue
        const params = {}
        r.paramNames.forEach((n, i) => {
          params[n] = decodeURIComponent(m[i + 1])
        })
        const ctx = new Context(req, res, url, params)
        try {
          await r.handler(ctx)
        } catch (e) {
          console.error('[slop-review] route handler threw:', e)
          if (!res.writableEnded) {
            try {
              ctx._flushHeaders(500, 'application/json; charset=utf-8')
              res.end(JSON.stringify({ error: e?.message || 'internal error' }))
            } catch {}
          }
        }
        return
      }

      // No route matched — fall through to middleware (e.g. static).
      for (const mw of middlewares) {
        if (!mw.regex.test(pathname)) continue
        const ctx = new Context(req, res, url, {})
        try {
          await mw.handler(ctx)
        } catch (e) {
          console.error('[slop-review] middleware threw:', e)
          if (!res.writableEnded) {
            try { res.statusCode = 500; res.end() } catch {}
          }
        }
        if (res.writableEnded) return
      }

      if (!res.writableEnded) {
        res.statusCode = 404
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: 'not found' }))
      }
    },
  }
}

/**
 * Static file serving middleware. `root` is resolved against process.cwd()
 * (matches the hono behavior the previous wiring relied on, where the
 * caller passes a path relative to cwd). `rewriteRequestPath` lets the
 * caller map URL paths (e.g. '/' → '/index.html') before lookup.
 *
 * Path traversal is prevented by resolving the candidate file and
 * verifying it stays within the resolved root.
 */
export function serveStatic({ root, rewriteRequestPath }) {
  const rootAbs = resolvePath(process.cwd(), root)
  return async (c) => {
    let urlPath = c._url.pathname
    if (rewriteRequestPath) urlPath = rewriteRequestPath(urlPath)
    const cleaned = normalize(urlPath).replace(/^[/\\]+/, '')
    if (cleaned.split(sep).some((s) => s === '..')) return
    const filePath = resolvePath(rootAbs, cleaned)
    if (filePath !== rootAbs && !filePath.startsWith(rootAbs + sep)) return

    let stat
    try {
      stat = statSync(filePath)
    } catch {
      return
    }
    if (!stat.isFile()) return

    const mime = MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream'
    c.rawRes.statusCode = 200
    c.rawRes.setHeader('content-type', mime)
    c.rawRes.setHeader('content-length', String(stat.size))
    await new Promise((resolveDone) => {
      const fileStream = createReadStream(filePath)
      fileStream.on('error', () => {
        if (!c.rawRes.writableEnded) {
          try { c.rawRes.statusCode = 500; c.rawRes.end() } catch {}
        }
        resolveDone()
      })
      c.rawRes.on('close', resolveDone)
      c.rawRes.on('finish', resolveDone)
      fileStream.pipe(c.rawRes)
    })
  }
}

/**
 * SSE helper. Mirrors hono/streaming's contract enough that the events
 * route can keep its existing shape:
 *   - `s.write(chunk)` returns a Promise that resolves once the chunk
 *     has been written (honoring backpressure via 'drain').
 *   - `s.onAbort(fn)` fires when the client disconnects.
 *   - The body is left open until `fn` returns; the route handler keeps
 *     the response alive with `await new Promise(() => {})`.
 *
 * Headers set via `c.header(...)` before calling `stream()` are flushed
 * here (Content-Type: text/event-stream, etc).
 */
export async function stream(c, fn) {
  const res = c.rawRes
  c._flushHeaders(200)
  if (typeof res.flushHeaders === 'function') res.flushHeaders()

  let aborted = false
  const abortHandlers = []
  const onClose = () => {
    if (aborted) return
    aborted = true
    for (const h of abortHandlers) {
      try { h() } catch (e) { console.error('[slop-review] SSE onAbort handler threw:', e) }
    }
  }
  c.rawReq.on('close', onClose)

  const s = {
    write: (chunk) => {
      if (aborted || res.writableEnded) return Promise.resolve()
      return new Promise((resolveWrite, rejectWrite) => {
        // The write callback fires once the chunk is flushed (including
        // when buffered under backpressure), giving callers natural
        // back-pressure handling without a separate 'drain' listener.
        res.write(chunk, (err) => {
          if (err) rejectWrite(err)
          else resolveWrite()
        })
      })
    },
    onAbort: (h) => { abortHandlers.push(h) },
  }

  try {
    await fn(s)
  } catch (e) {
    if (!aborted) console.error('[slop-review] SSE handler threw:', e)
  }
  if (!res.writableEnded) {
    try { res.end() } catch {}
  }
}

/**
 * Start an HTTP listener bound to `app.handle`. Calls `onListen` once
 * the socket is actually accepting connections, mirroring the hono shim.
 */
export function serve({ app, port = 0, hostname = '0.0.0.0' }, onListen) {
  const server = createHttpServer((req, res) => {
    app.handle(req, res)
  })
  server.listen(port, hostname, () => {
    const addr = server.address()
    onListen?.({ port: addr.port, address: addr.address })
  })
  return server
}
