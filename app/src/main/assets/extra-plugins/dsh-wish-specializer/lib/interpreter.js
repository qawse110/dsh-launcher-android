// dsh-prompt-optimizer 0.6 · 解释层契约（用户原话 → 候选补丁）
//
// 这是**单次任务路径里唯一需要 LLM 的环节**。本文件只承载"契约"：
//   · 稳定的系统提示词（版本化）
//   · 用户消息构造
//   · 输出解析（容错）
//   · **来源可验证性检查**（见下）
//
// 核心机制 —— user_requirement 必须带"逐字引文"：
//   模型可以为用户要求建条目，但每条必须附 `quote`，且该引文必须是**用户原话的字面子串**。
//   这使"机器替用户发明要求"从"信任问题"变成"字符串比对问题"（可机械验证）。
//   它能允许的正常行为是：把原话**拆成原子要求**（每条都能指回原话某一段）；
//   它挡住的正是：把模型自己的推断写成用户要求。
//
// 纯函数：无 IO、无 LLM 调用、无宿主依赖。

import { SOURCE_KINDS } from './schema.js'
import { normalizeCollaboration } from './capability.js'
import { validateEnglishExcerpt } from './english-mode.js'
import { OPTIMIZER_CORE, OPTIMIZER_PROTOCOL_VERSION, buildOptimizerUserMessage, parseOptimizerValue } from './optimizer-protocol.js'

export const INTERPRETER_VERSION = OPTIMIZER_PROTOCOL_VERSION

/** 解释器可以产出的 op（其余一律拒绝）。 */
export const ALLOWED_OPS = Object.freeze([
  'add_item', 'set_phase', 'add_question',
  // P11 多轮：**销账**。用户 2026-09-21 真机反馈"第二轮还带着第一轮早已解决的问题"——
  // 因为解释层此前**只能加、不能销**，意图状态只增不减，于是旧问题每轮都被重新编译进包。
  'set_item_status',
])

/**
 * 解释层**只许把条目退掉**，不许把它们改回 active/pending。
 * "复活"旧条目会让状态在轮次之间来回摆，比"不能销"更糟（用户要的是轮次之间不互相污染）。
 */
export const INTERPRETER_RETIRE_STATUSES = Object.freeze(['superseded', 'retracted', 'stale'])

/** 解释器可以创建的条目类型（`user_requirement`/`user_decision` 需带逐字引文）。 */
export const INTERPRETER_KINDS = Object.freeze([
  'user_requirement', 'quality_interpretation', 'observed_fact',
  'implementation_option', 'proposal', 'unknown',
])

/** 单次解释最多产出的条目数（防止把短原话膨胀成文档）。 */
export const MAX_ITEMS = 12
/** 单条文本上限。 */
export const MAX_ITEM_CHARS = 300

// The editable core is short; the selected tier and output format are assembled exactly once.
export const SYSTEM_PROMPT = OPTIMIZER_CORE.zh

/**
 * 构造用户消息。
 * @param userText  用户原话（**逐字**）
 * @param state     当前 IntentState（可为 null）
 * @param extras    { sessionId, messageId, observations?: string[] }
 * @param context   会话上下文块（P10 步骤 2 的注入文本；空串 = **与旧行为逐字节相同**）
 */
export function buildUserMessage(input) {
  return buildOptimizerUserMessage(input)
}

/** 从模型输出里抽出 JSON（容忍 ```json 围栏与前后废话）。 */
/**
 * Bracket-balancing repair: fix a mismatched closer or append missing closers.
 * Only structural repair — it never invents content. Refuses half-written strings, so a
 * truncated response stays a failure instead of turning into a plausible-but-fake object.
 * Real case (2026-10-21): model closed `"ask":[…]` with `}`; the whole turn was discarded.
 */
export function repairJsonBrackets(raw) {
  const s = String(raw == null ? '' : raw)
  const stack = []
  let inStr = false, esc = false, out = '', touched = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inStr) { out += c; if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue }
    if (c === '"') { inStr = true; out += c; continue }
    if (c === '{' || c === '[') { stack.push(c === '{' ? '}' : ']'); out += c; continue }
    if (c === '}' || c === ']') {
      const want = stack.length ? stack[stack.length - 1] : null
      if (want && want !== c) { out += want; touched += 1; stack.pop(); i -= 1; continue }
      if (!want) { touched += 1; continue }
      stack.pop(); out += c; continue
    }
    out += c
  }
  if (inStr) return { ok: false, reason: 'unterminated-string' }
  const missing = stack.slice().reverse().join('')
  if (missing) { out += missing; touched += missing.length }
  return touched ? { ok: true, text: out, touched } : { ok: false, reason: 'already-balanced' }
}
export function extractJson(raw) {
  const text = String(raw == null ? '' : raw)
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1] : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return { ok: false, code: 'NO_JSON', reason: 'no JSON object found' }
  try {
    return { ok: true, value: JSON.parse(candidate.slice(start, end + 1)) }
  } catch (e) {
    const balanced = extractBalancedObject(candidate)
    if (balanced.ok) return { ok: true, value: balanced.value, recovered: 'balanced-scan' }
    // Structural repair is a **recorded** recovery, never silent: callers surface it as a warning.
    const repaired = repairJsonBrackets(candidate.slice(start))
    if (repaired.ok) {
      try { return { ok: true, value: JSON.parse(repaired.text), recovered: 'bracket-repair', repairedBrackets: repaired.touched } } catch { /* fall through to failure */ }
    }
    return { ok: false, code: 'BAD_JSON', reason: String((e && e.message) || e), repairRefused: repaired.reason || null }
  }
}

/**
 * 文本里**第一段配平**的 JSON 对象（字符串内部的 `{}` 不计数）。
 *
 * 为什么需要它（2026-10-12 真机）：`extractJson` 原本取「首个 `{` 到最后一个 `}`」，
 * 模型多写一段 JSON、或末尾多写一句带花括号的话，整段就解析不动。英文模式当时**直接抛错**，
 * 于是一次 9691 字符的响应让整轮辅助消失（只剩保真译文兜底）。
 * 配平扫描只认第一段完整对象，对「多段 JSON」「前后夹带散文」都成立。
 */
export function extractBalancedObject(raw) {
  const s = String(raw == null ? '' : raw)
  let depth = 0, start = -1, inStr = false, esc = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue }
    if (c === '"') { inStr = true; continue }
    if (c === '{') { if (depth === 0) start = i; depth += 1; continue }
    if (c === '}') {
      if (depth === 0) continue
      depth -= 1
      if (depth === 0 && start >= 0) {
        try { return { ok: true, value: JSON.parse(s.slice(start, i + 1)) } } catch { start = -1 }
      }
    }
  }
  return { ok: false, code: 'BAD_JSON', reason: 'no balanced JSON object found' }
}

/**
 * 英文模式读取解释层响应：**只做判定，绝不抛**。
 *
 * 真机教训（2026-10-12）：英文分支原在提取失败时 `throw new Error('english-interpretation-invalid-json')`，
 * 而抛出点在 `input.interpret` 回调内部 ⇒ 管线记 `interpret-threw` 并**立刻返回**，
 * 把「空产出有界重试」「宿主兜底」「台账归因」三层保护全部绕过：用户只看到
 * 「辅助未生成，本次只发送保真译文」，日志里也没有可修的线索。
 * 现在把判定交回调用方：可以重试一次，也可以降级返回原文让管线按既有规则继续处理。
 */
export function readEnglishInterpretation(raw) {
  const ex = extractJson(raw)
  if (!ex.ok) return { ok: false, code: ex.code, reason: String(ex.reason || '').slice(0, 200), textChars: String(raw == null ? '' : raw).length }
  return { ok: true, value: ex.value, ...(ex.recovered ? { recovered: ex.recovered } : {}) }
}

/**
 * 来源可验证性：`user_requirement` / `user_decision` 的 `quote`
 * 必须是**字面子串**——来自 `userText`，**或者**来自本轮喂给解释层的**上下文文本**。
 *
 * ⚠ 为什么加了"或"（用户 2026-09-21 的真机反馈）：短消息（例："测试"两个字）几乎无字可引，
 * 于是候选全被这里判为"引文不成立" ⇒ 补丁为空 ⇒ `outcome:noop` ⇒ 界面报 `no-packet`。
 * 而**一两字结合上下文完全可能带大量信息**，所以判据要认"上下文里的依据"；同时**不许含糊**：
 * 来自上下文的条目会被标成 `machine`（机器从上下文推的），不会冒充"你说过"。
 * @returns 问题清单（空 = 通过）
 */
export function validateProvenance(ops, userText, contextText, stateText) {
  const problems = []
  const text = String(userText == null ? '' : userText)
  const ctx = String(contextText == null ? '' : contextText)
  // 已存档的状态正文（`【已知意图状态】`里那些条目的正文与 rationale）。
  // ⚠ 为什么要有这一路（2026-09-21 真机）：坦克会话第三轮里模型**确实**发了 11 条销账，
  // 但引文是它自己的转述（"两个问题都修好了"），既不在用户原话里、也不在本轮读入的上下文里
  // ⇒ 全被判"无依据"丢掉 ⇒ 旧条目一条没销掉，第三轮的包照样带着前两轮的东西。
  // 宿主**自己记录过**的条目正文属于"有据可查的材料"，据此销账不算凭空——但要标成 `state` 来源，
  // 面板与台账都看得见它是拿什么销的。
  const st = String(stateText == null ? '' : stateText)
  ops.forEach((op, i) => {
    // 销账（`set_item_status`）同样要有**逐字依据**：没有依据就销账 = 凭空把用户的要求划掉。
    // 这里只标证据（user / context / state / none），**不判整轮失败**——由 parseInterpreterOutput 逐条丢弃并记账。
    if (op && op.op === 'set_item_status') {
      const q = op.quote
      const has = typeof q === 'string' && q.trim().length > 0
      if (has && text.includes(q)) { op.evidence = 'user'; return }
      if (has && ctx && ctx.includes(q)) { op.evidence = 'context'; return }
      if (has && st && st.includes(q)) { op.evidence = 'state'; return }
      op.evidence = 'none'
      return
    }
    if (!op || op.op !== 'add_item' || !op.item) return
    const it = op.item
    const needsQuote = it.kind === 'user_requirement' || it.kind === 'user_decision'
    const quote = it.quote
    const hasQuote = typeof quote === 'string' && quote.trim().length > 0
    if (!hasQuote) {
      if (needsQuote) {
        problems.push(`ops[${i}] ${it.kind} ${it.id}: missing quote (verbatim excerpt of the user's text or the read context)`)
      }
      return
    }
    // ⚠ 2026-09-21 扩到**所有**带引文的条目（原来只标 human-only 两种）：
    // ① `quoteSource` 决定 provenance（上下文来的**不许冒充"你说过"**），只标两种会让
    //    `observed_fact` 这类"从读到的材料推出来"的条目失去标记；② 下方的来源引用归一
    //    要靠它判断"这条引文是不是真在宿主给过的材料里"。
    if (text.includes(quote)) { it.quoteSource = 'user'; return }
    if (ctx && ctx.includes(quote)) { it.quoteSource = 'context'; return }
    // 引文两边都对不上：human-only 是硬错；其余**留痕**（`unverifiable`）交给解析层**丢条目**，
    // 绝不因为它编得含糊就放行成"有依据的机读结论"。
    it.quoteSource = 'unverifiable'
    if (needsQuote) {
      problems.push(`ops[${i}] ${it.kind} ${it.id}: quote is not a verbatim substring of the user's text or the read context`)
    }
  })
  return problems
}

/**
 * 解析并校验模型输出，产出可交给 reducer 的候选 patch。
 * @returns {{ok:true, patch:object, warnings:string[]}} | {{ok:false, code:string, reason:string, problems?:string[]}}
 */
export function parseInterpreterOutput(raw, { userText, contextText, stateText, sessionId, messageId, baseRevision, baseInputRevision, causeId,englishMode=false,translatedText=null }) {
  const ex = extractJson(raw)
  if (!ex.ok) return { ok: false, code: ex.code, reason: ex.reason, ...(ex.repairRefused ? { repairRefused: ex.repairRefused } : {}) }
  const obj = ex.value
  // v3 is adapted by the host, without legacy item truncation or user-authority promotion.
  if (obj && typeof obj === 'object' && Object.hasOwn(obj, 'intent')) {
    const parsed = parseOptimizerValue(obj, { sessionId, messageId, baseRevision, baseInputRevision, causeId })
    if (ex.recovered === 'bracket-repair') {
      // Structural repair is recorded, never silent: the caller and the ledger can see it.
      parsed.warnings = [...(parsed.warnings || []), 'json-bracket-repair:' + ex.repairedBrackets]
      parsed.recovered = ex.recovered
    }
    return parsed
  }
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.ops)) {
    return { ok: false, code: 'BAD_SHAPE', reason: 'expected {"ops":[...]}' }
  }
  const warnings = []
  const collaboration = normalizeCollaboration(obj)
  const claims = []
  const truncatedItems = []      // 超过单轮上限被截断丢弃的条目（并进 dropped 记账）
  const ops = []
  let itemCount = 0

  for (const rawOp of obj.ops) {
    if (!rawOp || typeof rawOp !== 'object' || typeof rawOp.op !== 'string') {
      return { ok: false, code: 'BAD_OP', reason: 'op must be an object with a string op field' }
    }
    if (!ALLOWED_OPS.includes(rawOp.op)) {
      return { ok: false, code: 'OP_NOT_ALLOWED', reason: `interpreter may not emit op "${rawOp.op}"` }
    }
    if (rawOp.op === 'add_item') {
      const it = rawOp.item
      if (!it || typeof it !== 'object') return { ok: false, code: 'BAD_ITEM', reason: 'add_item requires item' }
      if (!INTERPRETER_KINDS.includes(it.kind)) {
        return { ok: false, code: 'KIND_NOT_ALLOWED', reason: `interpreter may not create kind "${it.kind}"` }
      }
      if (typeof it.text !== 'string' || it.text.trim().length === 0) {
        return { ok: false, code: 'BAD_ITEM', reason: `item ${it.id}: empty text` }
      }
      if (it.text.length > MAX_ITEM_CHARS) {
        const trimmed = it.text.slice(0, MAX_ITEM_CHARS)
        warnings.push(`item ${it.id}: text truncated to ${MAX_ITEM_CHARS} chars`)
        it.text = trimmed
      }
      // 引文不外传进状态：状态里只留正文与 rationale。
      // ⚠ `provenance:'machine'`（上下文来的条目**不许冒充"你说过"**）**必须等 `validateProvenance` 跑完再标**：
      // 那个函数才写下 `quoteSource`。这里原来就标，等于拿一个当时还不存在的字段做判断 ⇒ 该标记**从未生效**
      // （2026-09-21 复查发现的真机缺陷：从读入材料里推出来的条目会看起来像"你说过的"）。补标见下方 provenance 之后。
      const { quote, ...rest } = it
      if (typeof quote === 'string') rest.sourceQuote = quote
      // 作用域字段的**语义归一**（真机 2026-09-22，用户"思考完成之后 no-packet"的第二条真因）：
      //   台账 `dryRun:fail(BAD_SCHEMA | ops[3].item: scope turn is only valid on user_requirement /
      //   user_decision; ops[4].item: …; ops[5].item: …)` ⇒ **整份补丁作废、包 0 字**。
      //   模型是照着系统提示词里的示例写 `"scope":"turn"` 的（那条示例本来就带 turn），
      //   顺手抄到了 `quality_interpretation` / `unknown` 上 —— 而这两个类别写成 turn **没有任何语义**
      //   （turn 只对"用户指令"有意义；机器推出来的条目本来就是本轮的）。
      //   与"一条写坏的来源不该弄死整轮"（见下方来源引用归一）同一条纪律：
      //   **去掉这个无意义的字段并记账**，条目本身照常入包；而不是让一个装饰性字段把整轮弄死。
      if (rest.scope === 'turn' && !(rest.kind === 'user_requirement' || rest.kind === 'user_decision')) {
        warnings.push(`item ${String(rest.id || '')}: scope "turn" ignored on kind ${String(rest.kind || '')}`
          + '（该字段只对 user_requirement / user_decision 有意义；去掉它，条目照常入包）')
        delete rest.scope
      }
      itemCount += 1
      if (itemCount > MAX_ITEMS) {
        // ⚠ 判据更新（2026-09-22）：旧行为是 `return {ok:false, code:'TOO_MANY_ITEMS'}` —— **整轮作废、包 0 字**。
        //   真机台账里有 2 条（模型一口气写了 13+ 条）。上限的用途是"给包封顶"，不是"惩罚模型写多了"：
        //   与本文件其它判据同一纪律（撞 id / 来源引用 / 引文不成立）——**单点不得废整轮**。
        //   现在改成：**保留前 MAX_ITEMS 条 + 记账截断**，后面的条目丢弃并写进 warnings 与 dropped。
        warnings.push(`ops truncated: kept first ${MAX_ITEMS} items, dropped ${String(rest.id || '')} and any later ones`)
        truncatedItems.push({ id: String(rest.id || ''), kind: String(rest.kind || ''), reason: `超过单轮上限 ${MAX_ITEMS} 条 ⇒ 截断丢弃（整轮照常成包）` })
        break
      }
      ops.push({ op: 'add_item', item: rest })
    } else {
      ops.push(rawOp)
    }
  }

  // ⚠ 引文判据**只标记、不再整轮作废**（真机回归 2026-09-22：用户发 "A"，思考完成后面板报 `no-packet`）。
  //   台账三条同形：`parse:fail(UNVERIFIABLE_PROVENANCE | ops[1] user_requirement …：quote is not a verbatim
  //   substring of the user's text or the read context)` —— 模型把引文写成了**英文转述**，
  //   于是"一条对不上 ⇒ 整轮一个包都产不出来"。这与来源引用那条纪律应当一致：**逐条丢弃并记账**，
  //   剩下的条目照常成包；只有"全被丢"才退化成 noop（面板会显示"这一轮没有产出"）。
  //   底线不动：human-only 的条目**仍然必须有逐字依据**，没依据就丢，绝不放行成"你说的"。
  const provenance = validateProvenance(obj.ops, userText, contextText, stateText)
  const unverifiable = new Set()
  for (let i = 0; i < obj.ops.length; i += 1) {
    const rawOp = obj.ops[i]
    const it = rawOp && rawOp.item
    if (!it) continue
    const humanOnly = it.kind === 'user_requirement' || it.kind === 'user_decision'
    const noQuote = typeof it.quote !== 'string' || it.quote.trim().length === 0
    if (it.quoteSource === 'unverifiable' || (humanOnly && noQuote)) unverifiable.add(i)
  }

  // 6) provenance 之后的补标：`quoteSource` 到这一刻才存在（见上面的顺序说明）。
  for (let i = 0; i < obj.ops.length; i += 1) {
    const rawOp = obj.ops[i]
    const built = ops[i]
    if (!rawOp || rawOp.op !== 'add_item' || !rawOp.item || !built || built.op !== 'add_item') continue
    if (rawOp.item.quoteSource === 'context') built.item.provenance = 'machine'
  }

  // 7) 来源引用归一 —— 只补**宿主确实知道**的事实，其余**逐条丢弃并记账**。
  //
  // 为什么需要它（用户真机 2026-09-21）：开着「只读工具」时模型会写 `kind:'tool'` / `kind:'file'`，
  // 可 `toolCallId` / `uri` 只有宿主才有 ⇒ schema 判 BAD_SCHEMA ⇒ **整份补丁作废**，
  // 其它合法条目陪葬（台账 `outcome:reducer-rejected dryRun:fail(BAD_SCHEMA)`）。
  // 一条写坏的来源不该有能力弄死整轮；而"补"也不能靠编，只认两件可机械核对的事：
  //   · 引文逐字来自**用户这条原话** ⇒ 可以把 `human` 引用的 `messageId` 补成这一轮的真实 messageId；
  //   · 引文逐字来自**本轮读入的上下文** ⇒ 如实改记成"模型从给定材料推导"（`kind:'model'`）。
  // 两者都不成立时**丢弃这一条**（记账进 `dropped`，不静默）。
  const dropped = []
  const keptOps = []
  for (let oi = 0; oi < ops.length; oi += 1) {
    const built = ops[oi]
    // 引文对不上（或 human-only 缺引文）⇒ **只丢这一条**（见上面那段"只标记不整轮作废"）。
    if (built.op === 'add_item' && unverifiable.has(oi)) {
      const it0 = built.item || {}
      dropped.push({
        id: String(it0.id || ''), kind: String(it0.kind || ''),
        reason: '引文不是用户原话/读入上下文里的逐字片段（或 human-only 缺引文）⇒ 丢弃该条，不放行成"你说的"',
      })
      continue
    }
    if (built.op === 'set_item_status') {
      // 销账：① 只许退，不许复活（active/pending 一律不收）；② 必须有逐字依据。
      // 不满足就**只丢这一条**（记账），与来源引用同一条纪律——一条不合法的销账不该弄死整轮。
      const status = String(built.status || '')
      if (!INTERPRETER_RETIRE_STATUSES.includes(status)) {
        dropped.push({ id: String(built.id || ''), kind: 'retire', reason: '解释层只能把条目退成 superseded/retracted/stale，收到：' + (status || '(空)') })
        continue
      }
      if (built.evidence !== 'user' && built.evidence !== 'context' && built.evidence !== 'state') {
        dropped.push({ id: String(built.id || ''), kind: 'retire', reason: '销账没有逐字依据（引文须来自用户本轮原话、本轮读入的上下文，或【已知意图状态】里已记录的条目正文）' })
        continue
      }
      // 引文不外传进状态：只留 id 与目标状态
      keptOps.push({ op: 'set_item_status', id: String(built.id), status })
      continue
    }
    if (built.op !== 'add_item') { keptOps.push(built); continue }
    const it = built.item
    const humanOnly = it.kind === 'user_requirement' || it.kind === 'user_decision'
    const fromUser = it.provenance !== 'machine'
    if (humanOnly && typeof it.sourceQuote === 'string') {
      claims.push({ id: it.id, quote: it.sourceQuote, interpretation: it.text, source: fromUser ? 'user' : 'context', messageId: String(messageId || '') })
      if (!fromUser) {
        dropped.push({ id: it.id, kind: it.kind, reason: '上下文推导只保留为机器理解，不写成本轮用户明确要求' })
        continue
      }
      // 正文怎么定，取决于**解释层用哪种语言跑**：
      //   · 英文模式：模型给回的 text 是英文，而状态里的要求必须是**原话语言** ⇒ 正文回到 sourceQuote，
      //     英文那份走 englishText 只作注入口径（关掉英文模式后状态仍然可读、可审计）。
      //   · 普通模式：保留模型**原子化后的表述**（流水线契约），但加一道**信息量下限**，
      //     不许「引一个词就写成一段要求」；触发时降级为机器理解，正文仍在 claims 里可回查。
      const englishQuote = obj.ops[oi]?.item?.englishQuote
      const normalized = v => String(v).toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!?。]+$/, '')
      if (englishMode) {
        if (validateEnglishExcerpt(it.sourceQuote, englishQuote) && (!translatedText || normalized(translatedText).includes(normalized(englishQuote)))) it.englishText = englishQuote
        else warnings.push('item ' + it.id + ': English excerpt missing or literal check failed; original remains stored')
        it.text = it.sourceQuote
      } else {
        const quoteLen = String(it.sourceQuote).length
        const textLen = String(it.text || '').length
        // 两个条件同时成立才算过薄：① 正文是引文的 3 倍以上；② 净增超过 20 字。
        // 只用绝对阈值（曾写成 max(60, 3×)）会**放过最该拦的形状**：2 字引文撑起 50 字要求
        // 因为不足 60 字而通过；只用比值又会把正常转述判死 ⇒ 两个一起用。
        if (textLen > quoteLen * 3 && textLen - quoteLen > 20) {
          dropped.push({ id: it.id, kind: it.kind, reason: '引文只有 ' + quoteLen + ' 字却撑起 ' + textLen + ' 字的要求（信息量不足）：降级为机器理解，不写成本轮用户明确要求' })
          warnings.push('item ' + it.id + ': quote too thin for the stated requirement; kept as machine interpretation only')
          continue
        }
        if (it.text !== it.sourceQuote) warnings.push('item ' + it.id + ': 正文是模型转述、引文逐字来自原话；两者都留存，正文不因引文而改写')
      }
    }
    const refs = Array.isArray(it.sourceRefs) ? it.sourceRefs : []
    const kept = []
    const refProblems = []
    for (const ref of refs) {
      if (!ref || typeof ref !== 'object' || Array.isArray(ref)) { refProblems.push('引用不是对象'); continue }
      const r = { ...ref }
      if (typeof r.sessionId !== 'string' || !r.sessionId) r.sessionId = String(sessionId || '')
      const kind = String(r.kind || '')
      if (!SOURCE_KINDS.includes(kind)) { refProblems.push('来源种类无效：' + (kind || '(空)')); continue }
      const missing = kind === 'tool' ? (typeof r.toolCallId !== 'string' || !r.toolCallId)
        : (kind === 'file' || kind === 'external') ? (typeof r.uri !== 'string' || !r.uri)
          : kind === 'human' ? (typeof r.messageId !== 'string' || !r.messageId)
            : false
      if (!missing) { kept.push(r); continue }
      if (kind === 'human' && fromUser && typeof messageId === 'string' && messageId) {
        // 引文是这条原话里的字面子串 ⇒ 宿主替它填上真实的 messageId（可机械核对，不是编）
        kept.push({ ...r, messageId })
        refProblems.push('补全 human.messageId（引文逐字来自本轮原话）')
        continue
      }
      if (!humanOnly && !fromUser) {
        // 引文逐字来自读入的上下文 ⇒ 如实记成"模型从给定材料推导"
        kept.push({ kind: 'model', sessionId: String(sessionId || '') })
        refProblems.push('改记 kind:model（引文来自本轮读入的上下文，工具标识宿主无法代填）')
        continue
      }
      refProblems.push('来源缺少宿主才知道的标识符（' + kind + '）且引文不足以证明，已丢弃')
    }
    if (kept.length === 0) {
      // 一条来源都没给：human-only 直接丢（不许无来源冒充用户要求）；
      // 机器条目**且**引文确实来自本轮读入的材料 ⇒ 如实记一条 kind:model 的来源，别把有用的条目丢了。
      if (!humanOnly && !fromUser) {
        it.sourceRefs = [{ kind: 'model', sessionId: String(sessionId || '') }]
        warnings.push('item ' + String(it.id || '') + ' 来源引用：模型未给来源，按其引文来自本轮读入材料记 kind:model')
        keptOps.push(built)
        continue
      }
      dropped.push({ id: String(it.id || ''), kind: String(it.kind || ''), reason: refProblems.join('；') || '没有可用的来源引用' })
      continue
    }
    it.sourceRefs = kept
    if (refProblems.length > 0) warnings.push('item ' + String(it.id || '') + ' 来源引用：' + refProblems.join('；'))
    keptOps.push(built)
  }

  if (keptOps.length === 0) {
    // 模型一条 op 都没给 ⇒ 保持原有契约（`no ops: nothing to add`），不要因为下面新加的丢弃逻辑改口径。
    // ⚠ 但要把"截断丢弃"也如实带出来：整轮不空的话，用户会以为"模型什么都没写"（真机 no-packet 的
    //   一条来源就是"写多了被整轮作废"，见上面 TOO_MANY_ITEMS 的判据更新）。
    return {
      ok: true,
      patch: null,
      ...collaboration, claims,
      warnings: ops.length === 0
        ? ['no ops: nothing to add']
        : [...warnings, ...dropped.map((d) => '丢弃条目 ' + d.id + '：' + d.reason)],
      dropped: [...dropped, ...truncatedItems],
    }
  }

  return {
    ok: true,
    ...collaboration, claims,
    warnings,
    dropped: [...dropped, ...truncatedItems],
    patch: {
      causeId: String(causeId || 'interpret'),
      baseRevision,
      baseInputRevision,
      sessionId,
      ops: keptOps,
    },
  }
}

/**
 * 便捷入口：解析 → 由 reducer 校验（不提交）。
 * 需要 reduce/validatePatch 时由调用方传入，避免本模块依赖 reducer 内部。
 */
export function dryRun(patch, state, reduceFn) {
  if (!patch) return { ok: true, noop: true }
  const r = reduceFn(state, patch)
  return r.ok ? { ok: true, state: r.state } : { ok: false, code: r.code, reason: r.reason }
}
