// One current optimization per session. The final packet is stored once and is
// shared by the response, submission, context provider and injection card.
export function createOptimizationRuns() {
  const sessions = new Map()
  let serial = 0
  const current = run => !!run && sessions.get(run.sessionId) === run && !run.controller.signal.aborted
  const stop = run => { if (run && !run.controller.signal.aborted) run.controller.abort(); run?.detach?.() }
  const api = {
    begin(sessionId, runId, { signal = null, generation = null } = {}) {
      const sid = String(sessionId)
      const previous = sessions.get(sid)
      const id = String(runId || 'optimization-' + (++serial))
      if (previous?.runId === id) return previous
      if (previous?.retired?.has(id) || (previous && Number.isSafeInteger(previous.generation) && (!Number.isSafeInteger(generation) || generation <= previous.generation))) {
        const controller = new AbortController(); controller.abort()
        return { sessionId: sid, runId: id, status: 'cancelled', controller, result: null }
      }
      const retired = new Set([...(previous?.retired || []), ...(previous ? [previous.runId] : [])])
      const history = [...(previous?.history || []), ...(previous?.result?.packet ? [previous.result.packet] : [])].slice(-10)
      stop(previous)
      const run = { sessionId: sid, runId: id, controller: new AbortController(), status: 'running', result: null, submission: null, applied: null, history, retired, generation }
      const abort = () => { if (sessions.get(sid) === run) api.cancel(sid, run.runId) }
      if (signal) {
        signal.addEventListener('abort', abort, { once: true })
        run.detach = () => signal.removeEventListener('abort', abort)
      }
      sessions.set(sid, run)
      if (signal?.aborted) abort()
      return run
    },
    isCurrent: current,
    finish(run, result) {
      if (!current(run) || run.status !== 'running') return false
      run.detach?.()
      run.result = { ...result, runId: run.runId, packet: String(result.packet || '') }
      run.appliedMessageId = null; run.appliedSeq = null
      run.status = result.ok === false ? 'failed' : run.result.packet ? 'ready' : 'empty'
      return true
    },
    get(sessionId) { return sessions.get(String(sessionId)) || null },
    /** Packet is injectable only after it was applied to the message that carried it. */
    apply(sessionId, messageId, seq = null) {
      const run = sessions.get(String(sessionId))
      if (!run || !messageId || !['ready', 'empty', 'submitted'].includes(run.status)) return false
      run.appliedMessageId = String(messageId); run.appliedSeq = seq == null ? null : Number(seq); run.appliedAt = Date.now()
      return true
    },
    clearApplied(sessionId) {
      const run = sessions.get(String(sessionId))
      if (!run) return false
      run.appliedMessageId = null; run.appliedSeq = null; run.appliedAt = null
      return true
    },
    /** Injection reads this: a packet for any other turn is not this turn's packet. */
    packetForTurn(sessionId, messageId) {
      const run = sessions.get(String(sessionId))
      if (!run || !['ready', 'submitted'].includes(run.status)) return ''
      if (!messageId || String(run.appliedMessageId || '') !== String(messageId)) return ''
      return run.result?.packet || ''
    },
    packet(sessionId) {
      const run = sessions.get(String(sessionId))
      return run && ['ready', 'empty', 'submitted'].includes(run.status) ? run.result?.packet || '' : ''
    },
    cancel(sessionId, runId = null) {
      let run = sessions.get(String(sessionId))
      if (runId && run && run.runId !== String(runId)) return { ok: false, reason: 'superseded-input' }
      if (!run && runId) run = api.begin(sessionId, runId)
      if (run) { stop(run); run.status = 'cancelled'; run.result = null; run.submission = null; run.applied = null; run.appliedMessageId = null; run.appliedSeq = null }
      return { ok: true }
    },
    // Explicit submission is the only way the observer can claim a packet/card.
    submit(sessionId, { runId = null, generation = null, text = '', disposition = 'send', originalText = '', outgoingText = '' } = {}) {
      const sid = String(sessionId)
      let run = sessions.get(sid)
      if (runId && run && run.runId !== String(runId)) {
        if (disposition === 'send' || !Number.isSafeInteger(generation) || (Number.isSafeInteger(run.generation) && generation <= run.generation) || run.retired.has(String(runId))) return { ok: false, reason: 'superseded-input' }
        run = api.begin(sid, runId, { generation })
      }
      if (!run && runId && disposition === 'cancel') run = api.begin(sid, runId, { generation })
      if (disposition === 'cancel') return api.cancel(sid, runId)
      if (run?.applied) return { ok: false, reason: 'already-submitted' }
      if (disposition === 'send' && run?.status === 'submitted') {
        if (run.result?.packet !== String(text)) return { ok: false, reason: 'submission-already-prepared' }
        return { ok: true, runId: run.runId, packet: run.result.packet, chars: run.result.packet.length }
      }
      if (disposition === 'skip') {
        if (!run) run = api.begin(sid, runId, { generation })
        stop(run)
        run.status = 'skipped'; run.result = null
      } else {
        if (runId && (!run || !['ready', 'empty', 'submitted'].includes(run.status))) return { ok: false, reason: 'optimization-not-ready' }
        if (!run) run = api.begin(sid, runId, { generation })
        run.detach?.()
        run.result = { ...(run.result || {}), ok: true, runId: run.runId, packet: String(text) }
        run.status = 'submitted'
      }
      run.submission = { runId: run.runId, packet: disposition === 'skip' ? '' : String(text), skip: disposition === 'skip', originalText: String(originalText), outgoingText: String(outgoingText || originalText) }
      run.applied = null
      return { ok: true, runId: run.runId, packet: run.submission.packet, chars: run.submission.packet.length }
    },
    consume(sessionId, outgoingText) {
      const run = sessions.get(String(sessionId))
      if (!run?.submission || typeof outgoingText !== 'string') return null
      if (String(run.submission.outgoingText).trim() !== outgoingText.trim()) return null
      const value = run.submission
      run.submission = null; run.applied = value
      return value
    },
    bypass(sessionId) {
      const run = sessions.get(String(sessionId))
      return !!(run?.submission?.skip || run?.applied?.skip)
    },
    revise(sessionId, runId, text) {
      const run = sessions.get(String(sessionId))
      if (!run || run.runId !== runId || run.applied || !['ready', 'empty', 'submitted'].includes(run.status)) return { ok: false, reason: 'superseded-input' }
      run.result = { ...run.result, packet: String(text) }; run.status = text ? 'ready' : 'empty'; run.submission = null
      return { ok: true, runId, packet: String(text), chars: String(text).length }
    },
    // Compatibility for diagnostics; never invokes a renderer.
    store(sessionId, text) {
      const run = api.begin(sessionId, 'manual-' + (++serial))
      api.finish(run, { ok: true, packet: String(text || '') })
    },
    clear() { const n = sessions.size; for (const run of sessions.values()) stop(run); sessions.clear(); return n },
    size() { return [...sessions.values()].filter(run => api.packet(run.sessionId)).length },
  }
  return api
}
