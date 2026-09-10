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
// 状态放 globalThis 单例：HTTP 处理器与事件订阅可能分属新旧两次热重载的模块实例，
// 若各自持有私有 state，会出现「新实例收事件、旧实例服务 HTTP」导致 /status 冻结。
// 共享同一对象后，任一实例的 updateState 写入都能被服务端读到。
const state = globalThis.__dshStatusBridgeState ?? (globalThis.__dshStatusBridgeState = {
  status: 'idle',
  sessionId: null,
  lastText: '',
  lastEvent: null,
  updatedAt: 0,
  // 当前进行中的工具调用（tool/call → tool/result 配对）
  toolName: null,
  toolArgs: null,
  toolCallId: null,
  toolStartedAt: null,
  // 最近一次**已完成**的工具调用（含耗时与失败标记），供壳侧展示工具活动
  lastTool: null,
})
// 当前 step 的流式文本累积（仅 text-delta，不含 reasoning/tool-call）：
// dsh 的 assistant/message 整条组装完成后才发射一次，1s 轮询几乎必然错过它；
// 监听 assistant/chunk 让 lastText 随生成实时增长，Android 端据此按句朗读。
let streamBuf = ''

/**
 * 上报给壳侧的**语义事件白名单**。
 *
 * 真机缺陷（2026-09-10 实证）：原先 `lastEvent = event.type` 无条件透传每种事件，
 * 而 `assistant/chunk` 是 **token 级高频**事件（每个流式片段一次）。壳侧以 1s 轮询
 * 取 `/status`，于是流式阶段 lastEvent 恒为 `assistant/chunk`——而壳侧三个消费方
 * （StatusOverlay.statusLabel / PetSpeaker.speakForStatus / PetOverlayView.actionRowFor）
 * **都没有 assistant/chunk 分支**，全部落到退化 else。
 *
 * 实测影响（仿真复刻壳侧逻辑）：
 *   - 文案：流式阶段（一轮对话中占比最大）从「思考中」退化为「dsh 运行中」，
 *     语义事件的高亮被冲刷掉。
 *   - **不是** PetSpeaker 台词丢失的原因：那句「正在调用工具」被吞掉的真实根因在
 *     **壳侧**——PetSpeaker 把 `lastSpokenKey = key` 写在 4s 节流检查**之前**，
 *     被节流的事件会永久消费掉自己的键（已单独修复并实测）。
 *
 * 因此**只在语义事件上更新 lastEvent**；高频 chunk 仅用于累积 lastText（流式朗读），
 * 不改 lastEvent。白名单取值由 tools/check-plugin-contract.cjs 与壳侧分支交叉校验。
 */
const SEMANTIC_EVENTS = new Set([
  'turn/start',
  'user/message',
  'tool/call',
  'tool/result',
  'assistant/message',
  'turn/end',
])

/**
 * `turn/end` 的 `reason.kind` → 上报状态。
 *
 * **只有 `completed` 才是「完成」**——默认兜底为 finished 正是「用户取消任务却弹
 * 任务完成」的成因（真机实证）。kind 全集取自 dsh-session 的 `TurnEndReasonMap`
 * （本机 types.d.ts：completed | aborted | blocked | error | interrupted | max-tokens）。
 *
 * `max-tokens`（截断）与 `interrupted`（崩溃恢复时由持久化层补写的孤儿 turn）
 * 都**不是**成功完成，因此不映射为 finished：
 *   - max-tokens：输出被截断，需用户关注 → 复用 aborted 语义（已停止，未完成）；
 *   - interrupted：崩溃后的孤儿 turn，同样不是完成。
 * 由 tools/check-plugin-contract.cjs 校验「schema 每个 kind 都被覆盖」，漏配即失败。
 */
const TURN_END_STATUS = Object.freeze({
  completed: 'finished',
  aborted: 'aborted',
  blocked: 'blocked',
  interrupted: 'aborted',
  'max-tokens': 'aborted',
  error: 'failed',
})

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
  const type = event?.type
  state.updatedAt = Date.now()
  state.sessionId = session?.id ?? session ?? null
  // 只有语义事件才改写 lastEvent（见 SEMANTIC_EVENTS 注释：高频 chunk 会挤掉它）
  if (SEMANTIC_EVENTS.has(type)) state.lastEvent = type
  switch (type) {
    case 'turn/start':
      state.status = 'running'
      state.lastText = ''
      state.toolName = null
      state.toolArgs = null
      state.toolCallId = null
      state.toolStartedAt = null
      state.lastTool = null
      streamBuf = ''
      break
    case 'user/message':
      state.status = 'running'
      break
    case 'tool/call': {
      // 对齐参考项目的 tool_call 能力（其 .live.ndjson 记录 name/args/dur/err）：
      // 壳侧此前只能显示「调用工具」，看不到**哪个**工具、什么参数、跑了多久。
      const d = event.data ?? {}
      state.toolName = d.name ? String(d.name) : null
      state.toolArgs = d.arguments ? cap(String(d.arguments)) : null
      state.toolCallId = d.callId ? String(d.callId) : null
      state.toolStartedAt = state.updatedAt
      break
    }
    case 'tool/result': {
      const d = event.data ?? {}
      const dur = state.toolStartedAt ? state.updatedAt - state.toolStartedAt : null
      // 失败判定：schema 上 tool/result 的失败是顶层 `error:{name,code}`。
      // （参考项目改从 message.content[].isError 推断，与本机 schema 不符。）
      const err = d.error ? String(d.error.code ?? d.error.name ?? 'error') : null
      state.lastTool = {
        name: state.toolName,
        args: state.toolArgs,
        durationMs: dur,
        error: err,
      }
      // 保留 toolName：lastEvent 停在 tool/result 期间，壳侧据此显示「read_file 完成」。
      // 直到下一个工具调用或新一轮 turn/start 才清空。
      state.toolArgs = null
      state.toolCallId = null
      state.toolStartedAt = null
      break
    }
    case 'assistant/chunk': {
      // 流式增量：text-delta 逐段累积成实时 lastText，供桌宠生成中按句朗读；
      // reasoning-delta（链式思考）与 tool-call-delta 不朗读不外放。
      const chunk = event.data?.chunk
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
        streamBuf += chunk.text
        state.lastText = cap(streamBuf)
      } else if (chunk?.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.block.text === 'string') {
        // 修正死分支：StreamChunk 联合类型里是 'block-end'（本机 dsh-llm types 实测），
        // 旧代码写的 'block' 永不匹配，块式输出的文本会整段漏累积。
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
      // TurnEndReason.kind 全集（本机 dsh-session types 实测）：
      //   completed | aborted | blocked | error | interrupted | max-tokens
      //
      // 真机缺陷（2026-09-10 实证）：旧实现把「非 error」一律当 finished，于是
      // **用户主动取消（aborted）与被阻塞（blocked）也会弹「任务完成」通知 +
      // TTS「任务完成，太棒了！」**——取消任务不是完成任务。
      // 参考项目注明「被打断不弹」，但其代码读的是 `turn/end.outcome`，
      // 而 schema 里没有 outcome 字段（只有 reason）——属参考实现自身的缺陷，不可照抄。
      //
      // 用显式映射表而非 if/else 兜底：**只有 'completed' 才是完成**，其余终态落到
      // 各自的独立状态，绝不默认 finished（默认 finished 正是「aborted 误报完成」的成因）。
      // 映射表同时是 tools/check-plugin-contract.cjs 的校验锚点：schema 新增 kind
      // 而此处漏配时，门禁会因「未覆盖」而失败。
      const kind = event.data?.reason?.kind
      state.status = TURN_END_STATUS[kind] ?? 'finished'
      if (kind === 'error') {
        const msg = event.data?.reason?.error?.message
        if (msg) state.lastText = cap(`出错：${msg}`)
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
// 并由守卫定时器周期性自愈。成功后经 globalThis 跨热重载复用。
function ensureServer(attempt = 0) {
  const g = globalThis
  // 热重载后旧实例的 server 处理器闭包仍持有旧私有 state（状态已冻结不再更新）。
  // 新实例加载时必须关闭旧 server 并重建——新处理器读取 globalThis 共享 state，
  // 否则出现「新实例收事件、旧实例服务 HTTP」导致 /status 数据永不刷新。
  if (g.__dshStatusBridgeServer?.listening) {
    try { g.__dshStatusBridgeServer.close() } catch (_) {}
    g.__dshStatusBridgeServer = null
  }
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

/**
 * 测试面（对齐同仓库 dsh-llm-codebuddy 的 `__testing` 约定）。
 *
 * 导出纯逻辑，便于门禁 `tools/check-plugin-contract.cjs` 直接驱动
 * 「事件序列 → 状态机迁移」，无需起 HTTP 服务、无需真机。
 */
export const __testing = Object.freeze({
  SEMANTIC_EVENTS,
  updateState,
  textFromMessage,
  state,
  resetStream: () => { streamBuf = '' },
})

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