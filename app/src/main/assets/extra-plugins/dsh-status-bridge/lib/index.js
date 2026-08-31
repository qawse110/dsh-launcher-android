/**
 * dsh-status-bridge — dsh runtime → Android launcher 桥接插件。
 *
 * 监听宿主 session/event，把 dsh 运行状态（idle/running/finished）和最近
 * AI 输出片段通过本地 HTTP 暴露给 Android 悬浮窗/通知服务。
 *
 * 默认端口 3190，可用环境变量 DSH_STATUS_BRIDGE_PORT 覆盖。
 */
import { createServer } from 'node:http'

export const name = 'dsh-status-bridge'

const PORT = Number(process.env.DSH_STATUS_BRIDGE_PORT || 3190)
// /status 对本机任意有 INTERNET 权限的 app 可读（loopback 无 per-app 访问控制），
// lastText 只保留悬浮窗/TTS 实际用到的长度（气泡 ≤40 字、full 模式 ≤160 字、
// TTS 整句增量播报需要更长上下文），不暴露全文
const LAST_TEXT_CAP = 2000 // 有界防泄露，同时覆盖长正文朗读（≈10 分钟中文语音）
const cap = (s) => String(s ?? '').slice(0, LAST_TEXT_CAP)

let server = null
let state = {
  status: 'idle',
  sessionId: null,
  lastText: '',
  lastEvent: null,
  updatedAt: 0,
}
// 当前 step 的流式文本累积（仅 text-delta，不含 reasoning/tool-call）：
// dsh 的 assistant/message 整条组装完成后才发射一次，1s 轮询几乎必然错过它；
// 监听 assistant/chunk 让 lastText 随生成实时增长，Android 端据此按句朗读。
let streamBuf = ''

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
      streamBuf = ''
      break
    case 'user/message':
      state.status = 'running'
      break
    case 'assistant/chunk': {
      // 流式增量：text-delta 逐段累积成实时 lastText，供桌宠生成中按句朗读；
      // reasoning-delta（链式思考）与 tool-call-delta 不朗读不外放。
      const chunk = event.data?.chunk
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
        streamBuf += chunk.text
        state.lastText = cap(streamBuf)
      } else if (chunk?.type === 'block' && chunk.block?.type === 'text' && typeof chunk.block.text === 'string') {
        streamBuf += chunk.block.text
        state.lastText = cap(streamBuf)
      }
      break
    }
    case 'assistant/message':
      state.status = 'running'
      const text = textFromMessage(event.data?.message)
      if (text) state.lastText = cap(text)
      streamBuf = '' // 本条消息已完成：累积缓冲作废，下一 step 重新累积
      break
    case 'turn/end': {
      // 失败识别：agent-loop 失败时 turn/end 仍会发出，但 reason.kind === "error"
      // （正常 completed / 中断 aborted / 截断 max-tokens）。上报 failed，
      // Android 悬浮窗据此显示失败动画并 TTS 提醒。
      const kind = event.data?.reason?.kind
      if (kind === 'error') {
        state.status = 'failed'
        const msg = event.data?.reason?.error?.message
        if (msg) state.lastText = cap(`出错：${msg}`)
      } else {
        state.status = 'finished'
      }
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
    'Access-Control-Allow-Origin': '*',
  })
  res.end(body)
}

// 单飞合成服务：监听失败（如重启瞬间的端口竞争）按 3s 退避重试至多 60s，
// 并由守卫定时器周期性自愈；成功后经 globalThis 跨热重载复用。
function ensureServer(attempt = 0) {
  const g = globalThis
  if (g.__dshStatusBridgeServer?.listening) { server = g.__dshStatusBridgeServer; return }
  const s = createServer((req, res) => {
    const url = (req.url || '/').split('?')[0]
    if (url === '/' || url === '/status') {
      sendJson(res, state)
    } else if (url === '/health') {
      sendJson(res, { ok: true, port: PORT })
    } else {
      sendJson(res, { error: 'not found' }, 404)
    }
  })
  s.on('error', (err) => {
    console.error('[dsh-status-bridge] server error', err?.code || err?.message || err)
    if (g.__dshStatusBridgeServer === s) g.__dshStatusBridgeServer = null
    if (attempt < 20) setTimeout(() => ensureServer(attempt + 1), 3000)
  })
  s.listen(PORT, '127.0.0.1', () => {
    g.__dshStatusBridgeServer = s
    console.log('[dsh-status-bridge] listening on http://127.0.0.1:' + PORT)
  })
  server = s
}

// 守卫：任何原因导致的掉线都会在 ≤15s 内被重新拉起
setInterval(() => {
  const g = globalThis
  if (!g.__dshStatusBridgeServer?.listening) {
    console.warn('[dsh-status-bridge] guard: server down, restarting')
    ensureServer(0)
  }
}, 15000).unref?.()

export function apply(ctx) {
  const onEvent = (session, event) => {
    try {
      updateState(session, event)
    } catch (e) {
      console.error('[dsh-status-bridge] updateState error', e?.message || e)
    }
  }
  ctx.on('session/event', onEvent)
  ensureServer()
  return {
    dispose() {
      // server 常驻进程生命周期内可用；热重载时经 globalThis 单例由新实例接管，
      // 本实例只解绑事件订阅，不关端口。
    },
  }
}