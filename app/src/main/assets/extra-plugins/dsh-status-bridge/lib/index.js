/**
 * dsh-status-bridge — dsh runtime → Android launcher 状态桥接插件。
 *
 * 监听宿主 session/event，把 dsh 运行状态（idle/running/finished/failed）与最近
 * AI 输出片段通过本地 HTTP 暴露给 Android 悬浮窗/通知服务。
 *
 * ── 端点 ─────────────────────────────────────────────────────────────
 *   GET /            别名，同 /status
 *   GET /status      状态 JSON（**需要 token**，见下）
 *   GET /health      运维探针：{ok, port}，**不需要 token**，只回常量、不泄漏状态
 *
 * ── 鉴权（v0.1.2 起）─────────────────────────────────────────────────
 * 回环地址在 Android 上**没有 per-app 访问控制**：任何持有 INTERNET 权限的 app
 * 都能直连 127.0.0.1。旧版既无鉴权、又回 `Access-Control-Allow-Origin: *`，
 * 等于把最近一段 AI 正文对「任意网页上下文」开放（dsh 自己的 WebView 就是其一）。
 * 现在：
 *   · 每次启动生成随机 token，写入 <HOME>/status-bridge.json（0600）；
 *   · /status 必须带 ?token=… 或 X-Dsh-Bridge-Token 头，否则 401；
 *   · **不再回 CORS 头**（消费方是原生 HttpURLConnection，本就不需要 CORS）。
 * 该文件同时是**端口与 token 的单一真源**：Kotlin 侧读它，而不是各自硬编码 3190。
 *
 * ── 实时文本：走 llm/stream，不走 session 事件 ──────────────────────
 * 旧版监听 `assistant/chunk` 以求「随生成实时增长 lastText」——该事件在
 * dsh 0.1.7-rc.2 上**不存在**：宿主权威事件表
 * `@deepseek-ai/dsh-session/lib/types/known-event-types.js` 共 56 项、
 * 含 "chunk" 的为 0；session 的 surface 也只折叠**已完成**消息
 * （SURFACE_EVENT_TYPES 六类里没有进行中的正文）。
 *
 * 真正可用的入口是 **LLM 层的 waterfall 钩子 `llm/stream`**（一等扩展点，
 * 不是 monkey-patch）：
 *   ```
 *   streamWithRegistration(options, prepared) {
 *     return this.ctx.waterfall(this, 'llm/stream', options, () => this.adapterStream(...))
 *   }
 *   ```
 * 本插件在 `apply()` 里挂 `ctx.on('llm/stream', …, { global: true })`，把
 * **主请求**（`isAgentLoopRequest(options)`，由 `@deepseek-ai/dsh-llm` 导出）
 * 返回的异步流包一层 tee：遇到 `{type:'text-delta', text}` 就累积进
 * `streamBuf` 并实时更新 `lastText`，于是 Android 端可以**按句增量朗读**。
 * `reasoning-delta` / `tool-call-delta` 不朗读、不外放。
 *
 * 过滤是两层：拿得到权威判据就用它；拿不到（动态 import 失败）则退化为
 * 「本会话处于 running 且 sessionId 一致」，避免把标题生成等辅助请求的
 * 文本混进 lastText。`assistant/message` 仍是**最终**正文的权威来源。
 */
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'dsh-status-bridge'

const HOME = process.env.HOME || process.env.DSH_HOME || ''
const PORT = Number(process.env.DSH_STATUS_BRIDGE_PORT || 3190)
/** 端口 + token 的单一真源，供 Kotlin 侧读取（同一 app 私有目录）。 */
export const CONTRACT_FILE = HOME ? join(HOME, 'status-bridge.json') : null
/** 每次启动轮换；Kotlin 每轮读 contract 文件，因此重启后自动跟上。 */
const TOKEN = randomBytes(24).toString('base64url')
/**
 * lastText 上限。旧值 2000（≈10 分钟中文语音）远超消费方所需：
 * 悬浮窗气泡 ≤40 字、full 模式 ≤160 字。这里收到 600 字（≈2 分钟语音），
 * 既覆盖一条消息的完整播报，又不至于把整段正文挂在无鉴权历史上。
 */
const LAST_TEXT_CAP = 600
const cap = (s) => String(s ?? '').slice(0, LAST_TEXT_CAP)

// 状态放 globalThis 单例：HTTP 处理器与事件订阅可能分属新旧两次热重载的模块实例，
// 若各自持有私有 state，会出现「新实例收事件、旧实例服务 HTTP」导致 /status 冻结。
const state = globalThis.__dshStatusBridgeState ?? (globalThis.__dshStatusBridgeState = {
  status: 'idle',
  sessionId: null,
  lastText: '',
  lastError: null,
  lastEvent: null,
  /** 是否正处于「逐段生成中」（由 llm/stream 的 text-delta 驱动）。 */
  streaming: false,
  updatedAt: 0,
})

/** 当前 step 的流式文本累积（仅 text-delta，不含 reasoning / tool-call）。 */
let streamBuf = ''

/**
 * `@deepseek-ai/dsh-llm` 导出的权威判据（WeakSet 成员判断），用来区分
 * 「agent-loop 的主请求」与标题生成之类的辅助请求。**动态 import**：
 * 解析不到时不能把插件整个搞挂，退化为保守判据即可。
 */
let isAgentLoopRequest = null

/**
 * 把 LLM 流包一层 tee：只旁听 `text-delta`，把文本实时写进 state。
 *
 * 返回的仍是**异步可迭代**（宿主以 `for await (const chunk of stream)` 消费），
 * 因此必须同时实现 `Symbol.asyncIterator` / `next` / `return` / `throw`，
 * 并原样透传每个 chunk —— 我们只是观察者，绝不改变流的语义。
 */
function teeTextDeltas(stream) {
  const iterator = stream[Symbol.asyncIterator]()
  const observe = (chunk) => {
    if (!chunk || typeof chunk !== 'object') return
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      streamBuf += chunk.text
      state.lastText = cap(streamBuf)
      state.streaming = true
      state.updatedAt = Date.now()
    } else if (chunk.type === 'finish') {
      state.streaming = false
      state.updatedAt = Date.now()
    }
    // reasoning-delta / tool-call-delta / block-* 一律不朗读、不外放。
  }
  return {
    [Symbol.asyncIterator]() { return this },
    async next() {
      const r = await iterator.next()
      if (!r.done) { try { observe(r.value) } catch (e) { /* 观察失败不影响流 */ } }
      return r
    },
    async return(value) {
      state.streaming = false
      return typeof iterator.return === 'function' ? iterator.return(value) : { done: true, value }
    },
    async throw(error) {
      state.streaming = false
      if (typeof iterator.throw === 'function') return iterator.throw(error)
      throw error
    },
  }
}

function textFromMessage(message) {
  if (!message || !message.content) return ''
  if (typeof message.content === 'string') return message.content
  if (Array.isArray(message.content)) {
    return message.content
      .filter((block) => block && block.type === 'text')
      .map((block) => block.text || '')
      .join('')
  }
  return ''
}

function updateState(session, event) {
  state.updatedAt = Date.now()
  state.sessionId = session?.id ?? session ?? null
  state.lastEvent = event?.type ?? null
  switch (event?.type) {
    case 'turn/start':
      state.status = 'running'
      state.lastText = ''
      state.lastError = null
      state.streaming = false
      streamBuf = ''
      break
    case 'user/message':
      state.status = 'running'
      break
    case 'assistant/message': {
      // 每个 step 一条（事件自带 data.turn/data.step）。这是本部署**唯一**能拿到
      // 助手正文的服务端事件，因此 lastText 的粒度就是「一条 assistant 消息」。
      state.status = 'running'
      const text = textFromMessage(event.data?.message)
      if (text) state.lastText = cap(text)
      break
    }
    case 'turn/end': {
      // 失败识别：agent-loop 失败时 turn/end 仍会发出，但 reason.kind === "error"
      // （正常 completed / 中断 aborted / 截断 max-tokens）。上报 failed，
      // Android 悬浮窗据此显示失败动画并 TTS 提醒。
      const kind = event.data?.reason?.kind
      if (kind === 'error') {
        state.status = 'failed'
        // 错误与正文**分开存**：旧版把 lastText 覆盖成「出错：…」，
        // 会把失败前已生成、且用户可能正等着看的正文丢掉。现在 lastText 保持不动，
        // 错误进 lastError 独立字段。
        state.lastError = cap(event.data?.reason?.error?.message || 'error')
      } else {
        state.status = 'finished'
        state.lastError = null
      }
      state.streaming = false
      break
    }
    default:
      break
  }
}

function sendJson(res, payload, statusCode = 200) {
  const body = JSON.stringify(payload)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

const tokenOk = (req, url) => {
  if (req.headers['x-dsh-bridge-token'] === TOKEN) return true
  const q = url.indexOf('?')
  if (q === -1) return false
  for (const pair of url.slice(q + 1).split('&')) {
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    if (decodeURIComponent(pair.slice(0, eq)) === 'token'
      && decodeURIComponent(pair.slice(eq + 1)) === TOKEN) return true
  }
  return false
}

function writeContract() {
  if (!CONTRACT_FILE) return
  try {
    writeFileSync(CONTRACT_FILE, JSON.stringify({ port: PORT, token: TOKEN }) + '\n', { mode: 0o600 })
  } catch (e) {
    console.error('[dsh-status-bridge] cannot write contract file', e?.message || e)
  }
}

/**
 * 启动 HTTP 服务。**单一重试入口**：用一个在途标记合并「error 重试」与
 * 「守卫定时器」两条路径，避免并发反复 createServer（旧版两条路径无互斥，
 * 端口被占时会短时间建/弃大量 server 对象并刷屏）。
 */
const RETRY_LIMIT = 20
let inFlight = false
function ensureServer(attempt = 0) {
  const g = globalThis
  if (inFlight) return
  inFlight = true
  try {
    // 热重载后旧实例的处理器闭包仍持有旧私有 state（已冻结不再更新），
    // 新实例必须关掉旧 server 并重建，否则 /status 数据永不刷新。
    if (g.__dshStatusBridgeServer?.listening) {
      try { g.__dshStatusBridgeServer.close() } catch (_) { /* best effort */ }
      g.__dshStatusBridgeServer = null
    }
    const s = createServer((req, res) => {
      const raw = req.url || '/'
      const url = raw.split('#')[0]
      const path = url.split('?')[0]
      if (path === '/health') {
        // 运维探针：不需要 token，且**只回常量**，不泄漏状态。
        sendJson(res, { ok: true, port: PORT })
        return
      }
      if (path === '/' || path === '/status') {
        if (!tokenOk(req, url)) {
          sendJson(res, { error: 'unauthorized' }, 401)
          return
        }
        sendJson(res, state)
        return
      }
      sendJson(res, { error: 'not found' }, 404)
    })
    s.on('error', (err) => {
      console.error('[dsh-status-bridge] server error', err?.code || err?.message || err)
      if (g.__dshStatusBridgeServer === s) g.__dshStatusBridgeServer = null
      inFlight = false
      if (attempt < RETRY_LIMIT) setTimeout(() => ensureServer(attempt + 1), 3000).unref?.()
    })
    s.listen(PORT, '127.0.0.1', () => {
      g.__dshStatusBridgeServer = s
      inFlight = false
      console.log('[dsh-status-bridge] listening on http://127.0.0.1:' + PORT + ' (token required)')
    })
  } catch (e) {
    inFlight = false
    console.error('[dsh-status-bridge] ensureServer failed', e?.message || e)
  }
}

export function apply(ctx) {
  const onEvent = (session, event) => {
    try {
      updateState(session, event)
    } catch (e) {
      console.error('[dsh-status-bridge] updateState error', e?.message || e)
    }
  }
  ctx.on('session/event', onEvent)

  // 流式正文：挂 LLM 层的 waterfall 钩子。**必须 global** —— 发起 LLM 调用的是
  // agent-loop，不是本插件，作用域不写 global 就收不到。
  import('@deepseek-ai/dsh-llm')
    .then((m) => {
      if (typeof m.isAgentLoopRequest === 'function') isAgentLoopRequest = m.isAgentLoopRequest
      else console.warn('[dsh-status-bridge] isAgentLoopRequest 不可用，流式改用保守判据')
    })
    .catch((e) => {
      console.warn('[dsh-status-bridge] 无法 import @deepseek-ai/dsh-llm，流式改用保守判据:', e?.message || e)
    })

  const onStream = (options, next) => {
    const stream = next()
    try {
      const isMain = isAgentLoopRequest !== null
        ? isAgentLoopRequest(options)
        // 拿不到权威判据时的保守判据：只在本会话 running 且 sessionId 一致时累积，
        // 免得把标题生成之类的辅助请求文本混进 lastText。
        : (state.status === 'running' && Boolean(options) && options.sessionId === state.sessionId)
      if (!isMain) return stream
      streamBuf = ''
      return teeTextDeltas(stream)
    } catch (e) {
      console.error('[dsh-status-bridge] llm/stream tee failed', e?.message || e)
      return stream
    }
  }
  ctx.on('llm/stream', onStream, { global: true })
  // 守卫：任何原因导致的掉线都会在 ≤15s 内被重新拉起。
  // ⚠ 必须建在 apply() 内、并在 dispose 时清掉：旧版把它放在**模块顶层**，
  //   等于「导入该模块」本身就具备起 HTTP 服务的副作用，且卸载后仍会把
  //   端口重新拉起（dispose 是空的）。
  const guard = setInterval(() => {
    const g = globalThis
    if (!g.__dshStatusBridgeServer?.listening) {
      console.warn('[dsh-status-bridge] guard: server down, restarting')
      ensureServer(0)
    }
  }, 15000)
  guard.unref?.()
  writeContract()
  ensureServer()

  return () => {
    // cordis 的 dispose 钩子：关端口 + 停守卫，卸载后不再监听 3190。
    try { clearInterval(guard) } catch (_) { /* best effort */ }
    const g = globalThis
    if (g.__dshStatusBridgeServer) {
      try { g.__dshStatusBridgeServer.close() } catch (_) { /* best effort */ }
      g.__dshStatusBridgeServer = null
    }
  }
}
