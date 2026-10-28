import {createHash} from 'node:crypto'
import {posix, win32} from 'node:path'

export const CLAIM_EVIDENCE_POLICY = 'claim-evidence-v1'
const SOURCE = 'host-claim-evidence'
const HASH = /^[a-f0-9]{64}$/
const statuses = new Set(['ready','truncated','unavailable','ambiguous','not-result','reference','unsupported'])
const imageTypes = new Set(['image/png','image/jpeg','image/webp','image/gif'])
const hash = value => createHash('sha256').update(value).digest('hex')
const text = (value, cap=1100) => typeof value === 'string' && !!value.trim() && value.length <= cap
const fingerprint = value => typeof value === 'string' && HASH.test(value)
const rangeOK = range => range && Number.isSafeInteger(range.startLine) && range.startLine > 0 && Number.isSafeInteger(range.endLine) && range.endLine >= range.startLine
const checkKey = (check,index) => check?.checkId || check?.id || 'check:'+index

// Lexical root identity only. Disk reads/realpath safety remain the stores' materialPath job.
// Absolute paths must be inside the actual root; basename/suffix matching is never authority.
// 2026-10-19 issue #35：非 Windows 分支原来用 `win32.isAbsolute(raw)` 一刀切，
// 而 win32 语义下以 / 开头就算绝对路径 ⇒ Linux/macOS 上**一切**绝对路径都被拒收
// （/tmp/r/a.js 明明在 root 里也拿不到键）。现在只拒收"另一边"的路径形态：
//   带盘符（C:/x、C:\x）或 UNC（//server/share），其余交给下面的 resolve+relative 越界判断。
export function evidencePathIdentity(path, root, opts = {}) {
  if (!text(path,2000) || !text(root,2000) || path.includes('\0')) return null
  const platform = (opts && typeof opts.platform === 'string' && opts.platform) || process.platform
  const windows = /^[a-z]:[\\/]/i.test(root) || platform === 'win32'
  const api = windows ? win32 : posix
  const clean = value => windows ? value.replaceAll('/','\\') : value.replaceAll('\\','/')
  const base = api.resolve(clean(root)), raw = clean(path)
  if (windows && (/^[a-z]:(?![\\/])/i.test(raw) || /^\\\\/.test(raw))) return null
  if (!windows && (/^[a-z]:[\\/]/i.test(raw) || /^\/\//.test(raw))) return null
  const target = api.resolve(base,raw), relative = api.relative(base,target)
  if (!relative || relative === '..' || relative.startsWith('..'+api.sep) || api.isAbsolute(relative)) return null
  const value = relative.replace(/\\/g,'/')
  return windows ? value.toLowerCase() : value
}
const canonicalOK = value => text(value,2000) && !value.includes('\\') && !posix.isAbsolute(value) && !win32.isAbsolute(value)
  && !/^[a-z]:/i.test(value) && posix.normalize(value) === value && value !== '..' && !value.startsWith('../') && value !== '.'
const rangesOf = row => {
  const range = {startLine:row.selectedStartLine ?? row.startLine,endLine:row.selectedEndLine ?? row.endLine}
  if (rangeOK(range)) return [range]
  return []
}
const hasResult = (ref, ids, root) => ids.has(ref) || (ref.startsWith('read:') && [...ids].some(id => typeof id === 'string' && id.startsWith('read:')
  && evidencePathIdentity(id.slice(5),root) !== null && evidencePathIdentity(id.slice(5),root) === evidencePathIdentity(ref.slice(5),root)))
const baseBinding = (ref,source) => ({ref,source,kind:'file',path:null,canonicalPath:null,sha256:null,status:'unavailable',selectionComplete:false,wholeFileComplete:false,ranges:[],supported:false,blocking:true,actualImage:false})
const bindingSupported = binding => binding.status === 'ready' && binding.supported === true && binding.blocking === false
const checkComplete = (bindings,visual) => bindings.length > 0 && !bindings.some(b=>b.blocking) && bindings.some(bindingSupported)
  && (!visual || bindings.some(b=>bindingSupported(b) && b.actualImage === true))
const sameRefs = (refs,bindings) => Array.isArray(refs) && refs.length <= 12 && refs.every(r=>text(r))
  && JSON.stringify([...new Set(refs)]) === JSON.stringify(bindings.map(b=>b?.ref))

// Validate on save AND reload. Presence of malformed/newer claim metadata is not legacy.
// This is deliberately independent of business status: a failed check always stays failed.
export function claimEvidenceState(report) {
  const checks = Array.isArray(report?.checks) ? report.checks : []
  const present = report && Object.hasOwn(report,'evidenceAssessment') || checks.some(c=>c && Object.hasOwn(c,'evidenceBindings'))
  if (!present) return {policy:'legacy',complete:false,checks:[]}
  const invalid = () => ({policy:'invalid',complete:false,checks:[],reason:'claim-evidence-metadata-invalid'})
  const assessment = report?.evidenceAssessment
  if (!assessment || assessment.version !== 1 || assessment.source !== SOURCE || typeof assessment.visual !== 'boolean'
    || typeof assessment.complete !== 'boolean' || !checks.length || checks.length > 8 || !Array.isArray(assessment.checks)
    || assessment.checks.length !== checks.length) return invalid()
  const result = []
  for (const [index,check] of checks.entries()) {
    const bindings = check?.evidenceBindings, entry = assessment.checks[index]
    if (!Array.isArray(bindings) || bindings.length > 12 || !sameRefs(check.evidenceRefs,bindings)
      || !entry || entry.key !== checkKey(check,index) || typeof entry.complete !== 'boolean' || !fingerprint(entry.bindingHash)) return invalid()
    for (const b of bindings) {
      if (!b || !text(b.ref) || !['material','advisor-read','tool-result','unknown'].includes(b.source)
        || !['file','image','record'].includes(b.kind) || !statuses.has(b.status) || typeof b.supported !== 'boolean' || typeof b.blocking !== 'boolean'
        || typeof b.actualImage !== 'boolean' || typeof b.selectionComplete !== 'boolean' || typeof b.wholeFileComplete !== 'boolean'
        || !Array.isArray(b.ranges) || b.ranges.length > 96 || !b.ranges.every(rangeOK)
        || b.path !== null && !text(b.path,2000) || b.canonicalPath !== null && !canonicalOK(b.canonicalPath)
        || b.sha256 !== null && !fingerprint(b.sha256)) return invalid()
      if (b.supported && (b.status !== 'ready' || b.blocking || !b.selectionComplete || !fingerprint(b.sha256)
        || b.kind === 'record' && (b.source !== 'tool-result' || !/^E[0-9]+$/.test(b.ref))
        || b.kind !== 'record' && (!canonicalOK(b.canonicalPath) || b.path !== b.canonicalPath)
        || b.kind === 'file' && !b.wholeFileComplete && !b.ranges.length
        || b.kind === 'image' && (!b.actualImage || b.source !== 'material' || !imageTypes.has(b.mediaType)))) return invalid()
      if (b.actualImage && (b.kind !== 'image' || !b.supported)) return invalid()
    }
    const complete = checkComplete(bindings,assessment.visual)
    if (entry.complete !== complete || entry.bindingHash !== hash(JSON.stringify(bindings))) return invalid()
    result.push({key:entry.key,complete,bindings})
  }
  if (assessment.complete !== result.every(c=>c.complete)) return invalid()
  return {policy:CLAIM_EVIDENCE_POLICY,complete:assessment.complete,visual:assessment.visual,checks:result}
}

/** Host evidence assessment, without IO or model calls. Caller partial/user-source barriers stay separate. */
export function assessReviewEvidence(report, {materials=[],trace=[],resultIds=new Set(),visual=false,root,records=[]}={}) {
  // These fields are ALWAYS host-owned; model-authored exemptions cannot survive this call.
  if (!report || typeof report !== 'object' || Array.isArray(report)) report = {verdict:'unverified',checks:[]}
  delete report.evidenceAssessment
  const checks = Array.isArray(report.checks) ? report.checks : []
  for (const check of checks) if (check && typeof check === 'object') delete check.evidenceBindings
  const ids = new Set(resultIds && typeof resultIds[Symbol.iterator] === 'function' ? resultIds : [])
  const inputs = Array.isArray(materials) ? materials : [], rawTrace = Array.isArray(trace) ? trace : []
  const recordRows = Array.isArray(records) ? records : []
  const reads = new Map(), readMaterials = []
  for (const row of rawTrace) {
    if (row?.tool !== 'read') continue
    const identity = evidencePathIdentity(row.args?.path,root), e = row.evidence
    if (!identity) continue
    const list = reads.get(identity) || []; list.push(row); reads.set(identity,list)
    if (row.ok === true && !row.rejected && row.resultAvailable === true && fingerprint(e?.sha256)
      && evidencePathIdentity(e.path,root) === identity) {
      readMaterials.push({...e,id:e.ref || 'read:'+String(row.args.path),path:identity,kind:'file',source:'advisor-read',evidenceType:'source',sent:true})
    }
  }
  const materialBinding = (ref,row) => {
    const b = baseBinding(ref,'material'), path = evidencePathIdentity(row.path,root)
    Object.assign(b,{kind:row.kind === 'image'?'image':'file',path,canonicalPath:path,sha256:fingerprint(row.sha256)?row.sha256:null,
      selectionComplete:row.selectionComplete === true,wholeFileComplete:row.wholeFileComplete === true,ranges:rangesOf(row)})
    if (!['file','image'].includes(row.kind)) return b
    if (!hasResult(ref,ids,root)) {b.status='not-result';return b}
    if (!path || !b.sha256) return b
    if (row.status === 'truncated' || row.truncated === true || row.partial === true || row.selectionComplete === false) {b.status='truncated';return b}
    if (row.status !== 'ready' || row.sent !== true) return b
    if (b.kind === 'image') {
      b.selectionComplete = true; b.wholeFileComplete = true
      if (row.evidenceType === 'reference') {b.status='reference';b.blocking=false;return b}
      if (!imageTypes.has(row.image?.mediaType) || !(Number(row.image?.width)>0) || !(Number(row.image?.height)>0)) {b.status='unsupported';return b}
      Object.assign(b,{status:'ready',mediaType:row.image.mediaType,actualImage:true,supported:true,blocking:false})
    } else if (b.selectionComplete && (b.wholeFileComplete || b.ranges.length)) Object.assign(b,{status:'ready',supported:true,blocking:false})
    return b
  }
  const readBinding = ref => {
    const b=baseBinding(ref,'advisor-read'), path=evidencePathIdentity(ref.slice(5),root), list=path ? reads.get(path) || [] : []
    b.path=path;b.canonicalPath=path
    if (!path || !hasResult(ref,ids,root)) return b
    const observed = list.filter(row=>row.ok === true && !row.rejected && row.resultAvailable === true)
    if (observed.some(row=>!fingerprint(row.evidence?.sha256) || evidencePathIdentity(row.evidence.path,root) !== path)) {b.status='ambiguous';return b}
    const hashes = new Set(observed.map(row=>row.evidence.sha256))
    if (hashes.size > 1) {b.status='ambiguous';return b}
    if (!hashes.size) return b
    if(observed.length!==list.length){b.status='ambiguous';return b}
    b.sha256=[...hashes][0]
    const complete = observed.filter(row=>row.evidence.status === 'ready' && row.evidence.selectionComplete === true && row.evidence.truncated !== true
      && (row.evidence.wholeFileComplete === true || rangesOf(row.evidence).length))
    if (!complete.length) {b.status=observed.some(row=>row.evidence.status === 'truncated' || row.evidence.selectionComplete === false)?'truncated':'unavailable';return b}
    // An unqualified read:path cannot identify which of mixed clipped/complete calls was cited.
    if (complete.length !== observed.length) {b.status='ambiguous';return b}
    const unique = new Map(complete.flatMap(row=>rangesOf(row.evidence)).map(range=>[JSON.stringify(range),range]))
    Object.assign(b,{status:'ready',selectionComplete:true,wholeFileComplete:complete.some(row=>row.evidence.wholeFileComplete === true),
      ranges:[...unique.values()].sort((a,b)=>a.startLine-b.startLine || a.endLine-b.endLine),supported:true,blocking:false})
    return b
  }
  const recordBinding = ref => {
    const b=baseBinding(ref,'tool-result');b.kind='record'
    const found=recordRows.filter(row=>row?.id === ref)
    if (!ids.has(ref) || !found.length) return b
    if (new Set(found.map(row=>row.text)).size > 1) {b.status='ambiguous';return b}
    const row=found[0]
    if (row.type !== 'tool/result') {b.status='not-result';b.blocking=false;return b}
    if (!text(row.text,16000)) return b
    b.sha256=hash(row.text)
    if (row.partial === true || row.truncated === true || /\[截断[：:]|…\(截断|\[truncated[\s:\]]/i.test(row.text)) {b.status='truncated';return b}
    Object.assign(b,{status:'ready',selectionComplete:true,wholeFileComplete:true,supported:true,blocking:false})
    return b
  }
  const resolveRef = ref => {
    if (typeof ref !== 'string') return baseBinding(String(ref),'unknown')
    if (ref.startsWith('read:')) return readBinding(ref)
    if (/^E[0-9]+$/.test(ref)) return recordBinding(ref)
    const found=inputs.filter(row=>row?.id === ref && row.source !== 'advisor-read')
    if (found.length !== 1) {const b=baseBinding(ref,'unknown');if(found.length>1)b.status='ambiguous';return b}
    return materialBinding(ref,found[0])
  }
  const evidenceGaps=[], supplementalWarnings=[], bindings=[], cited=new Set()
  for (const [index,check] of checks.entries()) {
    if (!check || typeof check !== 'object') continue
    const refs=Array.isArray(check.evidenceRefs) ? [...new Set(check.evidenceRefs)] : []
    const bound=refs.map(resolveRef), key=checkKey(check,index)
    const versions=new Map()
    for(const b of bound)if(b.canonicalPath && b.sha256){const hashes=versions.get(b.canonicalPath) || new Set();hashes.add(b.sha256);versions.set(b.canonicalPath,hashes)}
    for(const b of bound)if(versions.get(b.canonicalPath)?.size>1)Object.assign(b,{status:'ambiguous',supported:false,blocking:true,actualImage:false})
    for (const binding of bound) {
      cited.add(binding.ref); bindings.push({checkKey:key,...binding})
      if (binding.blocking) evidenceGaps.push({checkKey:key,checkId:check.checkId,criterion:check.criterion,ref:binding.ref,path:binding.path,status:binding.status,
        reason:binding.status === 'truncated'?'cited-evidence-truncated':binding.status === 'ambiguous'?'ambiguous-evidence-version':binding.status === 'unsupported'?'unsupported-image-evidence':'cited-evidence-unavailable',action:'provide-evidence'})
    }
    if (!bound.some(bindingSupported)) evidenceGaps.push({checkKey:key,criterion:check.criterion,status:'unverified',reason:'claim-result-evidence-required',action:'provide-evidence'})
    if (visual && !bound.some(b=>bindingSupported(b) && b.actualImage)) evidenceGaps.push({checkKey:key,criterion:check.criterion,status:'unverified',reason:'cited-actual-image-required',action:'provide-evidence'})
    check.evidenceBindings=bound
    if (!checkComplete(bound,!!visual) && check.status === 'satisfied') check.status='unverified'
  }
  const assessmentChecks=checks.map((check,index)=>({key:checkKey(check,index),complete:checkComplete(check?.evidenceBindings || [],!!visual),bindingHash:hash(JSON.stringify(check?.evidenceBindings || []))}))
  for (const row of inputs) if (row && row.status !== 'excluded' && !cited.has(row.id) && (row.status !== 'ready' || row.selectionComplete === false || row.kind === 'image' && row.evidenceType === 'reference')) {
    supplementalWarnings.push({id:row.id,path:row.path,status:row.status,reason:row.reason || 'uncited-material-limited',action:'supplemental-only'})
  }
  for (const [path,list] of reads) if (![...cited].some(ref=>ref.startsWith('read:') && evidencePathIdentity(ref.slice(5),root) === path)) {
    for (const row of list) if (row.resultAvailable !== true || row.evidence?.selectionComplete !== true) supplementalWarnings.push({path,status:row.evidence?.status || 'unavailable',reason:'uncited-read-limited',action:'supplemental-only'})
  }
  const complete=checks.length > 0 && checks.length <= 8 && assessmentChecks.every(check=>check.complete)
  report.evidenceAssessment={version:1,source:SOURCE,visual:!!visual,complete,checks:assessmentChecks}
  if (report.verdict === 'pass' && (!complete || checks.some(check=>check.status !== 'satisfied'))) report.verdict=checks.some(check=>check.status === 'failed')?'gaps':'unverified'
  const seen = new Set(inputs.map(row=>JSON.stringify([row?.source,row?.path,row?.sha256,row?.startLine,row?.endLine])))
  const allMaterials=[...inputs]
  for (const row of readMaterials) {const key=JSON.stringify([row.source,row.path,row.sha256,row.startLine,row.endLine]);if(!seen.has(key)){seen.add(key);allMaterials.push(row)}}
  return {report,materials:allMaterials,evidenceGaps,supplementalWarnings,complete,bindings}
}
