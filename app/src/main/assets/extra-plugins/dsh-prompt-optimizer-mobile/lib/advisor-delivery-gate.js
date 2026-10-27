// 交付闸门（2026-10-20 重构 4/4）：证据决定能不能交付，拿不到证据就**问用户**而不是死循环。
//
// 用户口径：
//   · 顾问验收的证据都 pass → 模型可以考虑交付；
//   · 有证据始终无法验收 → 调 ask 问用户（除非相关证据与目标影响不大 → 标注后放行）；
//   · 不许擅自死循环，也不许莫名直接交付。
//
// 本模块是**纯函数**：给定 report（checks 带 status 与可选 severity），回答"现在该怎么办"。
// 它不调用模型、不写文件、不做判断以外的事。

import { renderAskInstruction } from './ask-instruction.js'

export const DELIVERY_ACTIONS = Object.freeze(['deliver', 'fix', 'ask', 'deliver-with-note'])

/**
 * @returns {{action:string, failed:string[], unverified:string[], ask?:{question:string,options:Array<{label:string,value:string}>}}}
 */
/** 只有"验收形状"的报告才谈得上交付：有 checks，或 verdict 是 pass/gaps/unverified。 */
export function isVerificationShaped(report) {
  const checks = Array.isArray(report && report.checks) ? report.checks : []
  if (checks.length) return true
  return ['pass', 'gaps', 'unverified'].includes(String((report && report.verdict) || ''))
}

export function decideDelivery(report) {
  // An explicit request for the user's choice is not a delivery verdict.
  if (report?.verdict === 'need_user') {
    return {
      action: 'ask', context: 'user-decision', failed: [], unverified: [],
      ask: {
        question: report.ask?.question || report.summary || '请确认当前任务尚未确定的取舍。',
        options: Array.isArray(report.ask?.options) ? report.ask.options : [],
      },
    }
  }
  const checks = Array.isArray(report && report.checks) ? report.checks : []
  const failed = checks.filter((c) => c && c.status === 'failed')
  const unverified = checks.filter((c) => c && c.status === 'unverified')
  // 未通过 ⇒ 必须先改（改完再谈交付）
  if (failed.length) {
    return { action: 'fix', failed: failed.map((c) => String(c.criterion || '')).filter(Boolean), unverified: [] }
  }
  // 没有 checks 时按 verdict 兜底：顾问明说"验不了"就该问用户，别默认放行。
  if (!unverified.length) {
    const verdict = String((report && report.verdict) || '')
    if (verdict === 'unverified') {
      return {
        action: 'ask',
        failed: [],
        unverified: ['（顾问没有给出可核验的检查项）'],
        ask: {
          question: '顾问这次没有给出可核验的证据，没法确认能不能交付。你想怎么处理？',
          options: [
            { label: '接受风险，按现状交付', value: 'accept' },
            { label: '先去补证据', value: 'fix' },
            { label: '换一种可验证的验收口径', value: 'redefine' },
          ],
        },
      }
    }
    if (verdict === 'gaps') return { action: 'fix', failed: ['（顾问判定有缺口，但没有列出具体检查项）'], unverified: [] }
    return { action: 'deliver', failed: [], unverified: [] }
  }

  // 拿不到证据：只有"影响大"才问用户；impact/severity 缺省算 minor（不要为了保险把什么都升级成阻塞）
  const major = unverified.filter((c) => c.impact === 'major' || c.severity === 'major')
  const minor = unverified.filter((c) => !(c.impact === 'major' || c.severity === 'major'))
  if (major.length) {
    const names = major.map((c) => String(c.criterion || '')).filter(Boolean)
    return {
      action: 'ask',
      failed: [],
      unverified: names,
      ask: {
        question: '这几项拿不到证据，没法确认能不能交付：' + names.join('；') + '。你想怎么处理？',
        options: [
          { label: '接受风险，按现状交付', value: 'accept' },
          { label: '先补证据再交付', value: 'fix' },
          { label: '换一种可验证的验收口径', value: 'redefine' },
        ],
      },
    }
  }
  return { action: 'deliver-with-note', failed: [], unverified: minor.map((c) => String(c.criterion || '')).filter(Boolean) }
}

/** 把闸门结论渲染成给执行模型的一行话（assistant 直接读它决定下一步）。 */
export function renderDeliveryGate(decision, english = false) {
  if (!decision || !decision.action) return ''
  if (decision.action === 'fix') {
    return english
      ? '[Delivery gate] Not yet: these still fail — ' + decision.failed.join('; ')
      : '【交付判断】还不能交付：' + decision.failed.join('；') + ' 仍未通过。'
  }
  if (decision.action === 'ask') {
    const heading = decision.context === 'user-decision'
      ? (english ? '[User decision — ask first, this is not advice]' : '【需要用户决定 · 先问再继续，这不是建议】')
      : (english ? '[Delivery gate] Ask the user before delivery.' : '【交付判断】交付前先问用户。')
    const request = decision.ask || { question: (decision.unverified || []).join(english ? '; ' : '；'), options: [] }
    return heading + '\n' + renderAskInstruction([request], { english })
  }
  if (decision.action === 'deliver-with-note') {
    return english
      ? '[Delivery gate] Deliverable, but note what could not be verified: ' + decision.unverified.join('; ')
      : '【交付判断】可以交付，但要标注没验证到的部分：' + decision.unverified.join('；') + '。'
  }
  return english ? '[Delivery gate] Evidence is sufficient; delivery is allowed.' : '【交付判断】证据齐全，可以交付。'
}
