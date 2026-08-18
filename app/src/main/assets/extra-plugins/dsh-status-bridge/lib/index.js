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

let server = null
let state = {
  status: 'idle',
  sessionId: null,
  lastText: '',
  lastEvent: null,
  updatedAt: 0,
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
      break
    case 'user/message':
      state.status = 'running'
      break
    case 'assistant/message':
      state.status = 'running'
      const text = textFromMessage(event.data?.message)
      if (text) state.lastText = text
      break
    case 'turn/end':
      state.status = 'finished'
      break
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

function ensureServer() {
  if (server && server.listening) return
  server = createServer((req, res) => {
    const url = (req.url || '/').split('?')[0]
    if (url === '/' || url === '/status') {
      sendJson(res, state)
    } else if (url === '/health') {
      sendJson(res, { ok: true, port: PORT })
    } else {
      sendJson(res, { error: 'not found' }, 404)
    }
  })
  server.on('error', (err) => {
    console.error('[dsh-status-bridge] server error', err?.message || err)
  })
  server.listen(PORT, '127.0.0.1')
  console.log(`[dsh-status-bridge] listening on http://127.0.0.1:${PORT}`)
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
  ensureServer()
  return {
    dispose() {
      // 保持 server 常驻进程生命周期内可用；热重载时由新实例继续复用。
    },
  }
}