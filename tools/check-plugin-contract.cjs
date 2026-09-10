#!/usr/bin/env node
/**
 * check-plugin-contract.cjs — 内置插件与壳侧的事件契约门禁。
 *
 * 背景（review-r8，2026-09-10）：内置插件 `dsh-status-bridge` 把 dsh 的 session 事件
 * 转成壳侧悬浮窗/桌宠的输入。两边的「事件名 ↔ 文案/行为」是**跨仓库边界契约**，
 * 但此前没有任何机械校验，于是出现了三类真实缺陷：
 *
 *  1. 插件无条件透传每种事件（`lastEvent = event.type`），而 `assistant/chunk` 是
 *     token 级高频事件——壳侧三个消费方都**没有**该分支，全部落到退化 else，
 *     文案从「思考中/调用工具」退化为「dsh 运行中」。
 *  2. 插件把 `turn/end` 的 `aborted`/`blocked` 也并成 `finished`，导致用户主动
 *     取消任务时弹「任务完成」通知 + TTS。壳侧 statusLabel 也没有这两个终态文案。
 *  3. 插件判定的 chunk 类型 `'block'` 与真实 `StreamChunk` 联合类型 `'block-end'`
 *     不符 → 该分支是死代码。
 *
 * 本门禁做四件事（全部无需真机、毫秒级）：
 *  A. **语法**：插件 lib/*.js 过 `node --check`（assets 门禁已覆盖 assets/，此处
 *     覆盖 extra-plugins/）。
 *  B. **语义事件白名单 ↔ 壳侧分支**：插件允许上报的每种 lastEvent，壳侧
 *     StatusOverlay.statusLabel 必须有对应分支（或明确落在已知的 else）。
 *  C. **终态集合一致**：插件可能产出的 status 值，壳侧必须有文案（防「已取消」
 *     显示成「dsh 空闲」）。
 *  D. **chunk 类型真实存在**：插件引用的 StreamChunk.type 必须在 dsh 的
 *     types.d.ts 里出现（防 'block' 这类死分支）。
 *
 * 用法：node tools/check-plugin-contract.cjs
 * 退出码：0 = 通过；1 = 违约；2 = 环境缺失（dsh 未安装，跳过 D）。
 */
const { readFileSync, existsSync, readdirSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = resolve(__dirname, '..')
const PLUGIN = join(ROOT, 'app/src/main/assets/extra-plugins/dsh-status-bridge')
const PLUGIN_JS = join(PLUGIN, 'lib/index.js')
const OVERLAY_KT = join(ROOT, 'app/src/main/java/com/dsh/launcher/overlay/StatusOverlay.kt')

/** 已安装 dsh 的可能位置（设备端 / 仓库内皆可）。 */
function findDshSessionTypes() {
  const cands = [
    '/data/user/0/com.dsh.launcher/files/dsh-prefix/node_modules/@deepseek-ai/dsh-session/lib/types/types.d.ts',
    '/data/data/com.dsh.launcher/files/dsh-prefix/node_modules/@deepseek-ai/dsh-session/lib/types/types.d.ts',
    join(ROOT, 'node_modules/@deepseek-ai/dsh-session/lib/types/types.d.ts'),
  ]
  return cands.find((p) => existsSync(p)) ?? null
}

function findDshLlmTypes() {
  const cands = [
    '/data/user/0/com.dsh.launcher/files/dsh-prefix/node_modules/@deepseek-ai/dsh-llm/lib/types/types.d.ts',
    '/data/data/com.dsh.launcher/files/dsh-prefix/node_modules/@deepseek-ai/dsh-llm/lib/types/types.d.ts',
    join(ROOT, 'node_modules/@deepseek-ai/dsh-llm/lib/types/types.d.ts'),
  ]
  return cands.find((p) => existsSync(p)) ?? null
}

const problems = []
const notes = []

function fail(msg) { problems.push(msg) }
function note(msg) { notes.push(msg) }

// ── A. 语法 ──
function checkSyntax() {
  const files = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) files.push(p)
    }
  }
  try { walk(join(ROOT, 'app/src/main/assets/extra-plugins')) } catch { /* 目录缺失由 B 报 */ }
  let bad = 0
  for (const f of files) {
    try {
      execFileSync(process.execPath, ['--check', f], { stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (e) {
      bad++
      fail(`语法错误 ${f.replace(ROOT + '/', '')}：${String(e.stderr || e.message).split('\n')[0]}`)
    }
  }
  note(`语法检查 ${files.length} 个插件脚本，${bad} 个失败`)
}

// ── B/C. 从插件与壳侧各自提取契约，交叉比对 ──
function checkEventContract() {
  if (!existsSync(PLUGIN_JS)) { fail(`插件缺失：${PLUGIN_JS}`); return }
  if (!existsSync(OVERLAY_KT)) { fail(`壳侧 StatusOverlay 缺失：${OVERLAY_KT}`); return }

  const js = readFileSync(PLUGIN_JS, 'utf8')
  const kt = readFileSync(OVERLAY_KT, 'utf8')

  // 插件声明的语义事件白名单
  const m = /const SEMANTIC_EVENTS = new Set\(\[([\s\S]*?)\]\)/.exec(js)
  if (!m) { fail('未在插件中找到 SEMANTIC_EVENTS 白名单（契约锚点被移除？）'); return }
  const semantic = [...m[1].matchAll(/'([a-z]+\/[a-z-]+)'/g)].map((x) => x[1])
  if (semantic.length === 0) { fail('SEMANTIC_EVENTS 为空'); return }

  // ── 锚点必须被**真正使用**，而不只是被定义 ──
  // 反向验证发现的盲区（2026-09-10）：初版门禁只校验「白名单/映射表存在且覆盖 schema」，
  // 于是把 `SEMANTIC_EVENTS.has(type)` 改回 `state.lastEvent = type`、把映射表换成
  // if/else 兜底 finished —— 门禁全绿，两个真实缺陷双双漏检。
  // 定义了却不使用的契约等于没有契约，故必须断言使用点存在。
  if (!/SEMANTIC_EVENTS\.has\(/.test(js)) {
    fail('SEMANTIC_EVENTS 已定义但未被使用 → lastEvent 可能被无条件透传（高频 chunk 冲刷语义事件）')
  }
  if (!/TURN_END_STATUS\[/.test(js)) {
    fail('TURN_END_STATUS 已定义但未被使用 → turn/end 可能走 if/else 兜底（非 completed 误报完成）')
  }

  // 壳侧 statusLabel 处理的事件名
  const labelFn = /fun statusLabel\([\s\S]*?\n\}/.exec(kt)
  if (!labelFn) { fail('未找到 statusLabel 函数（契约锚点被移除？）'); return }
  const shellEvents = new Set([...labelFn[0].matchAll(/"([a-z]+\/[a-z-]+)"\s*->/g)].map((x) => x[1]))

  // turn/end 是**终态事件**：它在壳侧通过 status（finished/aborted/blocked/failed）
  // 体现，而不是通过 statusLabel 的 event 分支——故不要求有同名 event 分支。
  const TERMINAL_EVENTS = new Set(['turn/end'])

  for (const ev of semantic) {
    if (TERMINAL_EVENTS.has(ev)) continue
    if (!shellEvents.has(ev)) {
      fail(
        `事件契约漂移：插件会上报 lastEvent="${ev}"，但壳侧 statusLabel 无对应分支` +
          ` → 该事件期间文案退化为 else「dsh 运行中」`,
      )
    }
  }
  note(`语义事件白名单 ${semantic.length} 个：${semantic.join(', ')}`)

  // 壳侧处理但插件**永不上报**的事件 = 死分支
  const possibleEvents = new Set(semantic)
  for (const ev of shellEvents) {
    if (!possibleEvents.has(ev)) {
      fail(
        `壳侧 statusLabel 有 "${ev}" 分支，但插件永不把 lastEvent 设为该值` +
          ` → 死代码（或插件漏上报该事件）`,
      )
    }
  }

  // 插件产出的 status 值 ↔ 壳侧终态文案
  const statusCases = [...js.matchAll(/state\.status = '([a-z]+)'/g)].map((x) => x[1])
  // TURN_END_STATUS 映射表的值也算产出（它们是 status 字面量）
  const mapVals = [...js.matchAll(/:\s*'([a-z]+)',/g)].map((x) => x[1])
  const produced = [...new Set([...statusCases, ...mapVals, 'idle'])]
  const shellStatuses = new Set([...labelFn[0].matchAll(/"([a-z]+)"\s*->/g)].map((x) => x[1]))
  shellStatuses.add('running') // running 是外层 when 的主体
  // idle 由 statusLabel 的 else 分支表示（「dsh 空闲」），无需显式分支
  for (const s of produced) {
    if (s === 'idle') continue
    if (!shellStatuses.has(s)) {
      fail(`状态契约漂移：插件会产出 status="${s}"，但壳侧 statusLabel 无对应文案 → 显示成「dsh 空闲」`)
    }
  }
  note(`插件产出状态：${produced.join(', ')}`)

  // 壳侧若把 aborted/blocked 当作完成（running→finished 判定），会误报通知
  const svc = join(ROOT, 'app/src/main/java/com/dsh/launcher/service/StatusBridgeService.kt')
  if (existsSync(svc)) {
    const s = readFileSync(svc, 'utf8')
    if (/prev == "running" && status == "finished"/.test(s)) {
      note('完成通知判定 = running→finished（插件已把 aborted/blocked 独立成终态，不再误报）')
    }
  }
}

// ── D. chunk 类型必须在真实 dsh 类型里存在 ──
function checkChunkTypes() {
  if (!existsSync(PLUGIN_JS)) return
  const js = readFileSync(PLUGIN_JS, 'utf8')
  // 只取 chunk.type 判定：`chunk?.type === 'x'` / `chunk.type === 'x'`
  const used = [...new Set([...js.matchAll(/chunk\??\.type === '([a-z-]+)'/g)].map((x) => x[1]))]
  if (used.length === 0) return

  const llm = findDshLlmTypes()
  if (!llm) {
    note('SKIP chunk 类型核对（未找到 dsh-llm types.d.ts，无法确认真实联合类型）')
    return
  }
  const dts = readFileSync(llm, 'utf8')
  // 精准取 StreamChunk 联合体：从 `export type StreamChunk =` 到首个行首 `};`
  const m = /export type StreamChunk =([\s\S]*?)\n\};/.exec(dts)
  const real = m ? [...new Set([...m[1].matchAll(/type: '([a-z-]+)'/g)].map((x) => x[1]))] : []
  if (real.length < 3) {
    // 解析明显不完整（真实联合有 7 个变体）→ 宁可 SKIP 也不误报
    note(`SKIP StreamChunk 联合类型解析不完整（仅得 ${real.length} 项，疑似格式变化）`)
    return
  }

  for (const t of used) {
    if (!real.includes(t)) {
      fail(
        `chunk 类型死分支：插件判定 '${t}'，但真实 StreamChunk 联合类型只有 ${real.join('/')}` +
          ` → 该分支永不命中`,
      )
    }
  }
  note(`chunk 类型核对：插件用 ${used.join(', ')}；真实联合 ${real.join(', ')}`)
}

// ── E. turn/end 的 reason.kind 必须与 schema 一致 ──
function checkTurnEndKinds() {
  if (!existsSync(PLUGIN_JS)) return
  const js = readFileSync(PLUGIN_JS, 'utf8')

  // 锚点：TURN_END_STATUS 映射表的键（显式覆盖，便于机械校验）
  const m = /const TURN_END_STATUS = Object\.freeze\(\{([\s\S]*?)\}\)/.exec(js)
  if (!m) { fail('未找到 TURN_END_STATUS 映射表（契约锚点被移除？）'); return }
  const covered = [...m[1].matchAll(/^\s*'?([a-z-]+)'?\s*:/gm)].map((x) => x[1])
  if (covered.length === 0) { fail('TURN_END_STATUS 为空'); return }

  const sess = findDshSessionTypes()
  if (!sess) { note('SKIP turn/end kind 核对（未找到 dsh-session types.d.ts）'); return }
  const dts = readFileSync(sess, 'utf8')
  // 精准取 TurnEndReasonMap：到首个行首 `}`
  const mm = /export interface TurnEndReasonMap \{([\s\S]*?)\n\}/.exec(dts)
  const real = mm ? [...new Set([...mm[1].matchAll(/kind: '([a-z-]+)'/g)].map((x) => x[1]))] : []
  if (real.length < 3) {
    note(`SKIP TurnEndReasonMap 解析不完整（仅得 ${real.length} 项，疑似格式变化）`)
    return
  }

  for (const k of covered) {
    if (!real.includes(k)) fail(`turn/end kind 漂移：插件映射了 '${k}'，schema 只有 ${real.join('/')}`)
  }
  // 反向：schema 有但插件未覆盖 → 会落到默认分支（历史事故：默认 finished 误报完成）
  for (const k of real) {
    if (!covered.includes(k)) {
      fail(
        `turn/end 终态未覆盖：schema 有 '${k}'，TURN_END_STATUS 未映射` +
          ` → 会落到默认分支（默认 finished 会误报「任务完成」）`,
      )
    }
  }
  note(`turn/end kind：插件覆盖 ${covered.join(', ')}；schema ${real.join(', ')}`)
}

// ── F. 运行时执行：静态检查看不见的作用域/引用错误 ──
/**
 * **为什么必须真跑一遍**（2026-09-10 实锤）：把 turn/end 分支重构为映射表时，
 * 编辑操作意外删掉了 `const kind = ...` 声明，留下 `TURN_END_STATUS[kind]` 引用未定义变量。
 * 静态门禁（白名单存在、映射表覆盖 schema、使用点存在）**全部通过**，
 * 但真机执行 `turn/end` 会直接抛 `ReferenceError: kind is not defined` ——
 * 状态机在最关键的一步（每轮对话收尾）崩掉，且异常被 apply() 的 try/catch 吞掉，
 * 表现只是「状态永远停在 running」。
 *
 * 因此本门禁用插件自带的 `__testing` 面**实际驱动一遍状态机**，
 * 覆盖全部 turn/end kind 与代表性事件序列，任何异常即失败。
 */
function checkRuntime() {
  if (!existsSync(PLUGIN_JS)) return
  const js = readFileSync(PLUGIN_JS, 'utf8')
  if (!/export const __testing/.test(js)) {
    fail('插件缺少 __testing 导出面 → 无法做运行时契约验证（请补齐，参照 dsh-llm-codebuddy 约定）')
    return
  }

  const driver = `
process.env.DSH_STATUS_BRIDGE_PORT = '0'   // 0 = 随机空闲端口，避免与真机 3190 冲突
const mod = await import(${JSON.stringify(PLUGIN_JS)})
const t = mod.__testing
if (!t || typeof t.updateState !== 'function') { console.error('__testing.updateState 不可用'); process.exit(3) }
const seq = [
  ['turn/start', {}],
  ['user/message', {}],
  ['tool/call', { name: 'read_file', callId: 'c1', arguments: '{}' }],
  ['assistant/chunk', { chunk: { type: 'text-delta', text: 'hi' } }],
  ['assistant/chunk', { chunk: { type: 'block-end', block: { type: 'text', text: 'hi' } } }],
  ['tool/result', {}],
  ['assistant/message', { message: { content: [{ type: 'text', text: 'ok' }] } }],
]
for (const [type, data] of seq) t.updateState({ id: 's' }, { type, data })
// 全部 turn/end kind 都要能安全走完（这是 ReferenceError 的触发点）
for (const kind of ['completed', 'aborted', 'blocked', 'interrupted', 'max-tokens', 'error']) {
  const ev = { type: 'turn/end', data: { reason: { kind } } }
  if (kind === 'error') ev.data.reason.error = { message: 'x', code: 'Y' }
  t.updateState({ id: 's' }, ev)
  const st = t.state.status
  if (typeof st !== 'string' || st.length === 0) { console.error('turn/end ' + kind + ' 未产出合法 status'); process.exit(4) }
}
// 未知事件不得抛异常（前向兼容：dsh 新增事件时壳侧不应崩）
t.updateState({ id: 's' }, { type: 'some/future-event', data: {} })
t.updateState({ id: 's' }, { type: undefined, data: undefined })
console.log('RUNTIME_OK')
`
  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', driver], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    })
    if (!out.includes('RUNTIME_OK')) {
      fail(`运行时驱动未返回 RUNTIME_OK（输出：${out.trim().slice(0, 160)}）`)
    } else {
      note('运行时驱动：事件序列 + 6 种 turn/end kind + 未知事件 全部安全通过')
    }
  } catch (e) {
    const err = String(e.stderr || e.message || e)
    const first = err.split('\n').find((l) => /Error|error/.test(l)) || err.split('\n')[0]
    fail(`运行时驱动抛异常（静态检查通过但真机必崩）：${first.trim().slice(0, 200)}`)
  }
}

// ── G. 插件自带单测（node:test，零依赖） ──
/**
 * 契约门禁校验「两边是否对齐」，插件单测校验「状态机语义是否正确」——两者互补：
 * 门禁能发现契约漂移，但发现不了「语义实现写反了」。
 * 参照参考项目 plugins 下 test 目录的约定（node:test + assert/strict）。
 */
function checkPluginTests() {
  const testDir = join(PLUGIN, 'test')
  if (!existsSync(testDir)) { note('SKIP 插件单测（本插件暂无 test/ 目录）'); return }
  const files = readdirSync(testDir).filter((f) => f.endsWith('.test.mjs')).map((f) => join(testDir, f))
  if (files.length === 0) { note('SKIP 插件单测（test/ 内无 *.test.mjs）'); return }

  for (const f of files) {
    const base = f.split('/').pop()
    try {
      const out = execFileSync(process.execPath, ['--test', f], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
      })
      const pass = /# pass (\d+)/.exec(out)
      note(`插件单测 ${base}：通过${pass ? ` ${pass[1]} 项` : ''}`)
    } catch (e) {
      const out = String(e.stdout || '') + String(e.stderr || '')
      const failed = [...out.matchAll(/✖ (.+?) \(\d/g)].map((m) => m[1]).slice(0, 3)
      fail(`插件单测失败 ${base}${failed.length ? `：${failed.join('；')}` : ''}`)
    }
  }
}

checkSyntax()
checkEventContract()
checkChunkTypes()
checkTurnEndKinds()
checkRuntime()
checkPluginTests()

console.log('')
for (const n of notes) console.log('  · ' + n)

if (problems.length > 0) {
  console.error('')
  for (const p of problems) console.error('  FAIL ' + p)
  console.error(`\n插件契约门禁未通过：${problems.length} 项。`)
  process.exit(1)
}
console.log('\n  插件契约门禁通过（事件白名单/状态集合/chunk 类型/turn-end 终态 均与壳侧及 dsh schema 一致）')
process.exit(0)
