import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, openSync, readSync, fstatSync, closeSync } from 'node:fs'
import { join, resolve, extname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { materialPath } from './advisor-materials.js'
import { issueKey } from './advisor-outcome.js'

export const COVERAGE_FILE = 'po06-advisor-coverage.json'
export const COVERAGE_LIMIT = 80
export const COVERAGE_ROWS = 20
export const TEXT_BYTES = 2 * 1024 * 1024
export const IMAGE_BYTES = 5 * 1024 * 1024
const stores = new WeakMap()
const imageExts = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const verdicts = new Set(['pass','gaps','unverified','continue','narrow','change','need_user'])
const statuses = new Set(['satisfied','failed','unverified'])
const id = (v, cap=240) => typeof v === 'string' && v.trim() ? v.trim().slice(0, cap) : null
const clone = v => JSON.parse(JSON.stringify(v))

function safeId(v) { const s=id(v,240); return s && /^[A-Za-z0-9._:@-]+$/.test(s) ? s : null }
function boundedText(v, n) { return typeof v === 'string' ? v.slice(0,n) : '' }
function compactReport(report) {
  if (!report || typeof report !== 'object') return null
  const checks = Array.isArray(report.checks) ? report.checks.slice(0,8).map(c => ({
    criterion: boundedText(c?.criterion, 500), status: statuses.has(c?.status) ? c.status : 'unverified',
    evidenceRefs: Array.isArray(c?.evidenceRefs) ? c.evidenceRefs.slice(0,12).map(x=>boundedText(x,160)) : []
  })) : []
  const findings = Array.isArray(report.findings) ? report.findings.slice(0,6).map(f => ({ text: boundedText(f?.text,500), evidenceRefs: Array.isArray(f?.evidenceRefs) ? f.evidenceRefs.slice(0,12).map(x=>boundedText(x,160)) : [] })) : []
  return { valid: report.valid !== false && verdicts.has(report.verdict) && typeof report.summary==='string' && !!report.summary.trim() && Array.isArray(report.checks) && report.checks.length>0 && report.checks.length<=8 && report.checks.every(c=>typeof c?.criterion==='string' && !!c.criterion.trim() && statuses.has(c.status)), verdict: verdicts.has(report.verdict) ? report.verdict : 'unverified', summary: boundedText(report.summary,1000), checks, findings, nextStep: boundedText(report.nextStep,600), stopCondition: boundedText(report.stopCondition,600) }
}
function compactMaterials(materials) {
  if (!Array.isArray(materials)) return []
  return materials.slice(0,8).map((m,i) => ({ id: safeId(m?.id) || ('M'+i), path: boundedText(m?.path,1000), purpose: boundedText(m?.purpose,400), sha256: /^[a-f0-9]{64}$/i.test(m?.sha256||'') ? m.sha256.toLowerCase() : null, kind: m?.kind === 'image' ? 'image' : 'file', status: boundedText(m?.status,40), evidenceType:boundedText(m?.evidenceType,40), selectionScope:boundedText(m?.selectionScope,40), wholeFileComplete:m?.wholeFileComplete===true }))
}
function atomic(file, rows) { try { mkdirSync(resolve(file,'..'), {recursive:true}); const tmp=file+'.tmp-'+process.pid+'-'+randomUUID(); writeFileSync(tmp, JSON.stringify(rows), 'utf8'); renameSync(tmp,file); return true } catch { return false } }
function load(file, limit) { try { const v=JSON.parse(readFileSync(file,'utf8')); return Array.isArray(v) ? v.filter(x=>safeId(x?.sessionId)&&safeId(x?.requestId)&&safeId(x?.runId)&&/^C\d+$/.test(x?.id||'')).slice(-limit).map(x=>({id:x.id,sessionId:x.sessionId,requestId:x.requestId,runId:x.runId,scope:id(x.scope)||'',focus:id(x.focus,500)||'',question:boundedText(x.question,1000),revisionMarker:boundedText(x.revisionMarker,500),materials:compactMaterials(x.materials),report:compactReport(x.report),ok:x.ok===true,partial:x.partial===true})) : [] } catch { return [] } }
function readHash(root, path, kind, budget=Infinity) {
  let actual
  try { actual=materialPath(root,path); const fd=openSync(actual,'r'); try { const st=fstatSync(fd); const cap=kind==='image'||imageExts.has(extname(path).toLowerCase()) ? IMAGE_BYTES : TEXT_BYTES; if(!st.isFile()) return {status:'missing'}; if(st.size>cap) return {status:'changed',reason:'too-large'}; if(st.size>budget) return {status:'unverified',reason:'feedback-byte-budget'}; const b=Buffer.alloc(st.size+1); let n=0,k; while(n<b.length&&(k=readSync(fd,b,n,b.length-n,null))>0)n+=k; if(n!==st.size) return {status:'unverified'}; return {status:'same-read',bytesRead:st.size,sha256:createHash('sha256').update(b.subarray(0,n)).digest('hex'),actual} } finally {closeSync(fd)} } catch(e) { return {status:e?.code==='ENOENT'?'missing':'unverified'} }
}
function checkMaterials(row, root, readEnabled) { return row.materials.map(m => { if(!readEnabled) return {...m, verification:'unverified'}; if(!root || !m.path || !m.sha256) return {...m, verification:'unverified'}; const x=readHash(root,m.path,m.kind); return {...m, verification:x.status==='same-read' ? (x.sha256===m.sha256?'same':'changed') : x.status} }) }

export function createAdvisorCoverage({home, limit=COVERAGE_LIMIT}={}) {
  const max = Number.isInteger(limit)&&limit>0 ? Math.min(80,limit) : COVERAGE_LIMIT
  const file = home ? join(home,COVERAGE_FILE) : null
  let loadProblem = null
  if (file && existsSync(file)) { try { const fd=openSync(file,'r'); let st; try { st=fstatSync(fd) } finally { closeSync(fd) }; if(st.size > 4 * 1024 * 1024) throw new Error(); const v=JSON.parse(readFileSync(file,'utf8')); if(!Array.isArray(v)) throw new Error() } catch {loadProblem='coverage-store-invalid'} }
  const rows = loadProblem ? [] : load(file,max)
  const persist = () => file ? atomic(file,rows.slice(-max)) : false
  const store = {
    reportProblem(reason) { const state=stores.get(store); if(state) state.problem=boundedText(reason,100) || 'coverage-record-failed' },
    history({sessionId,requestId}={}) { const sid=safeId(sessionId), rid=safeId(requestId); return sid&&rid ? clone(rows.filter(r=>r.sessionId===sid&&r.requestId===rid)) : [] },
    feedback({sessionId, root, readEnabled=false, revisionMarker}={}) {
      const sid=safeId(sessionId), issues=new Map(), targets=new Map(), hashes=new Map()
      let bytesLeft=8*1024*1024
      const limits=loadProblem ? [loadProblem] : []
      if(rows.length>=max) limits.push('coverage-history-at-capacity')
      if(stores.get(store)?.problem && !limits.includes(stores.get(store).problem)) limits.push(stores.get(store).problem)
      for(const row of rows.filter(r=>r.sessionId===sid)) {
        const materials=row.materials.map(m=>{
          let x={status:'unverified'}
          if(readEnabled && root && m.sha256) {
            const key=JSON.stringify([m.path,m.kind])
            if(!hashes.has(key)) {
              const value=hashes.size<16 ? readHash(root,m.path,m.kind,bytesLeft) : {status:'unverified',reason:'feedback-path-budget'}
              bytesLeft-=value.bytesRead || 0; hashes.set(key,value)
              if(value.reason?.startsWith('feedback-') && !limits.includes('material-feedback-budget-exhausted')) limits.push('material-feedback-budget-exhausted')
            }
            x=hashes.get(key)
          }
          return {...m, verification:x.status==='same-read' ? (x.sha256===m.sha256?'same':'changed') : x.status}
        })
        const versionKnown=typeof revisionMarker==='string' && !!revisionMarker && revisionMarker!=='unavailable' && !!row.revisionMarker && row.revisionMarker!=='unavailable'
        const fresh=versionKnown && materials.length>0 && row.revisionMarker===revisionMarker
          && materials.every(m=>m.status==='ready' && m.verification==='same')
        const usable=row.ok && !row.partial && row.report?.valid
        const keyFor=criterion=>{
          const base=issueKey(sid,row,criterion)
          for(const [key,previous] of targets) if(key.startsWith(base) && (previous.requestId===row.requestId || materials.some(m=>previous.paths.includes(m.path)))) return key
          return targets.has(base) ? base + '-' + createHash('sha256').update(JSON.stringify(materials.map(m=>m.path).sort())).digest('hex').slice(0,8) : base
        }
        const close=key=>{
          const previous=targets.get(key)
          const sameTarget=!previous || previous.requestId===row.requestId || materials.some(m=>previous.paths.includes(m.path))
          if(sameTarget) { issues.delete(key); targets.delete(key) }
        }
        const add=(criterion,status,action)=>{
          const key=keyFor(criterion)
          targets.set(key,{requestId:row.requestId,paths:materials.map(m=>m.path)})
          issues.set(key,{id:key,reviewId:row.id,requestId:row.requestId,scope:row.scope,focus:row.focus,
            materialReason:!materials.length?'material-evidence-unavailable':!readEnabled?'material-reread-disabled':!versionKnown?'review-version-unavailable':null,
            criterion:boundedText(criterion,500),status,action,nextStep:boundedText(row.report?.nextStep,250),
            stopCondition:boundedText(row.report?.stopCondition,150), paths:materials.map(m=>boundedText(m.path,160))})
        }
        for(const check of row.report?.checks || []) {
          const key=keyFor(check.criterion)
          if(usable && fresh && check.status==='satisfied') close(key)
          else add(check.criterion,check.status==='failed'?'failed':'unverified',
            check.status==='failed'?'repair-and-review':fresh?'provide-evidence-or-user-check':'review-current-version')
        }
        const summaryKey=keyFor('review-evidence-incomplete')
        if(usable && fresh && row.report.verdict==='pass') close(summaryKey)
        else if(!usable || !fresh || row.report?.verdict!=='pass') add('review-evidence-incomplete','unverified','provide-evidence-or-review')
      }
      const all=[...issues.values()]
      for(const row of all) if(row.materialReason && !limits.includes(row.materialReason)) limits.push(row.materialReason)
      const openIssues=all.slice(-12)
      if(all.length>12) limits.push('open-issues-truncated:'+String(all.length-12))
      return {openIssues, omittedIssues:Math.max(0,all.length-12), limitations:limits,
        disposition:all.length||limits.length?'pending-verification':'no-open-recorded-issues',
        taskCoverageEstablished:false}
    },
    record({sessionId,requestId,runId,scope,focus,question,revisionMarker,materials,report,ok,partial}={}) {
      const sid=safeId(sessionId), rid=safeId(requestId), run=safeId(runId), sc=id(scope,240), fo=id(focus,500)
      if(!sid||!rid||!run||!sc||!fo) { store.reportProblem('invalid-coverage-identity'); return {ok:false,reason:'invalid-coverage-identity'} }
      const next = rows.reduce((n,x) => { const m=/^C(\d+)$/.exec(x?.id||''); return m ? Math.max(n, Number(m[1])+1) : n }, 0)
      const row={id:'C'+next, sessionId:sid, requestId:rid, runId:run, scope:sc, focus:fo, question:boundedText(question,1000), revisionMarker:boundedText(revisionMarker,500), materials:compactMaterials(materials), report:compactReport(report), ok:ok===true, partial:partial===true, at:Date.now()}
      rows.push(row); while(rows.length>max) rows.shift(); const saved=persist(); if(file&&!saved) store.reportProblem('coverage-store-write-failed'); return {ok:!file||saved,saved,id:row.id,...(file&&!saved?{reason:'coverage-store-write-failed'}:{})}
    },
  }
  stores.set(store,{rows,problem:loadProblem})
  return store
}

export async function coverageFor(store,{sessionId,requestId,root,requiredScopes=[],requiredReviews=[],readEnabled=true,signal,revisionMarker}={}) {
  const sid=safeId(sessionId), rid=safeId(requestId); if(!sid||!rid) return {rows:[],missingScopes:Array.isArray(requiredScopes)?requiredScopes:[],missingReviews:Array.isArray(requiredReviews)?requiredReviews:[],limitations:['invalid-coverage-identity']}
  const state = store && stores.get(store)
  const all = state?.rows || []
  const seen=new Set(); const selected=all.filter(r=>r.sessionId===sid&&r.requestId===rid).reverse().filter(r=>{const key=JSON.stringify([r.scope,r.focus]); if(seen.has(key))return false; seen.add(key); return true}).slice(0,COVERAGE_ROWS).reverse()
  const limitations=state ? (state.problem ? [state.problem] : []) : ['coverage-store-unavailable']; const rows=[]
  for (const r of selected) { if(signal?.aborted) throw signal.reason||new Error('cancelled'); const materials=checkMaterials(r,root,readEnabled); const invalid=(revisionMarker !== undefined && r.revisionMarker !== revisionMarker) || r.partial!==false || r.ok!==true || !r.report || !r.report.valid || !r.report.checks.length || r.report.checks.some(c=>!c.criterion || c.status!=='satisfied') || !materials.length || materials.some(m=>m.verification!=='same' || !m.sha256 || (m.status && m.status!=='ready'))
    const checks=r.report?.checks||[]; const statuses2=checks.map(c=>({...c})); const verdict=invalid ? 'unverified' : (r.report.verdict==='pass'?'pass':r.report.verdict)
    if(invalid) limitations.push('evidence-limited:'+r.id); if(revisionMarker !== undefined && r.revisionMarker !== revisionMarker) limitations.push('revision-marker-changed:'+r.id)
    rows.push({id:r.id,runId:r.runId,scope:r.scope,focus:r.focus,question:r.question||'',revisionMarker:r.revisionMarker||'',verdict,checks:statuses2,summary:r.report?.summary||'',status:invalid?(materials.some(m=>m.verification==='missing')?'missing':materials.some(m=>m.verification==='changed')?'changed':'unverified'):'current',materials:materials.map(m=>({id:m.id,path:m.path,verification:m.verification,sha256:m.sha256}))}) }
  const wanted=[...new Set((Array.isArray(requiredScopes)?requiredScopes:[]).map(x=>String(x)))];
  const reviews=(Array.isArray(requiredReviews)?requiredReviews:[]).filter(x=>typeof x?.scope==='string'&&typeof x?.focus==='string'&&x.scope.trim()&&x.focus.trim()).map(x=>({scope:x.scope,focus:x.focus}));
  if(!Array.isArray(requiredReviews) || reviews.length!==requiredReviews.length) limitations.push('required-reviews-invalid');
  const missingReviews=reviews.filter(x=>!rows.some(r=>r.scope===x.scope&&r.focus===x.focus&&r.verdict==='pass'&&r.status==='current'));
  const missingScopes=wanted.filter(scope=>!reviews.some(x=>x.scope===scope)||missingReviews.some(x=>x.scope===scope));
  for(const scope of wanted) if(!reviews.some(x=>x.scope===scope)) limitations.push('required-focus-unspecified:'+scope);
  for(const review of missingReviews) limitations.push('review-missing:'+review.scope+':'+review.focus);
  if(rows.some(r=>r.verdict==='pass')) limitations.push('scope-pass-is-focus-only'); if(!wanted.length&&!reviews.length) limitations.push('required-scopes-unspecified')
  if(!readEnabled) limitations.push('material-reread-disabled'); if(!root) limitations.push('workspace-root-unavailable')
  return {rows,missingScopes,missingReviews,limitations:[...new Set(limitations)]}
}
