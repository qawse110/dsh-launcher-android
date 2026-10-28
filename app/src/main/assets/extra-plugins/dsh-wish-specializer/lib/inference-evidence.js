import {createHash, randomUUID} from 'node:crypto'
import {mkdirSync, openSync, readSync, closeSync, fstatSync, writeFileSync, renameSync, unlinkSync} from 'node:fs'
import {resolve, relative, isAbsolute, win32, join} from 'node:path'
import {readBounded} from './advisor-materials.js'
import {isRealUserInput} from './wire.js'

export const INFERENCE_EVIDENCE_VERSION = 1
const TEXT_CAP = 256 * 1024, EXCERPT_CAP = 1200, FILE_CAP = 2 * 1024 * 1024
const STORE_CAP = 16 * 1024 * 1024, CHECK_CAP = 2000
const sha = value => createHash('sha256').update(value).digest('hex')
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 2048
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const copy = value => JSON.parse(JSON.stringify(value))
const cut = (value, cap = EXCERPT_CAP) => typeof value === 'string' ? value.slice(0, cap) : ''
const seqOf = event => (typeof event?.seq === 'number' || typeof event?.seq === 'string') && /^\d+$/.test(String(event.seq)) && Number.isSafeInteger(Number(event.seq)) ? Number(event.seq) : null
const bareName = name => String(name || '').split(/[./]/).pop().split('__').pop()
const excluded = name => ['consult_task', 'advisor_stage'].includes(bareName(name))
const shell = name => ['bash', 'pwsh', 'shell', 'exec', 'exec_command', 'shell_command'].includes(bareName(name))
const closed = issue => issue.status === 'closed-by-tool-evidence'
const exampleIntro = text => /^\s*(?:example(?: output)?|expected(?: failure)? output|sample output)\s*[:=]/i.test(text)
const expected = text => exampleIntro(text) || /\b(?:expected[- ]fail(?:ure)?|expected to fail|should fail)\b/i.test(text)
const baseLimitations = ['Tool text is reported evidence, not host-certified product failure or acceptance.', 'Only exact check identities match; semantic entailment and hidden dependencies are not proven.']

function ordered(value, depth = 0) {
 if (depth > 16) throw new Error('arguments-too-deep')
 if (Array.isArray(value)) return value.map(v => ordered(v, depth + 1))
 if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, ordered(value[k], depth + 1)]))
 return value
}
function argumentsOf(raw) {
 if (typeof raw === 'string') { if (raw.length > TEXT_CAP) return null; try { return JSON.parse(raw) } catch { return null } }
 return raw && typeof raw === 'object' ? raw : {}
}
function operation(name, args) {
 try { const action = (shell(name) || bareName(name) === 'run_code') && args && typeof args === 'object' ? Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'description')) : args
  const text = JSON.stringify(ordered(action)); return text && text.length <= TEXT_CAP ? sha(name + '\n' + text) : null } catch { return null }
}
function descriptor(value) {
 if (typeof value === 'string' && value.trim() && value.length <= 1000) return {path: value}
 if (value && typeof value === 'object' && typeof value.path === 'string' && value.path.trim() && value.path.length <= 1000) return {path: value.path, ...(digest(value.sha256) ? {reportedSha256: value.sha256} : {})}
 return null
}
function pathsOf(args) {
 const out = []
 const add = value => { const d = descriptor(value); if (d && !out.some(p => p.path === d.path)) out.push(d) }
 for (const key of ['file_path', 'filePath', 'path', 'artifact']) add(args?.[key])
 for (const key of ['artifacts', 'files']) if (Array.isArray(args?.[key])) for (const value of args[key].slice(0, 16)) add(value)
 return out.slice(0, 8)
}
// Lexical identity is available with reading off. readBounded supplies the realpath/symlink guard before any bytes are hashed.
function location(root, path) {
 if (typeof root !== 'string' || !root || typeof path !== 'string' || !path || path.length > 1000 || path.includes('\0')) return null
 if (/^[a-z]:[^\\/]/i.test(path) || /^[/\\]{2}/.test(path)) return null
 const base = resolve(root), target = resolve(base, path), back = relative(base, target)
 if (!back || back === '..' || back.startsWith('../') || back.startsWith('..\\') || isAbsolute(back) || (win32.isAbsolute(path) && !isAbsolute(path))) return null
 const key = process.platform === 'win32' ? target.toLowerCase() : target
 return {path: back, root: base, objectId: key}
}
function mutation(name, args) {
 const n = bareName(name)
 if (shell(name) || n === 'run_code') return 'unknown'
 if (['write', 'edit', 'script_create', 'script_patch'].includes(n)) return 'object'
 if (n === 'filesystem_manage' && args?.op === 'write_text') return 'object'
 return null
}
function textOf(content) {
 let text = '', truncated = false
 const parts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text) : []
 for (const part of parts) {
  const room = TEXT_CAP - text.length
  if (room <= 0) { truncated = true; break }
  if (text) text += '\n'
  text += part.slice(0, Math.max(0, TEXT_CAP - text.length)); truncated ||= part.length > room
 }
 return {text, truncated}
}
function structuredOf(data, text, content) {
 const candidates = [data.structuredContent, data.message?.structuredContent, content]
 if (text.trim().startsWith('{')) try { candidates.push(JSON.parse(text)) } catch { /* not structured result JSON */ }
 for (const candidate of candidates) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
  if (Array.isArray(candidate.checks) || ['exitCode', 'exit_code'].some(k => Number.isInteger(candidate[k]))) return candidate
  if (candidate.structuredContent && typeof candidate.structuredContent === 'object') return candidate.structuredContent
 }
 return null
}
function textChecks(text) {
 const checks = [], lines = text.split(/\r?\n/); let fence = false
 for (const line of lines) {
  if (/^\s*(?:\x60{3}|~{3})/.test(line)) { fence = !fence; continue }
  if (fence || /^\s*(?:>|["'\x60])/.test(line) || exampleIntro(line)) continue
   const diagnostic=line.trim().match(/^(?:Uncaught(?: \(in promise\))?\s+)?((?:[A-Za-z_][A-Za-z0-9_.]*?(?:Error|Exception)|Error|Exception)):\s*(.+)$/)
   if(diagnostic&&!expected(line)){checks.push({id:null,label:cut(diagnostic[1]+': '+diagnostic[2],512),status:'fail',excerpt:cut(line),identity:'diagnostic'});continue}
  if (/^\s*Traceback \(most recent call last\):/.test(line)) {
   checks.push({id: null, label: 'Traceback', status: 'fail', excerpt: cut(line), identity: 'text'}); continue
  }
  for (const segment of line.split('|')) {
   const trimmed = segment.trim(); if (!trimmed || expected(trimmed) || /^[>"'\x60]/.test(trimmed)) continue
   let match = trimmed.match(/^(FAIL(?:ED)?|ERROR|PASS(?:ED)?)\b\s*(?::|-)?\s*(.*)$/)
   let label = match?.[2] || ''
   if (!match) {
    const end = trimmed.match(/^(.+?)\s*[:=]?\s+\b(FAIL(?:ED)?|ERROR|PASS(?:ED)?)\b\s*(?::\s*.*)?$/)
    if (end) { match = [end[0], end[2]]; label = end[1].trim().replace(/[:=]$/, '').trim() }
   }
   if (!match || /\bALL\b/.test(label)) continue
   const tooLong = label.length > 512
   const status = /^(?:FAIL|ERROR)/.test(match[1]) ? 'fail' : 'pass'
   if (status === 'pass' && !label) continue
   checks.push({id: label && !tooLong ? 'text:' + label : null, label: cut(label || match[1], 512), status, excerpt: cut(segment), identity: 'text'})
   if (checks.length >= CHECK_CAP) return {checks, truncated: true}
  }
 }
 return {checks, truncated: false}
}
function structuredChecks(value, text) {
 if (!Array.isArray(value?.checks)) return {checks: [], truncated: false}
 const checks = []
 for (const check of value.checks.slice(0, CHECK_CAP)) {
  if (!check || typeof check !== 'object') continue
  const id = typeof check.id === 'string' && check.id.trim() && check.id.length <= 512 ? check.id : null
  const status = typeof check.status === 'string' ? check.status.toLowerCase() : ''
  if (!['fail', 'failed', 'error', 'errored', 'pass', 'passed', 'ok', 'success'].includes(status)) continue
  if (!id && ['pass', 'passed', 'ok', 'success'].includes(status)) continue
  let excerpt
  if (text) { const at = Math.max(0, typeof check.id === 'string' ? text.indexOf(check.id) : 0); excerpt = text.slice(Math.max(0, at - 80), Math.max(0, at - 80) + EXCERPT_CAP) }
  else excerpt = cut(JSON.stringify({id: check.id, status: check.status, ...(typeof check.message === 'string' ? {message: cut(check.message)} : {})}))
  checks.push({id, label: cut(typeof check.id === 'string' ? check.id : 'Unidentified structured check', 512), identity: 'structured', status: ['fail', 'failed', 'error', 'errored'].includes(status) ? 'fail' : 'pass', artifact: descriptor(check.artifact) || descriptor(value.artifact), excerpt})
 }
 return {checks, truncated: value.checks.length > CHECK_CAP}
}
function readStore(path) {
 const fd = openSync(path, 'r')
 try {
  const size = fstatSync(fd).size
  if (size > STORE_CAP) throw new Error('oversized-evidence-state')
  const data = Buffer.alloc(size + 1); let count = 0, n
  while (count < data.length && (n = readSync(fd, data, count, data.length - count, null)) > 0) count += n
  if (count !== size) throw new Error('changed-evidence-state')
  return JSON.parse(data.subarray(0, count).toString('utf8'))
 } finally { closeSync(fd) }
}

const issueStates = new Set(['open', 'changed-pending', 'recheck-pending', 'closed-by-tool-evidence'])
const versionStates = new Set(['historical-unknown', 'read-disabled', 'read-budget-exhausted', 'reported-hash-mismatch', 'observed-fresh', 'unavailable', 'stale-result'])
const validTime = value => value === null || (typeof value === 'number' && Number.isFinite(value))
function validBinding(b, seq) {
 if (!b || typeof b !== 'object' || !validId(b.objectId) || typeof b.path !== 'string' || b.path.length > 1000 || typeof b.root !== 'string' || b.root.length > 2048 || !versionStates.has(b.versionStatus) || !(b.sha256 === null || digest(b.sha256)) || (b.reportedSha256 !== undefined && !digest(b.reportedSha256))) return false
 const p = location(b.root, b.path)
 if (!p || p.objectId !== b.objectId || b.observedSeq !== seq) return false
 if (b.versionStatus === 'observed-fresh' && (!digest(b.sha256) || !validId(b.actualPath))) return false
 return b.actualPath === undefined || validId(b.actualPath)
}
function validIssue(i, p) {
 if (!i || !digest(i.key) || !/^E\d+$/.test(i.id) || !['reported-failure', 'invocation-failure'].includes(i.kind) || !issueStates.has(i.status) || !['text', 'structured', 'operation'].includes(i.checkIdentity)
  || !(i.checkId === null || (typeof i.checkId === 'string' && i.checkId.length > 0 && i.checkId.length <= 520)) || typeof i.label !== 'string' || i.label.length > 512
  || !(i.operation === null || digest(i.operation)) || typeof i.excerpt !== 'string' || i.excerpt.length > EXCERPT_CAP || !Number.isSafeInteger(i.count) || i.count < 1 || !validTime(i.firstSeenAt) || !validTime(i.lastSeenAt)
  || !Array.isArray(i.refs) || i.refs.length < 1 || i.refs.length > 8 || !i.refs.every(ref => /^E\d+$/.test(ref))) return false
 const source = i.source
 if (!source || !Number.isSafeInteger(source.seq) || source.seq <= p.userSeq || source.id !== 'E' + source.seq || source.requestId !== p.requestId || !validId(source.callId) || !validId(source.tool) || !['native', 'ptc'].includes(source.transport) || !['tool/result', 'tool/ptc-dispatch'].includes(source.type) || !i.refs.includes(source.id)) return false
 if (i.binding !== null && !validBinding(i.binding, source.seq)) return false
 if (i.kind === 'invocation-failure' && (i.binding !== null || i.checkIdentity !== 'operation')) return false
 if (i.pendingReason !== undefined && (typeof i.pendingReason !== 'string' || i.pendingReason.length > 240)) return false
 const r = i.resolution
 if (r !== undefined && (!r || !Number.isSafeInteger(r.seq) || r.seq <= source.seq || r.sourceId !== 'E' + r.seq || !validId(r.callId) || !validTime(r.observedAt) || typeof r.valid !== 'boolean' || (i.kind === 'reported-failure' && (!digest(r.sha256) || r.actualPath !== i.binding?.actualPath)))) return false
 if (closed(i) && (!r?.valid || (i.kind === 'reported-failure' && (!i.binding?.sha256 || i.binding.versionStatus !== 'observed-fresh')) || (i.kind === 'invocation-failure' && !digest(i.operation)))) return false
 return true
}

/** Observation/context only. Nothing here resumes an agent, executes tools, chooses a model or grants acceptance.
 * A free-text label is an exact identity, not a semantic interpretation. Unbound/unknown-version failures stay pending.
 * Invocation recovery uses an exact operation fingerprint and an explicit later zero exit; it never closes a product check.
 */
export function createInferenceEvidence({home = null, namespace = 'default', limit = 200, now = Date.now} = {}) {
 const cap = Number.isSafeInteger(limit) ? Math.max(1, Math.min(2000, limit)) : 200
 const directory = typeof home === 'string' && home ? join(home, 'po06-inference-evidence', sha(String(namespace)).slice(0, 16)) : null
 const states = new Map(); let disposed = false
 const stamp = () => { try { const time = Number(now()); return Number.isFinite(time) ? time : null } catch { return null } }
 const warn = (s, reason) => { if (!s.limitations.includes(reason) && s.limitations.length < 32) s.limitations.push(reason) }
 const fresh = sid => ({version: 1, sessionId: sid, requestId: null, userSeq: null, issues: [], recent: [], calls: new Map(), roots: new Set(), ranges: [], ignoredBefore: -1, clock: 0, unknownWrite: 0, writes: new Map(), omittedIssues: 0, omittedEvidence: 0, limitations: [], seeded: false})
 const fileOf = sid => join(directory, sha(sid) + '.json')
 const get = sid => {
  if (!validId(sid) || disposed) return null
  if (states.has(sid)) return states.get(sid)
  const s = fresh(sid)
  if (directory) try {
   const stored = readStore(fileOf(sid)), p = stored.payload
   if (!p || stored.integrity !== sha(JSON.stringify(p)) || p.version !== 1 || p.sessionId !== sid || !(p.requestId === null || /^human:\d+$/.test(p.requestId))
    || !(p.userSeq === null || Number.isSafeInteger(p.userSeq)) || p.requestId !== (p.userSeq === null ? null : 'human:' + p.userSeq)
    || !Array.isArray(p.issues) || p.issues.length > 2000 || !Array.isArray(p.recent) || p.recent.length > 2000
    || !Array.isArray(p.calls) || p.calls.length > 8000 || !Array.isArray(p.ranges) || p.ranges.length > 512
    || !Array.isArray(p.writes) || p.writes.length > 8000 || !Array.isArray(p.roots) || p.roots.length > 8000
    || ![p.clock, p.unknownWrite, p.omittedIssues, p.omittedEvidence].every(x => Number.isSafeInteger(x) && x >= 0)
    || !Number.isSafeInteger(p.ignoredBefore) || !p.ranges.every(r => Array.isArray(r) && r.length === 2 && r.every(Number.isSafeInteger) && r[0] >= 0 && r[1] >= r[0])
    || !p.issues.every(i => validIssue(i, p))
    || !p.recent.every(r => /^E\d+$/.test(r.id) && typeof r.excerpt === 'string' && r.excerpt.length <= EXCERPT_CAP)
    || !p.roots.every(validId) || !p.writes.every(w => Array.isArray(w) && w.length === 2 && validId(w[0]) && Number.isSafeInteger(w[1]) && w[1] >= 0 && w[1] <= p.clock)
    || p.unknownWrite > p.clock || !Array.isArray(p.limitations) || p.limitations.length > 32 || !p.limitations.every(v => typeof v === 'string' && v.length <= 240)
    || !p.calls.every(c => c && (c.operation === null || digest(c.operation)) && ['object', 'unknown', null].includes(c.mutation) && typeof c.completed === 'boolean' && validId(c.id) && validId(c.name) && c.requestId === p.requestId && Array.isArray(c.paths) && c.paths.length <= 8 && Number.isSafeInteger(c.seq) && Number.isSafeInteger(c.startClock))) throw new Error('invalid-evidence-state')
   Object.assign(s, {requestId: p.requestId, userSeq: p.userSeq, issues: p.issues, recent: p.recent, clock: p.clock, unknownWrite: p.unknownWrite, ignoredBefore: p.ignoredBefore, ranges: p.ranges, omittedIssues: p.omittedIssues, omittedEvidence: p.omittedEvidence})
   s.calls = new Map(p.calls.map(c => [c.id, {...c, historical: true}]))
   s.roots = new Set(p.roots); s.writes = new Map(p.writes)
   for (const reason of p.limitations || []) if (typeof reason === 'string') warn(s, cut(reason, 240))
   if (s.issues.length > cap) { const open = s.issues.filter(i => !closed(i)); s.omittedIssues += Math.max(0, open.length - cap); s.issues = open.slice(0, cap); warn(s, 'memory-cap-open-issues-omitted') }
   if (s.recent.length > cap) { s.omittedEvidence += s.recent.length - cap; s.recent = s.recent.slice(-cap) }
  } catch (error) { if (error?.code !== 'ENOENT') warn(s, 'persisted-evidence-unavailable-or-corrupt') }
  states.set(sid, s)
  return s
 }
 const save = s => {
  if (!directory || !s) return
  let temp
  try {
   mkdirSync(directory, {recursive: true})
   const payload = {version: 1, sessionId: s.sessionId, requestId: s.requestId, userSeq: s.userSeq, issues: s.issues, recent: s.recent, calls: [...s.calls.values()], roots: [...s.roots], clock: s.clock, unknownWrite: s.unknownWrite, writes: [...s.writes], ranges: s.ranges, ignoredBefore: s.ignoredBefore, omittedIssues: s.omittedIssues, omittedEvidence: s.omittedEvidence, limitations: s.limitations}
   const text = JSON.stringify({payload, integrity: sha(JSON.stringify(payload))})
   if (Buffer.byteLength(text) > STORE_CAP) { warn(s, 'evidence-state-size-limit'); return }
   temp = fileOf(s.sessionId) + '.tmp-' + process.pid + '-' + randomUUID()
   writeFileSync(temp, text, {encoding: 'utf8', mode: 0o600}); renameSync(temp, fileOf(s.sessionId)); temp = null
  } catch { warn(s, 'evidence-state-write-failed') }
  finally { if (temp) try { unlinkSync(temp) } catch { /* best effort, never broaden access */ } }
 }
 const seen = (s, seq) => seq <= s.ignoredBefore || s.ranges.some(([a, b]) => seq >= a && seq <= b)
 const remember = (s, seq) => {
  const ranges = [...s.ranges, [seq, seq]].sort((a, b) => a[0] - b[0]), merged = []
  for (const r of ranges) { const last = merged.at(-1); if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]); else merged.push(r) }
  while (merged.length > 512) { s.ignoredBefore = Math.max(s.ignoredBefore, merged.shift()[1]); warn(s, 'old-event-watermark-bounded') }
  s.ranges = merged
 }
 const begin = (s, seq) => {
  if (s.userSeq !== null && seq <= s.userSeq) return false
  const limitations = s.limitations.filter(r => /persisted|state-write|state-clear/.test(r))
  const next = fresh(s.sessionId); Object.assign(s, next, {limitations, requestId: 'human:' + seq, userSeq: seq})
  remember(s, seq); return true
 }
 const invalidate = (s, call, root) => {
  if (!call.mutation) return
  const paths = call.paths.map(d => location(root, d.path)).filter(Boolean)
  s.clock++
  if (call.mutation === 'unknown' || !paths.length) s.unknownWrite = s.clock
  else for (const p of paths) s.writes.set(p.objectId, s.clock)
  while (s.writes.size > Math.max(64, cap * 4)) { const key = s.writes.keys().next().value; s.unknownWrite = Math.max(s.unknownWrite, s.writes.get(key)); s.writes.delete(key) }
  for (const issue of s.issues) {
   if (issue.kind === 'invocation-failure') continue
   if (call.mutation === 'unknown' || !paths.length || paths.some(p => p.objectId === issue.binding?.objectId)) {
    issue.status = 'changed-pending'; issue.pendingReason = 'object-may-have-changed'; if (issue.resolution) issue.resolution.valid = false
   }
  }
 }
 const binding = (s, artifact, ctx, seq, historical, budget) => {
  if (!artifact) return null
  const p = location(ctx.root, artifact.path)
  if (!p) { warn(s, 'artifact-outside-root-or-invalid'); return null }
  const out = {...p, sha256: null, versionStatus: historical ? 'historical-unknown' : 'read-disabled', observedSeq: seq, ...(artifact.reportedSha256 ? {reportedSha256: artifact.reportedSha256} : {})}
  if (historical || !ctx.readEnabled) return out
  if (budget.cache.has(p.objectId)) {
   const cached = {...budget.cache.get(p.objectId)}
   if (artifact.reportedSha256 && cached.sha256 && artifact.reportedSha256 !== cached.sha256) { cached.versionStatus = 'reported-hash-mismatch'; warn(s, 'artifact-reported-hash-mismatch') }
   return cached
  }
  if (budget.cache.size >= 8 || budget.left <= 0) { out.versionStatus = 'read-budget-exhausted'; warn(s, 'artifact-read-budget-exhausted'); return out }
  try {
   const read = readBounded(ctx.root, p.path, Math.min(FILE_CAP, budget.left)); budget.left -= read.data.length
   out.sha256 = sha(read.data); out.actualPath = read.actual; out.versionStatus = artifact.reportedSha256 && artifact.reportedSha256 !== out.sha256 ? 'reported-hash-mismatch' : 'observed-fresh'
   if (out.versionStatus !== 'observed-fresh') warn(s, 'artifact-reported-hash-mismatch')
  } catch { out.versionStatus = 'unavailable'; warn(s, 'artifact-version-unavailable') }
  budget.cache.set(p.objectId, out); return out
 }
 const addRecent = (s, record) => {
  s.recent.push(record)
  if (s.recent.length > cap) { s.omittedEvidence += s.recent.length - cap; s.recent.splice(0, s.recent.length - cap) }
 }
 const addFailure = (s, report) => {
  const key = sha(JSON.stringify([report.kind, bareName(report.source.tool), report.checkIdentity, report.checkId, report.binding?.objectId || null, report.binding?.actualPath || null, report.kind === 'invocation-failure' || !report.checkId ? report.operation : null]))
  let issue = s.issues.find(i => i.key === key)
  if (issue) {
   if (report.source.seq < issue.source.seq) return
   issue.count++; issue.source = report.source; issue.excerpt = report.excerpt; issue.lastSeenAt = report.observedAt; issue.binding = report.binding; issue.status = 'open'; delete issue.pendingReason; delete issue.resolution
   issue.refs = [...issue.refs.filter(id => id !== report.source.id), report.source.id].slice(-8)
  } else {
   if (s.issues.length >= cap) { const index = s.issues.findIndex(closed); if (index >= 0) s.issues.splice(index, 1) }
   if (s.issues.length >= cap) { s.omittedIssues++; warn(s, 'memory-cap-open-issues-omitted'); return }
   issue = {key, id: report.source.id, kind: report.kind, checkId: report.checkId, checkIdentity: report.checkIdentity, label: report.label, operation: report.operation, binding: report.binding, excerpt: report.excerpt, source: report.source, firstSeenAt: report.observedAt, lastSeenAt: report.observedAt, count: 1, refs: [report.source.id], status: 'open'}
   s.issues.push(issue)
  }
 }
 const suppressRoot = (s, root) => {
  s.roots.add(root)
  s.recent = s.recent.filter(e => e.callId !== root)
  s.issues = s.issues.filter(issue => !(issue.source.callId === root && issue.count === 1))
  for (const issue of s.issues) if (issue.resolution?.callId === root) { issue.status = 'recheck-pending'; issue.pendingReason = 'root-summary-suppressed'; issue.resolution.valid = false }
 }
 const currentAt = (s, call, objectId) => !call.historical && s.unknownWrite <= call.startClock && (!objectId || (s.writes.get(objectId) || 0) <= call.startClock)
 const consume = (session, event, ctx, historical = false) => {
  const sid = session?.id, s = get(typeof sid === 'string' ? sid : ''), seq = seqOf(event)
  if (!s || !event || ctx.enabled === false) return {observed: false}
  if (seq === null) { warn(s, 'event-sequence-unavailable'); return {observed: false} }
  if (isRealUserInput(event)) {
   const reset = begin(s, seq); if (reset) save(s)
   return {observed: reset, requestId: s.requestId, reset}
  }
  if (!['tool/call', 'tool/ptc-dispatch-start', 'tool/ptc-dispatch', 'tool/result'].includes(event.type)) return {observed: false}
  const d = event.data || {}, source = d.source || d.message?.source || event.source
  if (source?.kind && !['tool', 'runtime', 'host'].includes(source.kind)) return {observed: false}
  if (s.userSeq === null || seq <= s.userSeq || seen(s, seq)) return {observed: false}
  const id = d.subCallId || d.callId || d.message?.toolCallId
  if (!validId(id)) { warn(s, 'tool-call-identity-unavailable'); return {observed: false} }
  if (event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start') {
   if (validId(d.rootCallId)) suppressRoot(s, d.rootCallId)
   if (s.calls.has(id)) { remember(s, seq); return {observed: false} }
   if (!validId(d.name)) return {observed: false}
   const args = argumentsOf(d.arguments), call = {id, name: d.name, requestId: s.requestId, seq, paths: pathsOf(args?.params || args), operation: args ? operation(d.name, args) : null, rootCallId: validId(d.rootCallId) ? d.rootCallId : null, mutation: excluded(d.name) ? null : mutation(d.name, args), historical, startClock: s.clock, completed: false}
   if (!historical) invalidate(s, call, ctx.root)
   call.startClock = s.clock; s.calls.set(id, call); remember(s, seq)
   while (s.calls.size > Math.max(64, cap * 4)) { s.calls.delete(s.calls.keys().next().value); warn(s, 'tool-call-memory-bounded') }
   while (s.roots.size > Math.max(64, cap * 4)) s.roots.delete(s.roots.values().next().value)
   save(s); return {observed: false, callId: id}
  }
  const call = s.calls.get(id)
  if (!call || call.requestId !== s.requestId || seq <= call.seq) { warn(s, 'uncorrelated-tool-result-ignored'); return {observed: false} }
  remember(s, seq)
  if (call.completed || excluded(call.name) || (bareName(call.name) === 'run_code' && s.roots.has(id))) { call.completed = true; save(s); return {observed: false} }
  call.completed = true
  const content = event.type === 'tool/ptc-dispatch' ? d.content : d.message?.content, {text, truncated} = textOf(content), value = structuredOf(d, text, content)
  const output = [text, value?.stdout?.text, value?.stderr?.text, typeof value?.stdout === 'string' ? value.stdout : null, typeof value?.stderr === 'string' ? value.stderr : null].filter(v => typeof v === 'string').join('\n').slice(0, TEXT_CAP)
  const structured = structuredChecks(value, text), free = textChecks(output)
  if (truncated || structured.truncated || free.truncated) warn(s, 'tool-output-observation-truncated')
  const diagnostics=free.checks.filter(c=>c.identity==='diagnostic')
   const checks = [...structured.checks, ...free.checks.filter(c=>c.identity!=='diagnostic')], budget = {left: 8 * 1024 * 1024, cache: new Map()}
  const defaultArtifact = descriptor(value?.artifact) || (call.paths.length === 1 ? call.paths[0] : null)
  const sourceInfo = {id: 'E' + seq, seq, callId: id, tool: call.name, transport: event.type === 'tool/ptc-dispatch' ? 'ptc' : 'native', type: event.type, requestId: s.requestId, historical: historical || call.historical}
  const observedAt = stamp(), isError = d.isError === true || d.message?.isError === true
  const exitMatch = shell(call.name) ? text.match(/^\s*\[exit code:\s*(-?\d+)\]\s*$/m) : null
  const exitCode = shell(call.name) ? (Number.isInteger(value?.exitCode) ? value.exitCode : Number.isInteger(value?.exit_code) ? value.exit_code : exitMatch ? Number(exitMatch[1]) : null) : null
  const invocationFailed = isError || (exitCode !== null && exitCode !== 0) || diagnostics.length>0
  // Calculate freshness before recording this operation's own possible writes. Later overlapping writes invalidate older calls.
  const freshness = new Map()
  for (const c of checks) { const p = location(ctx.root, (c.artifact || defaultArtifact)?.path); if (p) freshness.set(p.objectId, currentAt(s, call, p.objectId)) }
  const invocationFresh = currentAt(s, call, null)
  if (!historical) invalidate(s, call, ctx.root)
  const observations = [], checkRecords = []
  if (invocationFailed) observations.push({kind: 'invocation-failure', checkId: 'invocation:' + (call.operation || id), checkIdentity: 'operation', label: diagnostics[0]?.label || (isError ? 'Tool invocation reported an error' : 'Nonzero exit ' + exitCode), operation: call.operation, binding: null, excerpt: cut(diagnostics[0]?.excerpt || exitMatch?.[0] || text), source: sourceInfo, observedAt})
  for (const check of checks) {
   const artifact = check.artifact || defaultArtifact, objectId = location(ctx.root, artifact?.path)?.objectId
   const stale = !historical && !call.historical && objectId && !freshness.get(objectId)
   const bound = binding(s, artifact, ctx, seq, historical || call.historical || !!stale, budget)
   if (bound && stale) bound.versionStatus = 'stale-result'
   if (checkRecords.length < Math.min(32, cap)) checkRecords.push({id: check.id, identity: check.identity, label: check.label, status: check.status, binding: bound})
   if (check.status === 'fail') observations.push({kind: 'reported-failure', checkId: check.id, checkIdentity: check.identity, label: check.label, operation: call.operation, binding: bound, excerpt: check.excerpt, source: sourceInfo, observedAt})
   else if (!invocationFailed && !historical && call.mutation !== 'object' && check.id && bound?.sha256 && bound.versionStatus === 'observed-fresh' && freshness.get(bound.objectId)) {
    const failedTogether = checks.some(c => c.status === 'fail' && c.id === check.id && c.identity === check.identity && (location(ctx.root, (c.artifact || defaultArtifact)?.path)?.objectId || null) === bound.objectId)
    if (failedTogether) continue
    for (const issue of s.issues) if (issue.kind === 'reported-failure' && bareName(issue.source.tool) === bareName(call.name) && issue.checkId === check.id && issue.checkIdentity === check.identity && issue.binding?.objectId === bound.objectId && issue.binding.sha256 && issue.binding.versionStatus === 'observed-fresh' && issue.binding.actualPath === bound.actualPath && seq > issue.source.seq && call.seq > issue.source.seq) {
     issue.status = 'closed-by-tool-evidence'; delete issue.pendingReason
     issue.resolution = {sourceId: sourceInfo.id, seq, callId: id, sha256: bound.sha256, actualPath: bound.actualPath, observedAt, valid: true}
    }
   }
  }
  if (!invocationFailed && !historical && invocationFresh && call.operation && exitCode === 0) for (const issue of s.issues) if (issue.kind === 'invocation-failure' && issue.operation === call.operation && seq > issue.source.seq && call.seq > issue.source.seq) {
   issue.status = 'closed-by-tool-evidence'; delete issue.pendingReason; issue.resolution = {sourceId: sourceInfo.id, seq, callId: id, observedAt, valid: true}
  }
  for (const observation of observations) addFailure(s, observation)
  for (const issue of s.issues) if (issue.kind === 'invocation-failure' && !closed(issue)) issue.pendingReason = issue.source.historical ? 'historical-invocation-recovery-unobserved;not-a-product-check' : 'invocation-recovery-unobserved;not-a-product-check'
  addRecent(s, {id: sourceInfo.id, seq, requestId: s.requestId, callId: id, tool: call.name, transport: sourceInfo.transport, excerpt: cut(text), observedAt, historical: historical || call.historical, isError, exitCode, checks: checkRecords, omittedChecks: Math.max(0, checks.length - Math.min(32, cap)), reportedFailures: observations.length})
  save(s); return {observed: true, id: sourceInfo.id, requestId: s.requestId, reportedFailures: observations.length, pendingIssues: s.issues.filter(i => !closed(i)).length, omittedIssues: s.omittedIssues}
 }
 const empty = (requestId, limitations = []) => ({version: INFERENCE_EVIDENCE_VERSION, requestId: requestId || null, openIssues: [], recentEvidence: [], limitations, completionClaimAllowed: false, mode: 'explore', omitted: {openIssues: 0, recentEvidence: 0}})
 const api = {
  observe(session, event, {enabled = true, root = session?.header?.cwd, readEnabled = false} = {}) {
   if (!enabled || disposed) return {observed: false}
   try {
    const s = get(session?.id)
    if (s && !s.requestId && !isRealUserInput(event)) api.seed(session, {root, readEnabled: false})
    return consume(session, event, {enabled, root, readEnabled: readEnabled === true})
   } catch { const s = get(session?.id); if (s) warn(s, 'evidence-observation-unavailable'); return {observed: false} }
  },
  seed(session, {enabled = true, root = session?.header?.cwd} = {}) {
   if (!enabled || disposed) return {observed: false}
   const s = get(session?.id); if (!s || typeof session.snapshotEvents !== 'function') return {observed: false}
   try {
    const events = session.snapshotEvents(); if (!Array.isArray(events)) return {observed: false}
    let start = -1
    for (let i = events.length - 1; i >= 0; i--) if (isRealUserInput(events[i]) && seqOf(events[i]) !== null) { start = i; break }
    if (start < 0) return {observed: false}
    const seq = seqOf(events[start]); if ((s.seeded && s.userSeq === seq) || (s.userSeq !== null && s.userSeq > seq)) return {observed: false}
    consume(session, events[start], {enabled: true, root, readEnabled: false}, true)
    s.seeded = true
    // Pre-register roots so even an unusual history ordering cannot count a root summary over inner PTC evidence.
    for (const event of events.slice(start + 1)) if (event?.type === 'tool/ptc-dispatch-start' && validId(event.data?.rootCallId)) suppressRoot(s, event.data.rootCallId)
    let observed = 0
    for (const event of events.slice(start + 1)) if (consume(session, event, {enabled: true, root, readEnabled: false}, true).observed) observed++
    save(s); return {observed: true, requestId: s.requestId, seededResults: observed}
   } catch { warn(s, 'history-evidence-unavailable'); return {observed: false} }
  },
  snapshot({sessionId, requestId, root, readEnabled = false} = {}) {
   try {
    const s = get(sessionId); if (!s) return empty(requestId)
    if (!requestId || requestId !== s.requestId) return empty(requestId, ['request-id-mismatch', ...s.limitations])
    const budget = {left: 8 * 1024 * 1024, cache: new Map()}; let dirty = false
    for (const issue of s.issues) {
     if (issue.kind === 'invocation-failure') continue
     let reason = null
     const b = issue.binding
     if (!readEnabled) reason = 'read-permission-disabled'
     else if (!b?.sha256 || b.versionStatus !== 'observed-fresh') reason = 'original-object-version-unknown'
     else {
      const current = binding(s, {path: b.path}, {root, readEnabled: true}, null, false, budget)
      if (!current?.sha256 || current.versionStatus !== 'observed-fresh' || current.objectId !== b.objectId || current.actualPath !== b.actualPath) reason = 'object-version-unavailable-or-different'
      else if (current.sha256 !== (closed(issue) ? issue.resolution?.sha256 : b.sha256)) reason = 'object-version-changed'
     }
     if (reason) {
      const status = reason === 'object-version-changed' ? 'changed-pending' : 'recheck-pending'
      dirty ||= issue.status !== status || issue.pendingReason !== reason || issue.resolution?.valid === true
      issue.status = status; issue.pendingReason = reason; if (issue.resolution) issue.resolution.valid = false
     }
    }
    const openIssues = s.issues.filter(i => !closed(i)).map(copy)
    if (s.omittedIssues) openIssues.push({kind: 'omitted-reported-failures', status: 'recheck-pending', count: s.omittedIssues, reason: 'Memory cap omitted failure details; a PASS cannot clear omitted issues.'})
    if (dirty) save(s)
    return {version: INFERENCE_EVIDENCE_VERSION, requestId, openIssues, recentEvidence: copy(s.recent), limitations: [...baseLimitations, ...s.limitations], completionClaimAllowed: false, mode: openIssues.length ? 'diagnose' : 'explore', omitted: {openIssues: s.omittedIssues, recentEvidence: s.omittedEvidence}}
   } catch { return empty(requestId, ['evidence-snapshot-unavailable']) }
  },
  clear(sessionId) {
   if (!validId(sessionId)) return {cleared: false}
   states.delete(sessionId)
   if (directory) try { unlinkSync(fileOf(sessionId)) } catch (error) { if (error?.code !== 'ENOENT') { const s = get(sessionId); if (s) warn(s, 'evidence-state-clear-failed'); return {cleared: false} } }
   return {cleared: true}
  },
  status() { return {version: INFERENCE_EVIDENCE_VERSION, ready: !disposed, sessions: states.size, limit: cap, persistent: !!directory, completionClaimAllowed: false} },
  dispose() { states.clear(); disposed = true }
 }
 return api
}
