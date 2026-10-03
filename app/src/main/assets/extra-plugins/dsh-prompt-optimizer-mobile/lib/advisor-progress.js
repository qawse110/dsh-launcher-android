import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const ADVISOR_UI_LIMIT = 80
export const ADVISOR_THINK_LIMIT = 24000
export const ADVISOR_DRAFT_LIMIT = 8000
const copy = value => JSON.parse(JSON.stringify(value))
const terminal = new Set(['done', 'failed', 'cancelled', 'timeout', 'interrupted'])

// UI-only state. Never inject provider reasoning into the working model's messages.
export function createAdvisorProgress({ home, now = Date.now, limit = ADVISOR_UI_LIMIT } = {}) {
  const records = new Map()
  const file = home ? join(home, 'po06-advisor-ui.json') : null
  if (file && existsSync(file)) {
    try {
      const rows = JSON.parse(readFileSync(file, 'utf8'))
      for (const row of Array.isArray(rows) ? rows.slice(-limit) : []) {
        if (!row?.runId || !row.sessionId) continue
        if (!terminal.has(row.stage)) { row.stage = 'interrupted'; row.finishedAt = now(); row.reason = 'host-restarted' }
        records.set(row.runId, row)
      }
    } catch { /* A bad UI cache must not break model execution. */ }
  }
  const save = () => {
    if (!file) return
    try {
      mkdirSync(home, { recursive: true })
      const temp = file + '.tmp'
      writeFileSync(temp, JSON.stringify([...records.values()]), 'utf8')
      renameSync(temp, file)
    } catch { /* best effort; memory remains authoritative for this process */ }
  }
  const trim = (target = limit) => {
    for (const [key, value] of records) {
      if (records.size <= target) break
      if (terminal.has(value.stage)) records.delete(key)
    }
  }
  return {
    start({ sessionId, callId, mode, question, timeoutMs, scope = 'general', focus = '' }) {
      trim(limit - 1)
      if (records.size >= limit) return null
      const runId = randomUUID()
      const row = { runId, sessionId: String(sessionId), callId: String(callId || ''), mode, reviewScope: scope, focus: String(focus).slice(0,500),
        timeoutMs: Number(timeoutMs) > 0 ? Math.round(Number(timeoutMs)) : null,
        question: String(question || '').slice(0, 4000), startedAt: now(), updatedAt: now(), stage: 'prepare',
        reasoning: '', draft: '', reasoningChars: 0, draftChars: 0, reasoningTruncated: false, draftTruncated: false,
        activities: [], round: 0, toolCalls: 0, result: null }
      records.set(runId, row); save(); return runId
    },
    patch(runId, patch) {
      const row = records.get(runId)
      if (!row || terminal.has(row.stage)) return
      Object.assign(row, patch, { updatedAt: now() })
    },
    delta(runId, delta) {
      const row = records.get(runId)
      if (!row || terminal.has(row.stage)) return
      for (const [field, cap] of [['reasoning', ADVISOR_THINK_LIMIT], ['draft', ADVISOR_DRAFT_LIMIT]]) {
        const text = String(delta?.[field === 'draft' ? 'text' : field] || '')
        if (!text) continue
        row[field + 'Chars'] += text.length
        row[field] = (row[field] + text).slice(-cap)
        row[field + 'Truncated'] = row[field + 'Chars'] > cap
      }
      row.updatedAt = now()
    },
    event(runId, event) {
      const row = records.get(runId)
      if (!row || terminal.has(row.stage)) return
      if (event.kind === 'round') {
        row.round = event.round
        row.stage = event.final ? 'conclude' : 'thinking'
        row.draft = ''; row.draftChars = 0; row.draftTruncated = false
      } else if (event.kind === 'tool') {
        row.stage = 'evidence'
        row.toolCalls += 1
        row.activities.push({ tool: event.tool, target: String(event.target || '').slice(0, 220),
          ok: event.ok === true, round: event.round, at: now(), ms: event.ms || 0 })
        row.activities = row.activities.slice(-24)
      }
      row.updatedAt = now()
    },
    finish(runId, result) {
      const row = records.get(runId)
      if (!row) return
      row.result = copy(result)
      row.stage = result.cut === 'advisor-timeout' || result.reason === 'advisor-timeout' ? 'timeout'
        : result.cut === 'advisor-cancelled' || result.reason === 'advisor-cancelled' ? 'cancelled'
        : result.ok ? 'done' : 'failed'
      row.finishedAt = now(); row.updatedAt = now()
      row.reason = result.reason || result.cut || null
      trim(); save()
    },
    get(sessionId, { callId, runId } = {}) {
      if (!sessionId || (!callId && !runId)) return null
      const rows = [...records.values()]
      const row = runId ? records.get(runId) : rows.reverse().find(r => r.sessionId === String(sessionId) && r.callId === String(callId))
      return row?.sessionId === String(sessionId) ? copy(row) : null
    },
    dispose() {
      for (const row of records.values()) if (!terminal.has(row.stage)) {
        row.stage = 'interrupted'; row.reason = 'plugin-unloaded'; row.finishedAt = now()
      }
      save()
    },
  }
}
