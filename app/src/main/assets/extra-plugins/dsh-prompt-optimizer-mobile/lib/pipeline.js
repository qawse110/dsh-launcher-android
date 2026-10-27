// A run computes one v3 result. The host owns publication after checking runId.
import { extractJson } from './interpreter.js'
import { OPTIMIZER_PROTOCOL_VERSION, parseOptimizerValue, renderOptimizerPacket } from './optimizer-protocol.js'

/** Interpret once and return the exact packet; handleInput owns atomic publication. */
export async function handleUserInput(adapter, session, input) {
  const trace = []
  const step = (name, data) => trace.push({ step: name, ...data })
  const finish = ({ ok, status, outcome, text = '', parsed = null, code, reason }) => ({
    ok, status, outcome, ...(code ? { code } : {}), ...(reason ? { reason } : {}), trace,
    packet: { ok, status, text, chars: text.length, protocolVersion: OPTIMIZER_PROTOCOL_VERSION,
      sections: [], dropped: parsed?.dropped || [], problems: reason ? [reason] : [],
      overBudget: false, overBy: 0, budget: null },
    optimizer: parsed?.optimizer || null,
    understanding: parsed?.understanding || null,
    support: parsed?.support || { mode: 'none' }, claims: [],
    protocolVersion: OPTIMIZER_PROTOCOL_VERSION,
    zeroAddition: status !== 'ready', warnings: parsed?.warnings || [],
  })
  const aborted = () => {
    step('abort', { reason: 'client-aborted' })
    return finish({ ok: false, status: 'aborted', outcome: 'aborted', reason: 'aborted' })
  }
  if (input.signal?.aborted) return aborted()

  const language = input.policy?.englishMode === true ? 'en' : input.policy?.englishMode === false ? 'zh' : input.language || adapter?.language || 'zh'
  let raw
  try {
    const snapshot = typeof adapter?.intentStateOf === 'function' ? adapter.intentStateOf(session) : null
    const state = snapshot == null ? null : structuredClone(stateForOptimizer(snapshot))
    raw = await input.interpret({
      userText: String(input.text ?? ''), state,
      sessionId: String(session.id), messageId: String(input.messageId),
      observations: input.observations, signal: input.signal,
    })
  } catch (error) {
    if (input.signal?.aborted || error?.name === 'AbortError') return aborted()
    const reason = String(error?.message || error)
    step('interpret', { ok: false, error: reason })
    return finish({ ok: false, status: 'failed', outcome: 'interpret-threw', reason })
  }
  step('interpret', { ok: true, chars: typeof raw === 'string' ? raw.length : null })
  if (input.signal?.aborted) return aborted()

  const extracted = raw && typeof raw === 'object' ? { ok: true, value: raw } : extractJson(raw)
  if (!extracted.ok) {
    step('parse', { ok: false, code: extracted.code, reason: extracted.reason })
    return finish({ ok: false, status: 'failed', outcome: String(raw ?? '').trim() ? 'parse-rejected' : 'empty-completion',
      code: extracted.code, reason: extracted.reason })
  }
  const parsed = parseOptimizerValue(extracted.value)
  if (extracted.recovered) parsed.warnings = [...(parsed.warnings || []),
    extracted.recovered === 'bracket-repair' ? 'json-bracket-repair:' + extracted.repairedBrackets : 'json-' + extracted.recovered]
  step('parse', { ok: parsed.ok, code: parsed.code || null, warnings: parsed.warnings || [], dropped: parsed.dropped || [] })
  if (!parsed.ok) return finish({ ok: false, status: 'failed', outcome: 'parse-rejected', code: parsed.code, reason: parsed.reason, parsed })

  const text = renderOptimizerPacket(parsed.optimizer, language)
  const status = text ? 'ready' : 'empty'
  step('render', { ok: true, status, chars: text.length, language })
  return finish({ ok: true, status, outcome: text ? 'committed' : 'understood', text, parsed })
}

/** Keep old machine suggestions out of the next optimizer's source snapshot. */
export function stateForOptimizer(state) {
  try {
    if (!state || !Array.isArray(state.items)) return state
    const kept = state.items.filter((item) => {
      if (!item || item.kind === 'proposal') return false
      const section = item.optimizerSection
      if (section === 'add' || section === 'scaffold' || section === 'ask') return false
      return !(item.provenance === 'machine' && section)
    })
    if (kept.length === state.items.length) return state
    return { ...state, items: kept, counts: { ...(state.counts || {}), items: kept.length } }
  } catch { return state }
}
