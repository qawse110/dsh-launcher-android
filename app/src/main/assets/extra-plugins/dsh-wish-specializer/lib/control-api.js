// P9.2 · **控制 API**（供 P9.3 的面板调用）。挂在 `ctx.webServer` 上，前缀 `/po06/api`。
//
// 为什么必须自己做信任检查（EV-0139）：宿主的"浏览器信任闸门"只覆盖 `/api` 前缀
// （`dsh-client-connection` 的注释写明 "Browser-trust fence for every /api request"），
// 而插件路由在 `/po06/api` —— **不在闸门内**。宿主的理由同样适用于我们：
//   · **DNS rebinding**：恶意页面把域名解析到 127.0.0.1，就能带着 `Host: evil.com` 打本地端口；
//     闸门靠 Host 判据挡住它（Host 是 rebinding 唯一改不了的请求头）。
//   · **跨站发起**：恶意页面直接 `fetch('http://127.0.0.1:3080/po06/api/settings')`。
// 而我们的接口能读到**用户的意图状态**（他说的原话），还能**改设置** ⇒ 不能裸奔。
//
// 采用与宿主同源的判据 + 一条只对我们有利的加码：
//   ① `Host` 必须是 loopback 权威（127/8、localhost、[::1]，可带端口）——挡 rebinding；
//   ② 出现 `Origin` 时其 host 必须是 loopback——挡跨站；
//   ③ **写操作必须带自定义头 `x-po06: 1`**：自定义头会触发 CORS 预检，而我们**从不**回 CORS 头
//      ⇒ 跨站写在预检阶段就被浏览器拦掉（同源页面不受影响）。这一条是"最小代价的 CSRF 防线"。
import { appendFileSync, readFileSync, writeFileSync, existsSync, renameSync, rmSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SYSTEM_PROMPT } from './interpreter.js'
import { OPTIMIZER_PROTOCOL_VERSION, composeOptimizerSystem, isLegacyDefaultPrompt } from './optimizer-protocol.js'
import { parseEnableIntent } from './assembly-gate.js'
import { effectiveSettings } from './policy.js'
import { normalizeSettings, describeSettings, writeSettings, SETTINGS_KEYS, parseJsonText } from './settings.js'

export const API_PREFIX = '/po06/api'
/** 写操作必须带的自定义头（见文件头 ③）。 */
export const WRITE_HEADER = 'x-po06'
/** 启动闸门自己的顶层字段：它们不是"设置"，但**也不是**不认识的字段（见 /status 的处理）。 */
export const GATE_KEYS = Object.freeze(['settingsVersion', 'enabled', 'rollout'])
/**
 * 请求体上限。
 *
 * ⚠ 2026-09-26 修正（用户实测：几万字原文必然失败，且报错显示成"连不上宿主服务"）：
 * 原先取 64KB，注释里的理由是「设置/指令都很小」——**这个前提是错的**：
 * 本模块的 readBody 不只服务设置端点，interpret 端点的 body 里装的是用户原文，
 * 而原文可以很长（实测 39123 字）。中文一字 3 字节 ⇒ 64KB ÷ 3 ≈ **21800 字**，
 * 超过就撞墙，用户看到的是"优化失败"。
 *
 * 现在取 2MB：约合 66 万汉字原文，对"人写的提示词"绰绰有余，
 * 同时仍能挡住真正的巨体（比如误发的二进制）。
 */
export const MAX_BODY_BYTES = 2 * 1024 * 1024

/** `authority`（Host 头的值，可能带端口）是不是 loopback。纯函数。 */
export function isLoopbackAuthority(authority) {
  const a = String(authority == null ? '' : authority).trim().toLowerCase()
  if (!a) return false
  let host = a
  if (host.startsWith('[')) {                       // IPv6 字面量：[::1]:3080
    const end = host.indexOf(']')
    if (end < 0) return false
    host = host.slice(0, end + 1)
    return host === '[::1]'
  }
  const colon = host.lastIndexOf(':')
  if (colon >= 0) host = host.slice(0, colon)       // 去掉端口
  if (host === 'localhost') return true
  if (host === '::1') return true
  const parts = host.split('.')
  return parts.length === 4 && parts[0] === '127'
    && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

/**
 * 请求可信吗。**纯函数**（只读 headers），便于单测把每条判据钉死。
 * @param headers 形如 `{ host, origin, 'x-po06' }` 的小写键对象
 * @param needsWrite 写操作要求额外的自定义头
 */
export function requestTrust(headers, needsWrite) {
  const h = headers || {}
  const host = h.host
  if (!isLoopbackAuthority(host)) return { ok: false, code: 403, reason: 'host-not-loopback' }
  if (h.origin !== undefined && h.origin !== null && String(h.origin) !== '') {
    let ohost = null
    try { ohost = new URL(String(h.origin)).host } catch { return { ok: false, code: 403, reason: 'origin-unparsable' } }
    if (!isLoopbackAuthority(ohost)) return { ok: false, code: 403, reason: 'origin-not-loopback' }
  }
  if (needsWrite && String(h[WRITE_HEADER] || '') !== '1') return { ok: false, code: 403, reason: 'missing-write-header' }
  return { ok: true }
}

/** 意图条目的**出处分类**：来自用户的话 / 机器补充 / 无出处。纯函数。 */
export function provenanceOf(item) {
  // ⚠ P11：**显式标了机器来源的，不许被"有 human 引用"洗成"你说过"**。
  // 短消息的引文可以来自**上下文**（用户 2026-09-21 的反馈：一两字结合上下文也有大量信息），
  // 那种条目在 parse 里被标成 `provenance:'machine'` —— 这里必须尊重它，否则界面会把
  // "机器从上下文推的"显示成"来自你的话"，那是最不该犯的错。
  if (item && item.provenance === 'machine') return 'machine'
  const refs = Array.isArray(item && item.sourceRefs) ? item.sourceRefs : []
  if (refs.some((r) => r && (r.kind === 'human' || r.kind === 'user'))) return 'user'
  if (refs.length > 0) return 'machine'
  return 'unsourced'
}

/** 把一份状态投影成面板要用的形状（不暴露 schema/phase/hash —— 计划 §14.1 的明确要求）。 */
export function projectState(state, sessionId) {
  if (!state || !Array.isArray(state.items)) return null
  const items = state.items.map((it) => ({
    id: it.id, kind: it.kind, status: it.status, text: it.text,
    provenance: provenanceOf(it), scope: it.scope || null,
  }))
  return {
    sessionId: sessionId || state.sessionId || null,
    revision: typeof state.revision === 'number' ? state.revision : null,
    items,
    counts: {
      total: items.length,
      user: items.filter((x) => x.provenance === 'user').length,
      machine: items.filter((x) => x.provenance === 'machine').length,
      unsourced: items.filter((x) => x.provenance === 'unsourced').length,
    },
  }
}

/** 台账最后 n 行 → 面板要用的字段（丢掉 trace 之类的大字段）。纯函数（输入是文本）。 */
export function recentTurns(ledgerText, limit = 5) {
  const lines = String(ledgerText == null ? '' : ledgerText).split('\n')
  const out = []
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    try { out.push(JSON.parse(t)) } catch { /* 坏行跳过（台账是流式追加，可能正在写） */ }
  }
  return out.slice(-Math.max(0, limit)).reverse().map((r) => ({
    at: r.at || null, trigger: r.trigger || null, ok: r.ok === true,
    outcome: r.outcome || null, inputChars: typeof r.chars === 'number' ? r.chars : null,
    packetChars: typeof r.packetChars === 'number' ? r.packetChars : null,
    revision: typeof r.revision === 'number' ? r.revision : null,
    ms: typeof r.ms === 'number' ? r.ms : null,
    model: r.provider ? r.provider + '/' + (r.model || '') : null,
    reason: r.reason || null,
    // ── P10：把"这一轮它在做什么"需要的归因字段透给界面 ──
    // 台账里**早就有**这些（上下文读了多少、有没有派工具、包超没超预算），
    // 但 `/turns` 以前只映射固定几个字段 ⇒ 界面即便想显示也拿不到，
    // 于是"运行情况"只能靠人去看 jsonl。这里**只透传、不加工**；缺值一律 null，
    // 界面据 null 显示"未记录"——不许拿 0 冒充"没发生"（两者含义不同）。
    packetOverBudget: typeof r.packetOverBudget === 'boolean' ? r.packetOverBudget : null,
    packetOverBy: typeof r.packetOverBy === 'number' ? r.packetOverBy : null,
    packetBudget: typeof r.packetBudget === 'number' ? r.packetBudget : null,
    optimizerProtocolVersion: r.optimizerProtocolVersion || null, systemChars: r.systemChars ?? null, userPromptChars: r.userPromptChars ?? null,
    historyChars: typeof r.historyChars === 'number' ? r.historyChars : null,
    historyTurnsRead: typeof r.historyTurnsRead === 'number' ? r.historyTurnsRead : null,
    historyAvailable: typeof r.historyAvailable === 'number' ? r.historyAvailable : null,
    toolsEnabled: typeof r.toolsEnabled === 'boolean' ? r.toolsEnabled : null,
    toolsReason: typeof r.toolsReason === 'string' ? r.toolsReason : null,
    toolRounds: typeof r.toolRounds === 'number' ? r.toolRounds : null,
    toolCalls: typeof r.toolCalls === 'number' ? r.toolCalls : null,
    toolFallback: r.toolFallback || null,
    interpretVia: typeof r.interpretVia === 'string' ? r.interpretVia : null,
  }))
}

/**
 * `?` 帮助弹层的正文来源：包根目录的 `HELP-0.6.md`（**一个真相来源**——不在客户端里再抄一份，
 * 抄一份就一定会和文档分叉）。
 *
 * ⚠ 读不到时**不许假装成功**、也不许糊一段别的文案顶上：如实标 `missing` 并把路径给出去——
 * "帮助文件没进安装包"是**打包缺陷**，必须让人看见（且这份文件已列进 package.json 的 `files`，
 * 有守卫测试钉住，见 test/client-file.test.mjs）。
 */
export const HELP_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'HELP-0.6.md')
/** 英文版帮助（界面语言 = en 时优先读它；读不到就如实回落中文）。 */
export const HELP_EN_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'HELP-0.6.en.md')
/** 用户可见正文的起点标记（此前的"用途"说明与文中的〔依据〕都不给用户看）。 */
export const HELP_START = '<!-- po06:help-start'
/** 把实现者注记（〔依据：…〕，可能跨行）从用户可见正文里剥掉。 */
export function stripAuthorNotes(text) {
  return String(text == null ? '' : text).replace(/〔依据[\s\S]*?〕/g, '').replace(/[ \t]+\n/g, '\n').trim()
}

export function resolveHelp({ file = HELP_FILE, readFile = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null) } = {}) {
  const raw = readFile(file)
  if (typeof raw !== 'string' || !raw.trim()) {
    return {
      source: 'missing', path: file, text: '', chars: 0,
      note: '帮助文件读不到：' + file + '（安装包可能没带上它——这是打包缺陷，不是你的操作问题）。'
        + '界面上的每个控件都带悬停说明（title），可以先用它们。',
    }
  }
  const at = raw.indexOf(HELP_START)
  if (at < 0) {
    // 文件在、但**可见区间的标记没写**：这时给全文是不行的（开头那段是给实现者看的），
    // 于是如实报缺陷并给出路径，而不是糊一段别的文案顶上去。
    return {
      source: 'file', path: file, text: '', chars: 0, warning: 'help-start-marker-missing',
      note: '帮助文件里没有可见区间标记（' + HELP_START + '…）：这是文档缺陷，已记路径 ' + file,
    }
  }
  const body = stripAuthorNotes(raw.slice(at + HELP_START.length).replace(/^[^\n]*\n/, ''))
  return { source: 'file', path: file, text: body, chars: body.length }
}

/** 解释层提示词的**生效来源**：文件覆盖优先，否则内置。 */
export function resolvePrompt({ home, readFile = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null) } = {}) {
  const file = join(String(home), 'po06-prompt.md')
  const text = readFile(file)
  if (typeof text === 'string' && text.trim()) {
    if (isLegacyDefaultPrompt(text)) return { source: 'builtin', path: file, text: SYSTEM_PROMPT, chars: SYSTEM_PROMPT.length, migration: { reason: 'legacy-default-replaced-by-v3', originalChars: text.length, retainedAt: file } }
    if (text.trim() !== SYSTEM_PROMPT.trim()) return { source: 'file', path: file, text, chars: text.length }
  }
  return { source: 'builtin', path: file, text: SYSTEM_PROMPT, chars: SYSTEM_PROMPT.length }
}


/** Preview only: tool availability is established by the actual call, custom English core by translation. */
function promptProjection(prompt, settings = {}) {
  const englishMode = settings.englishMode === true
  const effective = englishMode && prompt.source === 'file'
    ? { version: OPTIMIZER_PROTOCOL_VERSION, language: 'en', chars: null, text: null, reason: 'custom-core-translation-needed' }
    : composeOptimizerSystem({ language: englishMode ? 'en' : 'zh', core: englishMode ? undefined : prompt.text, tier: settings.tier, toolsEnabled: settings.readTools === true, englishMode })
  return { ...prompt, protocolVersion: OPTIMIZER_PROTOCOL_VERSION, effective: { ...effective, preview: true } }
}

/** 写/重置提示词覆盖文件（原子 + 备份 + 读回）。 */
export function writePrompt({ home, text, reset = false, undo = false, now = Date.now() } = {}) {
  const path = join(String(home), 'po06-prompt.md')
  try {
    const previousPath = path + '.previous.json'
    const current = existsSync(path) ? readFileSync(path, 'utf8') : null
    if (undo) {
      if (!existsSync(previousPath)) return { ok: false, reason: '没有可撤销的提示词修改', path }
      const previous = JSON.parse(readFileSync(previousPath, 'utf8'))
      if (previous.text !== null && typeof previous.text !== 'string') return { ok: false, reason: 'invalid-history', path }
      if (current !== null) copyFileSync(path, path + '.bak-' + now)
      if (previous.text === null) rmSync(path, { force: true })
      else { writeFileSync(path + '.tmp-' + now, previous.text, 'utf8'); renameSync(path + '.tmp-' + now, path) }
      rmSync(previousPath, { force: true })
      return { ok: true, path, undone: true }
    }
    const remember = () => {
      writeFileSync(previousPath + '.tmp', JSON.stringify({ text: current }), 'utf8')
      renameSync(previousPath + '.tmp', previousPath)
    }
    if (reset) {
      remember()
      if (existsSync(path)) { copyFileSync(path, path + '.bak-' + now); rmSync(path, { force: true }) }
      return { ok: true, reset: true, path }
    }
    const body = String(text == null ? '' : text)
    if (!body.trim()) return { ok: false, reason: 'empty', path }
    if (body.length > 20000) return { ok: false, reason: 'too-long', path }
    remember()
    let backup = null
    if (existsSync(path)) { copyFileSync(path, path + '.bak-' + now); backup = path + '.bak-' + now }
    const tmp = path + '.tmp-' + now
    writeFileSync(tmp, body, 'utf8')
    renameSync(tmp, path)
    if (readFileSync(path, 'utf8') !== body) return { ok: false, reason: 'readback-mismatch', path, backup }
    return { ok: true, path, backup, chars: body.length }
  } catch (e) {
    try { rmSync(path + '.tmp-' + now, { force: true }) } catch { /* best effort */ }
    return { ok: false, reason: 'write-failed:' + String((e && e.message) || e), path }
  }
}

/**
 * 读 JSON 配置：**先剥 UTF-8 BOM 再解析**（与 settings.js 的 `parseJsonText` 同一口径）。
 * 不剥的话，Windows 上被 PowerShell / 记事本写过的配置文件会因为 `JSON.parse('\uFEFF{…}')` 抛错而读成 null，
 * 界面就会显示**一整套默认值**（用户看到"我明明设的是重度，它显示轻度/标准"），
 * 而同一份文件在 `parseEnableIntent`（BOM 容错）里却是好的 —— 一边说启用、一边报默认值，无从归因。
 */
function readJsonSafe(path) {
  try { return existsSync(path) ? parseJsonText(readFileSync(path, 'utf8')) : null } catch { return null }
}
function readTextSafe(path) {
  try { return existsSync(path) ? readFileSync(path, 'utf8') : null } catch { return null }
}

/**
 * 建一个处理函数。**不碰 ctx**（纯 IO + 纯函数），便于单测直接喂假 req/res。
 * @param opts.home        DSH_HOME
 * @param opts.stateDir    状态目录（默认 `<home>/po06-state`）
 * @param opts.ledgerPath  台账（默认 `<home>/po06-wire.jsonl`）
 * @param opts.version     版本号（面板显示用）
 * @param opts.help        `?` 帮助正文的来源覆盖（默认读包里的 HELP-0.6.md；测试可指到临时文件）
 * @param opts.interpret   P11 前置拦截的按需解释（`({sessionId, text, messageId}) => {ok, packet, chars, ms}`）；
 *                         不传 = 本 profile 不支持 ⇒ `/interpret` 如实回 501
 * @param opts.setPacket   P11 审查态里用户改过的正文 → **本轮注入的包**（`({sessionId, text}) => {ok, chars}`）；
 *                         不传 ⇒ `/packet` 如实回 501
 * @param opts.onSettingsWritten 设置**刚写盘**后的钩子（宿主拿它作废政策缓存、按新档位清理已注入的包、
 *                         作废启用闸门）。真机 2026-09-22：拨到「关闭」档后旧包仍在注入 —— 只写盘不通知，
 *                         宿主就不知道政策变了。返回值原样带回给界面（诊断用）。
 * @param opts.now         注入时钟（测试用）
 */
export function createControlHandler({ home, stateDir, ledgerPath, version = null, resolveEfforts = null, sessionModel = null, capabilityProbe = null, workingText = null, workingTextInfo = null, listModels = async () => ({ models: [], problems: [] }), listTools = null, toolState = null, now = () => Date.now(), help = {}, interpret = null, setPacket = null, progress = null, advisorProgress = null, rollbackPacket = null, getPacket = null, getInjection = null, getNotice = null, clearNotice = null, clearNotices = null, getPreset = null, inspectPreset = null, presetDismissed = null, getPresetPending = null, getPresetAt = null, clearPresetPending = null, sessionFirstSeen = null, getPresets = null, onSettingsWritten = null, gateSummary = null, registeredCommands = null, advisorStageStatus = null, capabilityStatus = null, inferenceStatus = null, inferenceList = null, inferenceGet = null, inferenceCancel = null,englishStatus=null,englishGet=null,optimizerStatus=null,advisorDelivery=null } = {}) {
  const H = String(home)
  const cfgPath = join(H, 'po06.json')
  const ledger = ledgerPath || join(H, 'po06-wire.jsonl')
  const states = stateDir || join(H, 'po06-state')

  const readBody = (req) => new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      // ⚠ 2026-09-26：超限**不要** destroy。原先这里直接销毁连接，浏览器看到的是
      // 「连接断开」而不是 HTTP 错误，client 便把它归成 unreachable、显示
      // 「连不上宿主服务（它可能刚重启）」——真因（请求体过大）被彻底盖掉，
      // 用户实测「几万字提示词必然失败」时看到的就是这句误导信息。
      // 现在只如实返回，由各调用方按既有约定回 400 + reason，界面能显示真正的原因。
      // 另外**不再继续累积 chunks**（下面 return 之前不再 push），避免巨体白占内存。
      if (size > MAX_BODY_BYTES) { resolve({ ok: false, reason: 'body-too-large', gotBytes: size, limitBytes: MAX_BODY_BYTES }); return }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw.trim()) return resolve({ ok: true, value: {} })
      try { resolve({ ok: true, value: JSON.parse(raw) }) } catch { resolve({ ok: false, reason: 'body-not-json' }) }
    })
    req.on('error', () => resolve({ ok: false, reason: 'body-read-error' }))
  })

  return async function handle(req, res) {
    const url = String(req.url || '')
    const path = url.split('?')[0]
    const query = new URLSearchParams(url.includes('?') ? url.slice(url.indexOf('?') + 1) : '')
    const method = String(req.method || 'GET').toUpperCase()
    const send = (code, obj) => {
      // 一律不回 CORS 头：跨站读被浏览器挡掉，跨站写被预检挡掉（见文件头 ③）
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(obj))
    }
    const trust = requestTrust(req.headers || {}, method !== 'GET')
    if (!trust.ok) return send(trust.code, { ok: false, reason: trust.reason })

    try {
      if (method === 'GET' && path === API_PREFIX + '/models') {
        return send(200, { ok: true, ...await listModels() })
      }
      // 当前会话模型（0.7.5）：「跟随会话模型」时界面靠它才能配档位。
      if (method === 'GET' && path === API_PREFIX + '/session-model') {
        const sid = String(query.get('session') || '').trim()
        if (!sid) return send(400, { ok: false, reason: 'session-required', model: null })
        let m = null
        // 回调可能是 async（要问宿主“此刻”的选择），这里必须 await，否则拿到的是 Promise
try { m = (typeof sessionModel === 'function') ? await sessionModel(sid) : null } catch { m = null }
        return send(200, { ok: true, provider: (m && m.provider) || null, model: (m && m.model) || null })
      }
      // 只读诊断：这一轮脚手架判断**实际能看见什么能力**（工具名 + 一句作用）。
      // 为什么要有它：能力清单没送到模型时，输出里看不出原因，只能靠猜；这里可以直接核对。
      // 只读探针（2026-10-23）：把「这一轮实际会注入什么」原样吐出来，
      // 用来区分“代码没生效 / 包为空 / 只渲染出壳”三种情况，不必再靠猜。
      if (method === 'GET' && path === API_PREFIX + '/working-text') {
        const sid = String(query.get('session') || '').trim()
        if (!sid) return send(400, { ok: false, reason: 'session-required' })
        let text = '', extra = {}
        try { text = (typeof workingText === 'function') ? String(await workingText(sid) || '') : '' } catch { text = '' }
        try { extra = (typeof workingTextInfo === 'function') ? (await workingTextInfo(sid)) || {} : {} } catch { extra = {} }
        return send(200, { ok: true, chars: text.length, head: text.slice(0, 400), ...extra })
      }
      if (method === 'GET' && path === API_PREFIX + '/capabilities') {
        const sid = String(query.get('session') || '').trim()
        if (!sid) return send(400, { ok: false, reason: 'session-required', capabilities: [] })
        let list = []
        try { list = (typeof capabilityProbe === 'function') ? await capabilityProbe(sid) : [] } catch { list = [] }
        return send(200, { ok: true, count: Array.isArray(list) ? list.length : 0, capabilities: Array.isArray(list) ? list : [] })
      }
      // 档位按需查（0.7.5）：宿主仅在 resolveModelInfo 里给 reasoning（listModels 会剥掉它），
      // 27 个模型全量 resolve 太贵 ⇒ 界面选中哪个就查哪个。
      if (method === 'GET' && path === API_PREFIX + '/efforts') {
        const provider = String(query.get('provider') || '').trim()
        const model = String(query.get('model') || '').trim()
        if (!provider || !model) return send(400, { ok: false, reason: 'route-required', efforts: [], defaultEffort: null })
        if (typeof resolveEfforts !== 'function') return send(200, { ok: false, reason: 'efforts-probe-unavailable', efforts: [], defaultEffort: null })
        try { return send(200, { ok: true, ...(await resolveEfforts(provider, model)) }) }
        catch (e) { return send(200, { ok: false, reason: 'efforts-threw:' + String((e && e.message) || e), efforts: [], defaultEffort: null }) }
      }
      if (method === 'GET' && path === API_PREFIX + '/tools') {
        // 诊断端点（2026-09-24）：**"我的工具到底进没进工作 AI 的工具表"必须能被问出来**。
        // 为什么需要：`ctx.inject` 回调是异步的，而自检报告在 apply 里同步写完 ⇒
        // 报告里的 `registerPosixTool.ok` 天生测不准。与其靠猜，不如暴露一个能立刻定论的查询。
        if (typeof listTools !== 'function') return send(200, { ok: false, reason: 'tools-probe-unavailable' })
        let names = []
        try { names = await listTools() } catch (e) { return send(200, { ok: false, reason: 'tools-probe-threw:' + String((e && e.message) || e) }) }
        const list = (Array.isArray(names) ? names : []).map(String).sort()
        return send(200, {
          ok: true,
          count: list.length,
          posix: list.includes('posix'),
          ours: list.filter((n) => n === 'posix' || n.startsWith('po06')),
          tools: list,
          // 注册现场：成没成、走的哪条路、失败原因、注册时看到的服务形状
          register: toolState ? { last: toolState.last, seen: toolState.seen } : null,
        })
      }
      // 界面取证（临时）：记录浏览器实际发来的读写，用于判定"点击没反应"卡在哪一环。
      // 写到独立文件而不是 wire 台账：形状简单、可直接读、不影响既有台账消费方。
      let lastWatchTraceAt = 0
      const traceApi = (rec) => {
        try {
          const p = join(H, 'po06-api-trace.jsonl')
          let cur = ''
          try { cur = readFileSync(p, 'utf8') } catch { cur = '' }
          const lines = cur.split('\n').filter(Boolean)
          const keep = lines.slice(-400).concat(JSON.stringify({ at: new Date().toISOString(), ...rec }))
          writeFileSync(p, keep.join('\n') + '\n', 'utf8')
        } catch { /* best effort */ }
      }
      if (method === 'GET' && path === API_PREFIX + '/status') {
        const raw = readJsonSafe(cfgPath)
        const intent = parseEnableIntent(readTextSafe(cfgPath))
        const norm = normalizeSettings(raw || {})
        // 会话级档位（0.7.7）：带上 ?session= 时，额外给出**该会话实际生效**的档位与描述。
        // 全局的 settings/described 原样保留（它们是"这台机器的默认"），
        // 界面据此显示当前会话的值、并在改档时只写该会话的覆盖。
        const qsid = String(query.get('session') || '').trim()
        const sessEff = qsid ? effectiveSettings(raw || {}, qsid) : null
        // ⚠ 档位必须用**推导值**（describeSettings 内部走 tierOf），不能用合并对象里的 `tier` 字段：
        //   那个字段只是覆盖里写进来的别名原样，不代表实际生效的档位。
        //   实测过这个坑：覆盖写了 tier=heavy 而三项没展开时，界面会显示"重度"，行为却是 standard。
        const sessDesc = sessEff ? describeSettings(sessEff) : null
        // build = 客户端自报的构建标记（2026-10-19）：一条台账就能看出浏览器里跑的是不是最新一版
        traceApi({ k: 'status', sid: qsid || null, tier: sessDesc ? sessDesc.tier : null,
          build: String(query.get('build') || '').slice(0, 24) || null,
          ua: String(req.headers['user-agent'] || '').slice(0, 40) })
        const prompt = resolvePrompt({ home: H })
        return send(200, {
          ok: true, version, home: H,
          capability: typeof capabilityStatus === 'function' ? capabilityStatus(qsid || null) : null,
           inference: typeof inferenceStatus==='function' ? inferenceStatus() : {ready:false,reason:'not-implemented'},
           english:typeof englishStatus==='function'?englishStatus(qsid||null):{ready:false},
          advisorCollaboration: typeof advisorStageStatus==='function' ? (()=>{try{return advisorStageStatus(qsid || null)}catch{return {ok:false,reason:'stage-status-unavailable'}}})() : null,
          enabled: intent.settings.enabled === true,
          rollout: intent.rollout.mode,
          // 诊断：`rollout` 是**回落来的 off**（配置里没写/写错）还是**用户显式写的 off**——
          // 这两种在界面上必须能分开，否则"什么都没发生"永远无从归因（用户 2026-09-22 要求查清
          // `gate:rollout-off`）。见 rollout.js 的 normalizeRollout/decideEnabled。
          rolloutDefaulted: intent.rollout.defaulted === true,
          rolloutNote: intent.rollout.defaulted === true
            ? (intent.settings.enabled === true
              ? '配置里没有（或写错了）rollout：已按 "all" 处理（因为你显式写了 enabled:true）'
              : '配置里没有（或写错了）rollout，且没有显式 enabled:true ⇒ 保守不启用')
            : null,
          // ⚠ 上面那个 `enabled` 是**配置里的意图**，不是**闸门实际放行的结论**。两者可能不同
          //   （例：配置写了 enabled:true，但 rollout 显式 off / 旧插件仍在装配 ⇒ 闸门不放行）。
          //   真机教训：界面显示"已启用"而插件什么都不做，用户无从归因。这里如实给出闸门的结论分布。
          gate: typeof gateSummary === 'function' ? (() => { try { return gateSummary() } catch { return null } })() : null,
          ours: intent.ours, reason: intent.reason || null,
          settings: norm.settings, described: describeSettings(norm.settings),
          // 斜杠命令允许列表（0.8）：只有**配置里列了、且当前真的已注册**的命令才允许被拦截。
          // 问不到命令表时**退回名单本身**（verified:false 如实标注）——否则名单会被静默架空，
          // 用户看到的是“配了也不生效”（2026-10-01 真机就是这个现象）。
          // 已经问到时严格精确：没注册的命令绝不进 active。
          // 真实失败模式汇总（每一条都如实回传）：
          //   no-allowlist        没配名单（默认，全部交还宿主）
          //   session-required    没带 ?session=
          //   unverified:<原因>    查不到命令表，已按名单兜底并标注未核对
          //   agents-service-unavailable / no-live-agent / commands-list-threw:*
          slashReview: (() => {
            const want = Array.isArray(norm.settings.slashReview) ? norm.settings.slashReview : []
            if (!want.length) return { names: [], active: [], reason: 'no-allowlist' }
            if (!qsid) return { names: want, active: [], reason: 'session-required' }
            let reg = null
            try { reg = typeof registeredCommands === 'function' ? registeredCommands(qsid) : { ok: false, reason: 'resolver-missing', names: [] } }
            catch (e) { reg = { ok: false, reason: 'threw:' + String((e && e.message) || e), names: [] } }
            const have = new Set((reg && Array.isArray(reg.names) ? reg.names : []).map((n) => String(n).toLowerCase()))
            // ① 问到了命令表 ⇒ 精确匹配（没注册的绝不拦）。
            if (reg && reg.ok === true) {
              return { names: want, active: want.filter((n) => have.has(n)), verified: true,
                via: (reg.diagnostics && reg.diagnostics.via) || null, reason: null, diagnostics: reg.diagnostics || null }
            }
            // ② 问不到（命令表或 agent 拿不到）⇒ 退回名单：列了就是用户要我拦的。
            //    标记 verified:false + 具体原因，既不假装核对过，也不静默失效。
            return { names: want, active: want.slice(), verified: false, via: null,
              reason: 'unverified:' + String((reg && reg.reason) || 'unavailable'), diagnostics: (reg && reg.diagnostics) || null }
          })(),
          // 会话生效值（无 ?session= 时为 null）：界面用它显示"本会话的档位"
          sessionId: qsid || null,
          sessionEffective: sessEff
            ? { tier: sessDesc.tier, assist: sessEff.assist, detail: sessEff.detail, budget: sessEff.budget,
                reasoningBoost:sessEff.reasoningBoost,reasoningMode:sessEff.reasoningMode,reasoningCandidates:sessEff.reasoningCandidates,reasoningRounds:sessEff.reasoningRounds,reasoningPace:sessEff.reasoningPace,englishMode:sessEff.englishMode,modelState:sessEff.modelState === 'extreme' ? 'extreme' : 'normal' }
            : null,
          sessionDescribed: sessDesc,
          // ⚠ 启动闸门自己的字段（enabled / rollout / settingsVersion）**不是**"不认识的字段"，
          // 只是不属于**设置**白名单。真实宿主实测（EV-0141）时它们被当成 problems 报给界面，
          // 界面会显示"配置里有 3 处不规范"——**假警报**，用户会以为自己把配置写坏了。
          problems: norm.problems.filter((p) => !GATE_KEYS.includes(p.key)),
          prompt: { ...promptProjection(prompt, { ...(sessEff || norm.settings), tier: sessDesc?.tier || describeSettings(norm.settings).tier }),
            lastRequest: typeof optimizerStatus === 'function' ? optimizerStatus(qsid || null) : null },
          writableKeys: SETTINGS_KEYS,
        })
      }
      if (method === 'GET' && path === API_PREFIX + '/state') {
        const sid = String(query.get('session') || '').trim()
        if (!sid) return send(400, { ok: false, reason: 'session-required' })
        const safe = sid.replace(/[^A-Za-z0-9._-]/g, '_')
        const state = readJsonSafe(join(states, safe + '.json'))
        const projected = projectState(state, sid)
        // ⚠ "这个会话还没有状态"是**正常情况**（还没产生过意图包），不是错误：返回 404 会让浏览器
        // 控制台报红（真机 DOM 探针实测到那条红字），而界面上其实一切正常。
        // 404 的语义是"资源不存在"，这里应当是"**查询成功，只是还空着**"。
        if (!projected) {
          return send(200, { ok: true, hasState: false, sessionId: sid, revision: null, items: [],
            counts: { total: 0, user: 0, machine: 0, unsourced: 0 } })
        }
        return send(200, { ok: true, hasState: true, ...projected })
      }
      if (method === 'GET' && path === API_PREFIX + '/turns') {
        const n = Math.min(50, Math.max(1, Number(query.get('limit') || 5) || 5))
        return send(200, { ok: true, turns: recentTurns(readTextSafe(ledger) || '', n), limit: n })
      }
      if (method === 'GET' && path === API_PREFIX + '/prompt') {
        const p = resolvePrompt({ home: H })
        return send(200, { ok: true, ...p, protocolVersion: OPTIMIZER_PROTOCOL_VERSION })
      }
      // `?` 帮助弹层的正文（要求②，2026-09-21）：真身是包里的 HELP-0.6.md，**不在这里另写一份**。
      // 英文适配（用户 2026-09-22）：界面语言跟随 DSH 的「语言」设置 ⇒ 客户端把当前语言带上来，
      // 这里优先读同目录的 `HELP-0.6.en.md`；读不到就**如实回落中文**（并在响应里说明，不假装有英文）。
      if (method === 'GET' && path === API_PREFIX + '/help') {
        const wantEn = /^en/i.test(String(query.get('lang') || ''))
        if (wantEn) {
          const en = resolveHelp({ ...help, file: help && help.file ? String(help.file).replace(/\.md$/, '.en.md') : HELP_EN_FILE })
          if (en && en.text) return send(200, { ok: true, lang: 'en', ...en })
        }
        return send(200, { ok: true, lang: wantEn ? 'zh' : 'zh', note: wantEn ? 'english help file not found; served the Chinese one' : null, ...resolveHelp(help) })
      }
      if (method === 'POST' && path === API_PREFIX + '/settings') {
        const body = await readBody(req)
        if (!body.ok) return send(400, { ok: false, reason: body.reason })
        try {
          const v = body.value || {}
          traceApi({ k: 'settings', keys: Object.keys(v), by: v.bySession ? Object.keys(v.bySession) : null,
            tier: v.bySession ? Object.values(v.bySession).map((x) => x && x.tier).filter(Boolean) : null })
        } catch { /* best effort */ }
        const r = writeSettings({ path: cfgPath, patch: body.value || {}, now: now() })
        // 写盘成功 ⇒ 立刻通知宿主按**新政策**处理（作废政策缓存 / 清掉不该再注入的包 / 作废启用闸门）。
        // 钩子抛错**不得**把这次成功的写入回报成失败（文件已经写进去了，谎报失败更糟）：如实带上 hookError。
        let hook = null
        let hookError = null
        if (r.ok === true && typeof onSettingsWritten === 'function') {
          try { hook = onSettingsWritten({ patch: body.value || {}, settings: normalizeSettings(r.after).settings }) }
          catch (e) { hookError = String((e && e.message) || e) }
        }
        return send(r.ok ? 200 : 500, {
          ok: r.ok, reason: r.reason || null, backup: r.backup, problems: r.problems,
          settings: normalizeSettings(r.after).settings,
          described: describeSettings(normalizeSettings(r.after).settings),
          recoveredFromCorrupt: r.recoveredFromCorrupt === true,
          hook,
          hookError,
        })
      }
      if (method === 'POST' && path === API_PREFIX + '/prompt') {
        const body = await readBody(req)
        if (!body.ok) return send(400, { ok: false, reason: body.reason })
        const v = body.value || {}
        const r = writePrompt({ home: H, text: v.text, reset: v.reset === true, undo: v.undo === true, now: now() })
        return send(r.ok ? 200 : 400, { ok: r.ok, reason: r.reason || null, backup: r.backup || null, path: r.path })
      }
      if (method === 'POST' && path === API_PREFIX + '/interpret') {
        // P11：前置拦截的按需解释（"第一轮发，第一轮就回"）。**可能跑 20–60 秒**——这是设计好的等待，
        // 客户端此时显示"优化中… 已用 N 秒 ｜ 跳过并直接发送"。**不设超时**（用户 2026-09-21 明确选择）。
        const body = await readBody(req)
        if (!body.ok) return send(400, { ok: false, reason: body.reason })
        const v = body.value || {}
        if (typeof interpret !== 'function') {
          // 本 profile 没接上 pipeline ⇒ **如实说做不到**（客户端据此按原文放行），不假装成功
          return send(501, {
            ok: false, reason: 'not-implemented',
            note: '按需解释需要宿主侧的 pipeline（本 profile 未提供）——客户端应按原文放行',
          })
        }
        // 用户「跳过并发送」/「取消」时，浏览器会 **abort 这次 fetch**。宿主必须跟着停——
        // 否则模型还在跑，跑完还会把包写进动态上下文（用户已经**明确拒绝**了这一轮的结果）。
        // 这里把"连接断了"变成一个真正的取消信号，一路传到 pipeline 与模型调用。
        const ac = typeof AbortController === 'function' ? new AbortController() : null
        if (ac) {
          const onGone = () => { try { ac.abort() } catch { /* 已经断了 */ } }
          // ⚠ 事件口要**逐个判空**：定点核对的桩里 req/res 只是带 headers 的普通对象，
          //   直接 `.on(...)` 会让整条路由抛 500（这正是本轮 control-api 测试抓到的那条）。
          try { if (typeof req.on === 'function') req.on('aborted', onGone) } catch { /* 桩没有事件口 */ }
          try {
            if (res && typeof res.on === 'function') {
              res.on('close', () => { if (!res.writableEnded) onGone() })
            }
          } catch { /* 同上 */ }
        }
        const r = await interpret({ sessionId: String(v.sessionId || ''), text: String(v.text || ''), messageId: v.messageId || null, generation: Number.isSafeInteger(v.generation) ? v.generation : null, signal: ac ? ac.signal : null })
        if (ac && ac.signal.aborted) {
          // 已经断开 ⇒ 不写、不回包（客户端那边世代号也已作废）
          return send(499, { ok: false, reason: 'aborted', note: '客户端已取消（跳过/取消），这一轮不产出' })
        }
        const out = (r && typeof r === 'object') ? r : { ok: false, reason: 'bad-hook-result' }
        // P11 修复（2026-09-26）：**token 用量必须随这次响应一起回去**。
        // 原先只 progressSet 进进度面，而进度面在拦截结束那一刻就被界面清掉了
        // （client 的轮询在 phase 不是 optimizing 时 setProg(null)）⇒ 用量收着了却永远送不到界面，
        // 界面恒显示占位符。这里从进度面读出来、随结果一起回，界面就能在审查态显示数字。
        const progForUsage = (typeof progress === 'function') ? progress(String(v.sessionId || '')) : null
        const usageOut = (progForUsage && progForUsage.usage && typeof progForUsage.usage === 'object') ? progForUsage.usage : null
        return send(out.ok === true ? 200 : 400, {
          ok: out.ok === true, reason: out.reason || null, runId: out.runId || null, status: out.status || null,
          packet: typeof out.packet === 'string' ? out.packet : '',
          // 2026-10-18：第 5 项（注入折叠卡片）的数据出口。真实注入文由 interpret 提供，缺省为 null。
          injected: typeof out.injected === 'string' ? out.injected.slice(0, 4000) : null,
           englishMode:out.englishMode===true,outgoingText:typeof out.outgoingText==='string'?out.outgoingText:null,translation:out.translation||null,
          understood: out.understood === true, noAddition: out.noAddition === true,
          understanding: out.understanding || null, support: out.support || null,
          chars: typeof out.chars === 'number' ? out.chars : 0,
          ms: typeof out.ms === 'number' ? out.ms : null, timings: out.timings || null,
          usage: usageOut,
          usageTotal: (usageOut && typeof usageOut.total === 'number') ? usageOut.total : null,
          // 无出处条目数（缺值 = null = "未记录"，界面不许拿 0 冒充"没有"）
          unsourced: typeof out.unsourced === 'number' ? out.unsourced : null,
          // P11：这一轮用的是哪条模型路由（`observed` / `session` / `host-default` / `host-default-first`）。
          // 界面据此对"兜底"明说一句——**不许把兜底模型当成用户会话的模型**静默使用。
          route: typeof out.route === 'string' ? out.route : null,
          gate: typeof out.gate === 'string' ? out.gate : null,
        })
      }
      if (method === 'POST' && path === API_PREFIX + '/packet') {
        // P11：审查态里用户**改过的正文**就是本轮要注入的包（空串 = 清掉这一轮的包）。
        // 与 `/interpret` 的区别：这里不跑模型，只把"这一轮注入什么"按用户的意思定下来。
        const body = await readBody(req)
        if (!body.ok) return send(400, { ok: false, reason: body.reason })
        const v = body.value || {}
        if (typeof setPacket !== 'function') {
          return send(501, { ok: false, reason: 'not-implemented', note: '本 profile 未接上 pipeline，改包无法生效' })
        }
        const r = await setPacket({ sessionId: String(v.sessionId || ''), runId: v.runId || null, generation: Number.isSafeInteger(v.generation) ? v.generation : null, disposition: v.disposition || null, originalText: String(v.originalText || ''), outgoingText: String(v.outgoingText || ''), text: String(v.text == null ? '' : v.text) })
        const out = (r && typeof r === 'object') ? r : { ok: false, reason: 'bad-hook-result' }
        return send(out.ok === true ? 200 : 400, { ok: out.ok === true, reason: out.reason || null, runId: out.runId || null, chars: typeof out.chars === 'number' ? out.chars : 0,packet:typeof out.packet==='string'?out.packet:null })
      }
      if(method==='GET'&&path===API_PREFIX+'/english-input'){const sid=String(query.get('session')||'').trim();if(!sid)return send(400,{ok:false,reason:'session-required'});return send(200,{ok:true,value:typeof englishGet==='function'?englishGet(sid):null})}
      if(method==='GET' && path===API_PREFIX+'/inference-runs'){
        const sid=String(query.get('session')||'').trim()
        if(!sid)return send(400,{ok:false,reason:'session-required'})
        return send(200,{ok:true,runs:typeof inferenceList==='function'?inferenceList(sid):[]})
      }
      if(method==='GET' && path===API_PREFIX+'/inference-run'){
        const sid=String(query.get('session')||'').trim(),run=String(query.get('run')||'').trim(),call=String(query.get('call')||'').trim()
        if(!sid||!run)return send(400,{ok:false,reason:'session-and-run-required'})
        const value=typeof inferenceGet==='function'?inferenceGet(sid,run,call||null,{text:query.get('text'),reasoning:query.get('reasoning'),input:query.get('input')==='1'}):null
        return send(value?200:404,{ok:!!value,value,reason:value?null:'run-not-found'})
      }
      if(method==='POST' && path===API_PREFIX+'/inference-cancel'){
        const body=await readBody(req)
        if(!body.ok)return send(400,{ok:false,reason:body.reason})
        const sid=String(body.value?.sessionId||''),run=String(body.value?.runId||'')
        // run 省略 ⇒ 按会话取消（跳过优化时前端只知道会话）
        if(!sid)return send(400,{ok:false,reason:'session-required'})
        const value=typeof inferenceCancel==='function'?inferenceCancel(sid,run):{ok:false,reason:'not-ready'}
        return send(value.ok?200:400,value)
      }
      if(method==='GET'&&path===API_PREFIX+'/advisor-delivery'){
        const sid=String(query.get('session')||'').trim(),rawSeq=query.get('seq'),seq=Number(rawSeq)
        if(!/^[A-Za-z0-9._:@-]{1,240}$/.test(sid)||rawSeq===null||rawSeq.trim()===''||!Number.isSafeInteger(seq)||seq<0)return send(400,{ok:false,reason:'session-and-event-seq-required'})
        return send(200,typeof advisorDelivery==='function'?await advisorDelivery(sid,seq):{ok:true,sessionId:sid,seq,status:'unavailable',checks:[],counts:{},limitations:['delivery-status-unavailable'],completionClaimAllowed:false,scopeOnly:true})
      }
      if (method === 'GET' && path === API_PREFIX + '/advisor-progress') {
        const sid = String(query.get('session') || '').trim()
        const callId = String(query.get('call') || '').trim()
        const runId = String(query.get('run') || '').trim()
        if (!sid || (!callId && !runId)) return send(400, { ok: false, reason: 'session-and-call-required' })
        // `since`/`draftSince`：客户端已收到的字数 ⇒ 只回增量（高频轮询时不必每次传整段思考）。
        // 不给这两个参数就是原来的全量行为，老客户端不受影响。
        const since = query.get('since')
        const draftSince = query.get('draftSince')
        const draftRound = query.get('draftRound')
        const run = typeof advisorProgress === 'function' ? advisorProgress(sid, { callId, runId, since, draftSince, draftRound }) : null
        return send(200, { ok: true, run })
      }
      if (method === 'GET' && path === API_PREFIX + '/interpret-progress') {
        // P11：让"优化中"那几十秒看得见（阶段 + 流式正文尾部）。**只读、无副作用**；
        // 没在跑不是错误 ⇒ 回 `{ok:true, active:false}`（404 会让浏览器控制台报红）。
        const sid = String(query.get('session') || '').trim()
        if (!sid) return send(400, { ok: false, reason: 'session-required' })
        const p = (typeof progress === 'function') ? progress(sid) : { active: false }
        return send(200, { ok: true, ...(p && typeof p === 'object' ? p : { active: false }) })
      }
      if (method === 'GET' && path === API_PREFIX + '/packet') {
        // P11：读"这一轮注入的包"当前是什么（回退之后要把新的正文读回界面）。
        const sid = String(query.get('session') || '').trim()
        if (!sid) return send(400, { ok: false, reason: 'session-required' })
        if (typeof getPacket !== 'function') return send(501, { ok: false, reason: 'not-implemented', note: '本 profile 未接上 pipeline' })
        const text = String(getPacket({ sessionId: sid }) || '')
        return send(200, { ok: true, chars: text.length, packet: text })
      }
      if (method === 'GET' && path === API_PREFIX + '/injection') {
        // 「本次注入」记录：**来自插件自己的内存**，不读会话日志。
        //   ?id=<记录 id>  → 对话流卡片按命令事件里带的 id 取
        //   ?session=<sid> → 输入栏胶囊取"这个会话最近一条"
        const id = String(query.get('id') || '').trim()
        const sid = String(query.get('session') || '').trim()
        if (!id && !sid) return send(400, { ok: false, reason: 'id-or-session-required' })
        const row = typeof getInjection === 'function' ? getInjection(id ? { id } : { sessionId: sid }) : null
        return send(200, { ok: true, injection: row || null })
      }
      if (method === 'GET' && path === API_PREFIX + '/presets') {
        // 预设登记表（文案 ↔ id）：客户端据此把输入区按钮的文字翻成预设 id
        let r = { ok: false, presets: [], debug: { missing: true } }
        try { if (typeof getPresets === 'function') r = (await getPresets()) || r } catch (e) { r = { ok: false, presets: [], debug: { threw: String(e && e.message || e) } } }
        return send(200, { ok: r.ok === true, presets: Array.isArray(r.presets) ? r.presets : [], debug: r.debug || null })
      }
      if (method === 'GET' && path === API_PREFIX + '/preset') {
        // 预设闸门（2026-10-19）：客户端在**按下回车、开始优化之前**问一次。
        // 宿主这边优先问 sessionController 拿会话头（最新、最准），拿不到再用事件里记下的。
        const sid = String(query.get('session') || '').trim()
        if (!sid) return send(400, { ok: false, reason: 'session-required' })
        // light=1（客户端 0.5s 的探针）：跳过会话 inspect，只用事件表/pending 判"预设变了没有"，成本极低
        const lightProbe = String(query.get('light') || '') === '1'
        let headerPreset = null
        let debug = null
        try {
          if (!lightProbe && typeof inspectPreset === 'function') {
            const r = await inspectPreset(sid)
            // 新契约 { preset, debug }；老契约直接给字符串（兼容）
            if (r && typeof r === 'object' && 'preset' in r) { headerPreset = r.preset || null; debug = r.debug || null }
            else headerPreset = r || null
          }
        } catch { headerPreset = null }
        // 优先级：会话里切换过（事件）> 最近一次界面选择（先拨预设、后开会话）> 会话头
        // 2026-10-19 真机：会话头往往是创建时的默认值（ptc），而用户是在开始会话**之前**拨的预设。
        const eventPreset = typeof getPreset === 'function' ? (getPreset(sid) || null) : null
        const pending = typeof getPresetPending === 'function' ? getPresetPending() : null
        // ⚠ 2026-10-19 真机：pending 是"全局最近一次选择"，之前无条件优先 ⇒ **所有会话**都被判成 standard，疯狂弹窗。
        // 现在只在这两种情况下算数：
        //   ① 就是在这个会话里选的（pending.sid === sid）；
        //   ② 选的时候还没有会话（pending.sid 为空），且是 90 秒内的近期选择——并且用一次就消费掉，不会漏到别的会话。
        //   ③ 或者：这个会话是**在选完预设之后**才第一次出现的（= 新开的会话），且选择发生在 10 分钟内。
        //      这条是为了"先拨预设、后开会话"——那种会话的会话头仍然是默认值（ptc），只能靠这条认出来。
        // 会话头只有在"等于默认预设"时才不可信（默认值见 profile 的 agent-preset-registry.selectedDefault）。
        // 非默认的头（standard / cordis / wish…）是会话自己的真相，**不能被 pending 覆盖**——
        // 2026-10-19 真机就是 pending(ptc) 把老 standard 会话覆盖成 ptc，于是进入老会话不弹。
        const DEFAULT_PRESET = 'ptc'
        const headerIsDefault = !headerPreset || headerPreset === DEFAULT_PRESET
        const eventCount = debug && debug.inspect ? debug.inspect.eventCount : null
        const freshSession = typeof eventCount === 'number' ? eventCount <= 1 : false
        const seenAt = typeof sessionFirstSeen === 'function' ? sessionFirstSeen(sid) : null
        const recent10 = !!(pending && (Date.now() - Number(pending.at || 0) < 10 * 60 * 1000))
        const pendingForMe = !!(pending && (
          String(pending.sid || '') === sid
          || (recent10 && headerIsDefault && freshSession && seenAt && Number(seenAt) > Number(pending.at || 0))
        ))
        const pendingPreset = pendingForMe && pending.preset ? String(pending.preset) : null
        // 客户端把输入区按钮的**当前文案**带上来（label）：这是唯一能反映"用户眼前这个会话选了什么"的来源。
        // 磁盘上的会话头永远是 ptc（已核对 session.v4.jsonl），所以这条优先级最高。
        const label = String(query.get('label') || '').trim().slice(0, 40)
        let hintPreset = null
        if (label && typeof getPresets === 'function') {
          try {
            const reg = (await getPresets()) || {}
            const hit = (Array.isArray(reg.presets) ? reg.presets : []).find((p) => p.name === label || p.id === label)
            if (hit) hintPreset = hit.id
          } catch { hintPreset = null }
        }
        const preset = hintPreset || eventPreset
          || (headerPreset && headerPreset !== DEFAULT_PRESET ? headerPreset : null)
          || pendingPreset || headerPreset
        const presetSource = hintPreset ? 'label' : (eventPreset ? 'event' : (pendingPreset ? 'pending' : (headerPreset ? 'header' : 'unknown')))
        if (pendingPreset && !pending.sid && typeof clearPresetPending === 'function') {
          try { clearPresetPending() } catch { /* 消费失败就当没消费 */ }
        }
        // 这次"预设真的变了"的时间：客户端用它去重，避免自己维护基线（挂载时机不同会漏事件）
        const eventAt = typeof getPresetAt === 'function' ? getPresetAt(sid) : null
        const presetAt = eventAt || (pending && pending.at) || null
        const dismissed = typeof presetDismissed === 'function' ? presetDismissed() === true : false
        // 2026-10-19 用户确认口径：**只有非 Wish 且非 PTC 才提醒**（这两个预设本身就是推荐态）。
        // 注意：PTC 会话按此口径不会弹窗——那不是"没实现"，是设计如此（debug 里 preset 会有值）。
        const notice = preset && preset !== 'wish' && preset !== 'ptc' && !dismissed ? { preset } : null
        // via=watch 是"盯着输入区"的探测（打字每几百毫秒一次）⇒ 不进台账；只记真正的回车询问与调试查询
        const via = String(query.get('via') || 'direct')
        if (via !== 'watch') {
          traceApi({ k: 'preset', via, sid: sid.slice(0, 48), preset: preset || null, source: presetSource, presetAt, notice: notice ? notice.preset : null, dismissed })
        } else if (Date.now() - lastWatchTraceAt > 20000) {
          // 盯输入区的探测：20 秒最多留一条，用来确认"客户端到底有没有在看"
          lastWatchTraceAt = Date.now()
          traceApi({ k: 'preset-watch', sid: sid.slice(0, 48), preset: preset || null, source: presetSource, presetAt, notice: notice ? notice.preset : null })
        }
        const payload = { ok: true, preset: preset || null, notice, source: presetSource, presetAt }
        // ?debug=1 ⇒ 透出"宿主到底看到了什么"（真机上判断为什么没弹窗）
        if (String(query.get('debug') || '') === '1') {
          payload.debug = { inspect: debug, header: headerPreset, events: eventPreset, pending: pendingPreset,
            pendingRaw: pending ? { preset: pending.preset, sid: pending.sid || '', at: pending.at } : null,
            label: label || null, hintPreset,
            source: presetSource, dismissed }
        }
        return send(200, payload)
      }
      if (method === 'GET' && path === API_PREFIX + '/notice') {
        // 预设提示（2026-10-19）：非 Wish / PTC 预设时给客户端一条提示。
        const sid = String(query.get('session') || '').trim()
        if (!sid) return send(400, { ok: false, reason: 'session-required' })
        const row = typeof getNotice === 'function' ? getNotice({ sessionId: sid }) : null
        return send(200, { ok: true, notice: row || null })
      }
      // 客户端取证（2026-10-19）：弹窗"到底跑没跑、有没有抛错"必须能查，不然只能猜。
      if (method === 'POST' && path === API_PREFIX + '/client-log') {
        const body = await readBody(req)
        if (!body.ok) return send(400, { ok: false, reason: body.reason })
        const v = body.value || {}
        traceApi({
          k: 'client-log',
          event: String(v.event || '').slice(0, 40),
          sid: String(v.sid || '').slice(0, 48),
          preset: String(v.preset || '').slice(0, 24),
          detail: String(v.detail || '').slice(0, 200),
        })
        return send(200, { ok: true })
      }
      if (method === 'POST' && path === API_PREFIX + '/notice') {
        const body = await readBody(req)
        if (!body.ok) return send(400, { ok: false, reason: body.reason })
        const v = body.value || {}
        if (v.forever === true) {
          // 「以后不再显示」= 一条持久的用户设置（不是会话级），写盘失败要如实报。
          const r = writeSettings({ path: cfgPath, patch: { presetNoticeDismissed: true }, now: now() })
          if (!r || r.ok !== true) return send(500, { ok: false, reason: (r && r.reason) || 'settings-write-failed' })
          if (typeof clearNotices === 'function') clearNotices()
          return send(200, { ok: true, forever: true })
        }
        // 恢复显示（2026-10-23）：用户点了“以后不再显示”之后，得有一条**可逆**的路，
        // 否则提示一旦关掉就永远回不来（真机上就是这么丢的）。
        if (v.reset === true) {
          const rr = writeSettings({ path: cfgPath, patch: { presetNoticeDismissed: false }, now: now() })
          if (!rr || rr.ok !== true) return send(500, { ok: false, reason: (rr && rr.reason) || 'settings-write-failed' })
          return send(200, { ok: true, reset: true })
        }
        if (typeof clearNotice === 'function') clearNotice(String(v.session || ''))
        return send(200, { ok: true })
      }
      if (method === 'POST' && path === API_PREFIX + '/rollback') {
        const body = await readBody(req)
        if (!body.ok) return send(400, { ok: false, reason: body.reason })
        const kind = String((body.value || {}).kind || '')
        if (kind === 'disable') {
          const r = writeSettings({ path: cfgPath, patch: { assist: 'off' }, now: now() })
          // 与 `/settings` 同一条纪律：写盘成功就通知宿主按新档位处理（清掉不该再注入的包）
          let hook = null
          let hookError = null
          if (r.ok === true && typeof onSettingsWritten === 'function') {
            try { hook = onSettingsWritten({ patch: { assist: 'off' }, settings: normalizeSettings(r.after).settings }) }
            catch (e) { hookError = String((e && e.message) || e) }
          }
          return send(r.ok ? 200 : 500, { ok: r.ok, reason: r.reason || null, settings: normalizeSettings(r.after).settings, hook, hookError })
        }
        // P11：**包级回退**现在真能做——宿主侧每次写非空包都会把上一版压进历史（每会话 10 条）
        if (kind === 'packet') {
          if (typeof rollbackPacket !== 'function') {
            return send(501, { ok: false, reason: 'not-implemented', kind, note: '本 profile 未接上 pipeline，包级回退无法生效' })
          }
          const r = await rollbackPacket({ sessionId: String((body.value || {}).sessionId || ''), runId: (body.value || {}).runId || null })
          const out = (r && typeof r === 'object') ? r : { ok: false, reason: 'bad-hook-result' }
          return send(out.ok === true ? 200 : 400, { ok: out.ok === true, reason: out.reason || null, runId: out.runId || null, packet: typeof out.packet === 'string' ? out.packet : null, chars: out.chars || 0, remaining: out.remaining == null ? null : out.remaining })
        }
        // 条目级回退需要"每条意图的历史版本"，目前没有 —— **如实说没做**，不假装成功
        return send(501, { ok: false, reason: 'not-implemented', kind, note: '条目级回退需要条目级历史（当前只有包级历史），计划在 P9.4 之后（见 po06/P9-UI-PLAN.md）' })
      }
      return send(404, { ok: false, reason: 'unknown-endpoint', path, method })
    } catch (e) {
      return send(500, { ok: false, reason: 'handler-threw:' + String((e && e.message) || e) })
    }
  }
}

/** 注册到宿主（调用方负责放进 `ctx.effect` 生命周期）。 */
export function registerControlApi(ctx, opts) {
  const handler = createControlHandler(opts)
  return ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler })
}
