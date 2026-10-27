// 顾问的"声音"（2026-10-20 重构）：**两段式、512 token 上限、禁止施工图**。
//
// 用户给的模板（他是思想，不是死条文）：
//   [顾问的理解] 现在……，是因为……，所以你应当……
//   [具体建议]   1. ……  2. ……
//
// 三条硬约束：
//   ① 不许出现代码块、行内代码、命令行、数值参数、逐步操作序列——那是施工，不是点拨；
//   ② 不许把建议写成命令（"必须修"这种语气会让人以为它是新增要求）；
//   ③ 上限 512 token：超了先砍例子、再砍次要建议，**保住"病因 + 最关键一条"**。
// 开关关掉时调用方根本不会走到这里；这里只负责"有话说时怎么说"。

import { decideDelivery, renderDeliveryGate, isVerificationShaped } from './advisor-delivery-gate.js'
import { ASK_TOOL_NAME } from './ask-instruction.js'

export const ADVISOR_TOKEN_LIMIT = 512

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/g

/** 粗估 token（中文 ≈0.9/字，拉丁词 ≈1.3/词）。只用来守上限，不参与任何业务判断。 */
export function estimateTokens(text) {
  const s = String(text == null ? '' : text)
  const cjk = (s.match(CJK) || []).length
  const rest = s.replace(CJK, ' ')
  const words = rest.split(/\s+/).filter(Boolean).length
  return Math.ceil(cjk * 0.9 + words * 1.3)
}

/** 去施工图：代码块整段删掉，行内代码脱掉反引号，命令式前缀降级为陈述。 */
export function deBuild(text) {
  const src = String(text == null ? '' : text)
  // 中文里的裸标识符（summary / understandingOf / findings）同样是施工：真机实测会漏进来。
  // 只在"以中文为主"的文本里做，避免误伤英文正常单词。
  const cjk = (src.match(CJK) || []).length
  const ascii = (src.match(/[A-Za-z]/g) || []).length
  const chinese = cjk > 0 && ascii > 0 && cjk / (cjk + ascii) > 0.3
  return src
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`(ask_user_question)`/g, '$1') // The ask tool is an action handoff, not build code.
    .replace(/`[^`]*`/g, ' ')   // 行内代码＝技术标识符：连内容一起丢，别让 "别用 XxxMaterial" 这种句子漏进来
    .replace(/\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g, ' ')   // camelCase
    .replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, word => word === ASK_TOOL_NAME ? word : ' ')        // snake_case
    // ⚠ 不要再"中文里删所有英文词"：真机把 "verdict = pass" 挖成 "= /"，残句比术语更糟。
    .replace(/^\s*(?:必须修|必须执行|必须|务必)[:：]?\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function clip(s, n) {
  const t = deBuild(s)
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

/** 从 report 里抽出"理解句"：优先 summary；没有就退回 verdict 的人话。 */
function understandingOf(report) {
  const summary = clip(report.summary || report.understanding || '', 220)
  if (summary) return summary
  const verdict = String(report.verdict || '')
  if (verdict === 'pass' || verdict === 'satisfied') return '这一轮的证据能支撑已声明的检查项，可以按当前方向收口。'
  if (verdict === 'gaps') return '还有明确的缺口没补上，现在收口会把这部分风险带进交付。'
  return ''
}

/** 抽出"具体建议"：失败的检查项 → 贡献条目 → findings，去重、限条数。 */
function adviceOf(report) {
  const out = []
  const push = (t) => {
    const body = clip(t, 120)
    if (!body) return
    if (out.some((x) => x === body)) return
    out.push(body)
  }
  const checks = Array.isArray(report.checks) ? report.checks : []
  for (const c of checks) {
    if (c && c.status === 'failed') push((c.criterion || '') + (c.action ? ' → ' + c.action : ''))
  }
  // ⚠ 必须**先整段剥掉围栏代码块再按行拆**：拆完再剥会把 ``` 标记拆散，代码行就漏进建议里。
  const contribution = String(report.contribution || '').replace(/```[\s\S]*?```/g, '\n')
  for (const it of contribution.split(/\n+/)) {
    const body = deBuild(it.replace(/^\d+[.、)]\s*/, '').replace(/^[-*•]\s*/, ''))
    if (body) push(body)
  }
  const findings = Array.isArray(report.findings) ? report.findings : []
  for (const f of findings) if (f && f.text) push(f.text)
  return out
}

/**
 * 渲染顾问块。返回 '' 表示"没话说"——调用方据此**整段不出现**（不是渲染一个空壳）。
 */
export function renderAdvisorVoice(report, { english = false } = {}) {
  if (!report || typeof report !== 'object') return ''
  const understanding = understandingOf(report)
  let advice = adviceOf(report)
  if (!understanding && advice.length === 0) return ''

  const head = english ? '[Advisor reading]' : '【顾问的理解】'
  const tail = english ? '[Concrete advice]' : '【具体建议】'
  const build = (u, list) => {
    const lines = []
    if (u) lines.push(head + '\n' + u)
    if (list.length) lines.push(tail + '\n' + list.map((x, i) => (i + 1) + '. ' + x).join('\n'))
    return lines.join('\n\n')
  }

  // 交付判断（证据表）：pass→可以交付；failed→先改；unverified 且影响大→让模型 ask 用户。
  // 方向/建议类报告（suggestion/continue/…）不谈交付——那正是"把顾问当闸门"的旧病。
  const gateLine = report.__noGate === true || (report.verdict !== 'need_user' && !isVerificationShaped(report))
    ? ''
    : renderDeliveryGate(decideDelivery(report), english)
  let text = [build(understanding, advice), gateLine].filter(Boolean).join('\n\n')
  // 超上限：先砍建议（从尾部），只剩一条还超就压理解句。
  while (estimateTokens(text) > ADVISOR_TOKEN_LIMIT && advice.length > 1) {
    advice = advice.slice(0, -1)
    text = [build(understanding, advice), gateLine].filter(Boolean).join('\n\n')
  }
  if (estimateTokens(text) > ADVISOR_TOKEN_LIMIT) {
    const short = clip(understanding, 120)
    text = [build(short, advice.slice(0, 1)), gateLine].filter(Boolean).join('\n\n')
  }
  return text
}
