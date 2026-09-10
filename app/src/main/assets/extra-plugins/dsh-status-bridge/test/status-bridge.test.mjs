// dsh-status-bridge 契约与状态机回归测试（review-r8）。
//
// 覆盖 2026-09-10 实测的三个真实缺陷，以及壳侧消费方的对应契约：
//   1. 高频 assistant/chunk 不得冲刷 lastEvent（否则壳侧文案退化为「dsh 运行中」）
//   2. turn/end 的 aborted/blocked/interrupted/max-tokens 不得被当成 finished
//      （否则用户取消任务也弹「任务完成」通知 + TTS）
//   3. chunk.type 必须是真实 StreamChunk 联合类型的取值（'block-end' 而非 'block'）
//
// 运行：node --test app/src/main/assets/extra-plugins/dsh-status-bridge/test/
//   （或经 tools/check-plugin-contract.cjs 的运行时驱动一并验证）
//
// 约定参照参考项目 dsh-mobile-apk 的 plugins/*/test/*.test.mjs：node:test + assert/strict，
// 零依赖、可离线跑。
import { test } from 'node:test'
import assert from 'node:assert/strict'

// 插件在 import 时会尝试监听端口；测试用 0 让内核分配空闲端口，避免与真机 3190 冲突。
// 该赋值必须在动态 import 之前生效。
process.env.DSH_STATUS_BRIDGE_PORT = '0'

const { __testing } = await import('../lib/index.js')
const { updateState, state, SEMANTIC_EVENTS, resetStream } = __testing

/** 喂一个事件并返回状态快照。 */
function feed(type, data = {}) {
  updateState({ id: 'sess-1' }, { type, data })
  return { ...state }
}

/** 每个用例前复位：清流式缓冲与全部字段。 */
function reset() {
  resetStream()
  Object.assign(state, {
    status: 'idle',
    sessionId: null,
    lastText: '',
    lastEvent: null,
    updatedAt: 0,
    toolName: null,
    toolArgs: null,
    toolCallId: null,
    toolStartedAt: null,
    lastTool: null,
  })
}

// ── 缺陷 1：高频 chunk 不得冲刷语义事件 ──

test('assistant/chunk 不改写 lastEvent（高频事件冲刷语义事件是真实缺陷）', () => {
  reset()
  feed('turn/start')
  assert.equal(state.lastEvent, 'turn/start')

  for (const text of ['第', '一', '段']) {
    feed('assistant/chunk', { chunk: { type: 'text-delta', text } })
  }
  assert.equal(
    state.lastEvent,
    'turn/start',
    'chunk 必须保留上一个语义事件——否则壳侧文案退化为「dsh 运行中」',
  )
  // 但文本要实时累积（流式朗读依赖它）
  assert.equal(state.lastText, '第一段')
})

test('SEMANTIC_EVENTS 白名单不含高频 chunk 类事件', () => {
  assert.ok(!SEMANTIC_EVENTS.has('assistant/chunk'))
  assert.ok(!SEMANTIC_EVENTS.has('step/start'))
  assert.ok(SEMANTIC_EVENTS.has('tool/call'))
})

test('tool/call 的语义事件在后续 chunk 冲刷下保持可见', () => {
  reset()
  feed('turn/start')
  feed('tool/call', { name: 'read_file', callId: 'c1', arguments: '{"p":1}' })
  assert.equal(state.lastEvent, 'tool/call')
  assert.equal(state.toolName, 'read_file')

  for (let i = 0; i < 20; i++) {
    feed('assistant/chunk', { chunk: { type: 'text-delta', text: 'x' } })
  }
  assert.equal(state.lastEvent, 'tool/call', '20 个 chunk 之后语义事件仍须可见')
  assert.equal(state.toolName, 'read_file')
})

// ── 缺陷 2：turn/end 终态分类 ──

test('只有 completed 映射为 finished', () => {
  reset()
  feed('turn/start')
  feed('turn/end', { reason: { kind: 'completed' } })
  assert.equal(state.status, 'finished')
})

test('aborted / blocked 不得被当成 finished（否则误弹「任务完成」）', () => {
  for (const [kind, want] of [['aborted', 'aborted'], ['blocked', 'blocked']]) {
    reset()
    feed('turn/start')
    feed('turn/end', { reason: { kind } })
    assert.equal(state.status, want, `${kind} 必须是独立终态`)
    assert.notEqual(state.status, 'finished', `${kind} 不是完成任务`)
  }
})

test('interrupted / max-tokens 也不是成功完成', () => {
  for (const kind of ['interrupted', 'max-tokens']) {
    reset()
    feed('turn/start')
    feed('turn/end', { reason: { kind } })
    assert.notEqual(state.status, 'finished', `${kind} 不是成功完成`)
  }
})

test('error 上报 failed 并带上错误消息', () => {
  reset()
  feed('turn/start')
  feed('turn/end', { reason: { kind: 'error', error: { message: '网关 500', code: 'X' } } })
  assert.equal(state.status, 'failed')
  assert.match(state.lastText, /网关 500/)
})

test('未知 reason.kind 不抛异常（前向兼容 dsh 新增终态）', () => {
  reset()
  feed('turn/start')
  assert.doesNotThrow(() => feed('turn/end', { reason: { kind: 'brand-new-kind' } }))
})

// ── 缺陷 3：chunk.type 取值 ──

test('block-end 变体可累积文本（旧代码写的 block 是死分支）', () => {
  reset()
  feed('turn/start')
  feed('assistant/chunk', { chunk: { type: 'block-end', block: { type: 'text', text: '块式文本' } } })
  assert.equal(state.lastText, '块式文本')
})

test('reasoning-delta 不外放（链式思考不朗读）', () => {
  reset()
  feed('turn/start')
  feed('assistant/chunk', { chunk: { type: 'reasoning-delta', text: '内心独白' } })
  assert.equal(state.lastText, '')
})

// ── 工具活动（对齐参考项目 .live.ndjson 的 name/args/dur/err） ──

test('tool/call → tool/result 配对产出耗时与失败标记', () => {
  reset()
  feed('turn/start')
  feed('tool/call', { name: 'bash', callId: 'c9', arguments: '{"cmd":"ls"}' })
  feed('assistant/chunk', { chunk: { type: 'text-delta', text: 'ignored' } })
  feed('tool/result', {})
  assert.equal(state.lastTool.name, 'bash')
  assert.equal(state.lastTool.args, '{"cmd":"ls"}')
  assert.ok(state.lastTool.durationMs === null || state.lastTool.durationMs >= 0)
  assert.equal(state.lastTool.error, null)
})

test('tool/result 的失败来自顶层 error 字段（schema 形态）', () => {
  reset()
  feed('turn/start')
  feed('tool/call', { name: 'bash', callId: 'c9', arguments: '{}' })
  feed('tool/result', { error: { name: 'ToolFailure', code: 'ENOENT' } })
  assert.equal(state.lastTool.error, 'ENOENT')
})

test('toolName 在 tool/result 后保留（壳侧据此显示「xxx 完成」）', () => {
  reset()
  feed('turn/start')
  feed('tool/call', { name: 'read_file', callId: 'c1', arguments: '{}' })
  feed('tool/result', {})
  assert.equal(state.toolName, 'read_file')
  // 新的一轮开始时才清空
  feed('turn/start')
  assert.equal(state.toolName, null)
})

// ── 健壮性 ──

test('未知事件不抛异常（dsh 新增事件类型时壳侧不应崩）', () => {
  reset()
  assert.doesNotThrow(() => feed('some/future-event', { a: 1 }))
})

test('畸形事件（无 data / 无 type）不抛异常', () => {
  reset()
  assert.doesNotThrow(() => updateState({ id: 's' }, { type: 'tool/call' }))
  assert.doesNotThrow(() => updateState({ id: 's' }, {}))
  assert.doesNotThrow(() => updateState(null, null))
})

test('lastText 有界（防泄露与内存膨胀）', () => {
  reset()
  feed('turn/start')
  feed('assistant/chunk', { chunk: { type: 'text-delta', text: 'x'.repeat(50_000) } })
  assert.ok(state.lastText.length <= 2000, `lastText 应被 cap 到 2000，实际 ${state.lastText.length}`)
})

test('assistant/message 提取文本块（数组与字符串两种 content）', () => {
  reset()
  feed('turn/start')
  feed('assistant/message', { message: { content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] } })
  assert.equal(state.lastText, 'AB')
  feed('assistant/message', { message: { content: 'C' } })
  assert.equal(state.lastText, 'C')
})
