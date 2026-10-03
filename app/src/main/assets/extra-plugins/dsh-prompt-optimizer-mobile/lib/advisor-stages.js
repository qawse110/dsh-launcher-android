import {readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, statSync} from 'node:fs'
import {join} from 'node:path'
import {randomUUID, createHash} from 'node:crypto'
import {materialPath,readBounded} from './advisor-materials.js'
import {ADVISOR_SCOPES} from './advisor-scopes.js'
import {renderStageSummary} from './advisor-context.js'

const copy=x=>JSON.parse(JSON.stringify(x))
const text=(x,n)=>typeof x==='string' && x.trim() && x.length<=n
const safe=x=>text(x,240) && /^[A-Za-z0-9._:@-]+$/.test(x)
const fingerprint=x=>typeof x==='string' && /^[a-f0-9]{64}$/.test(x)
const pathsOK=x=>Array.isArray(x) && x.length<=8 && x.every(p=>text(p,1000))
const materialsOK=ms=>Array.isArray(ms) && ms.length<=8 && ms.every(m=>m && text(m.path,1000) && ['file','image'].includes(m.kind) && ['ready','truncated','unavailable','not-inspected'].includes(m.status) && (m.sha256===null || m.sha256===undefined || fingerprint(m.sha256)))
const fail=reason=>({ok:false,reason})
const hash=b=>createHash('sha256').update(b).digest('hex')
export const STAGE_LIMITS={tasks:8,stages:12,checks:8,bytes:20*1024*1024,summaryChars:2200}

// Explicit tasks isolate follow-up discussions; no domain-specific phase templates.
export function createAdvisorStages({home}={}) {
 const cache=new Map(),problems=new Map()
 const file=sid=>home ? join(home,'po06-advisor-stages',sid+'.json') : null
 const load=sid=>{
  if(!safe(sid)) throw new Error('invalid-session-id')
  if(cache.has(sid))return cache.get(sid)
  let state={version:1,sessionId:sid,activeTaskId:null,tasks:[]}
  const p=file(sid)
  if(p && existsSync(p)) {
   try {
    if(statSync(p).size>512*1024)throw new Error('oversized')
    const v=JSON.parse(readBounded(home,'po06-advisor-stages/'+sid+'.json',512*1024).data.toString('utf8'))
    if(v.version!==1 || v.sessionId!==sid || !Array.isArray(v.tasks) || v.tasks.length>STAGE_LIMITS.tasks)throw new Error('invalid')
    if(v.activeTaskId!==null && !v.tasks.some(t=>t.id===v.activeTaskId))throw new Error('invalid-active-task')
    for(const t of v.tasks) {
     if(!safe(t.id)||!text(t.title,300)||!safe(t.sourceRequestId)||!Array.isArray(t.stages)||t.stages.length>STAGE_LIMITS.stages)throw new Error('invalid-task')
     if(t.activeStageId!==null && !t.stages.some(s=>s.id===t.activeStageId))throw new Error('invalid-active-stage')
     if(!text(t.sourceText,4000) || new Set(t.stages.map(s=>s.id)).size!==t.stages.length)throw new Error('invalid-task-source')
     for(const [i,s] of t.stages.entries()) {
      if(s.id!=='S'+(i+1)||!ADVISOR_SCOPES.includes(s.scope)||s.scope==='delivery'||!text(s.focus,500)||!Array.isArray(s.checks)||!s.checks.length||s.checks.length>8||!materialsOK(s.materials)||!pathsOK(s.subjectPaths || [])||!materialsOK(s.subjects || [])||s.pendingReviewId && !safe(s.pendingReviewId)||s.checks.some((c,n)=>c.id!==s.id+'.K'+(n+1)||!text(c.criterion,500)||!['satisfied','failed','unverified','stale'].includes(c.status)||!Array.isArray(c.evidenceRefs)||c.evidenceRefs.length>12||c.evidenceRefs.some(ref=>!text(ref,180))))throw new Error('invalid-stage')
     }
    }
    state=v
   }catch {problems.set(sid,'stage-store-invalid')}
  }
  cache.set(sid,state);return state
 }
 const mutate=(sid,fn)=>{
  let state;try{state=load(sid)}catch(e){return fail(e.message)}
  if(problems.has(sid))return fail(problems.get(sid))
  const draft=copy(state),res=fn(draft)
  if(!res.ok)return res
  const p=file(sid)
  const encoded=JSON.stringify(draft)
  if(Buffer.byteLength(encoded)>512*1024)return fail('stage-store-capacity')
  if(p) {
   const tmp=p+'.tmp-'+randomUUID()
   try{mkdirSync(join(home,'po06-advisor-stages'),{recursive:true});writeFileSync(tmp,encoded,'utf8');renameSync(tmp,p)}
   catch {problems.set(sid,'stage-store-write-failed');return fail('stage-store-write-failed')}
  }
  cache.set(sid,draft);return copy(res)
 }
 const task=(state,id)=>state.tasks.find(t=>t.id===(id || state.activeTaskId))
 const inspect=(stage,opts={})=>{
  const result=copy(stage), budget=opts.budget || {left:STAGE_LIMITS.bytes,hashes:new Map()}
  let fresh=stage.materials.length>0 && stage.invalidated!==true
  if(['geometry','appearance'].includes(stage.scope) && !(stage.subjectPaths || []).length)fresh=false
  const limitations=[]
  const versionTargets=stage.subjects || []
  for(const m of [...stage.materials,...versionTargets]) {
   if(m.status!=='ready' || !m.sha256 || !opts.readEnabled || !opts.root){fresh=false;limitations.push('evidence-unavailable');continue}
   try {
    const p=materialPath(opts.root,m.path),st=statSync(p),cap=m.kind==='image'?5*1024*1024:2*1024*1024
    if(!st.isFile() || st.size>cap)throw new Error('evidence-limit')
    if(!budget.hashes.has(p)) {
     if(st.size>budget.left || budget.hashes.size>=32)throw new Error('evidence-limit')
     const bounded=readBounded(opts.root,m.path,Math.min(cap,budget.left))
     budget.left-=bounded.data.length;budget.hashes.set(bounded.actual,hash(bounded.data))
    }
    if(budget.hashes.get(p)!==m.sha256){fresh=false;limitations.push('evidence-changed')}
   }catch {fresh=false;limitations.push('evidence-missing-or-unreadable')}
  }
  if(!fresh)for(const c of result.checks)if(c.status==='satisfied')c.status='stale'
  const failed=result.checks.filter(c=>c.status==='failed')
  const pending=result.checks.filter(c=>c.status!=='satisfied')
  result.advanceAllowed=fresh && !pending.length && stage.lastVerdict==='pass'
  if(!stage.materials.length) limitations.push('evidence-not-provided')
  result.action=failed.length?'repair':result.advanceAllowed?'advance':(stage.materials.length || versionTargets.length) && (!opts.readEnabled || !opts.root)?'ask-user':'collect-evidence'
  if(stage.lastFailure) limitations.push(stage.lastFailure)
  result.bindingScope=versionTargets.length?'declared-targets':'evidence-only'
  if(!versionTargets.length) limitations.push('subject-binding-unspecified')
  result.limitations=[...new Set(limitations)]
  return result
 }
 const store={
  startTask({sessionId,title,sourceRequestId,sourceText}={}) {
   if(!text(title,300)||!safe(sourceRequestId)||!text(sourceText,4000))return fail('invalid-task-input')
   return mutate(sessionId,state=>{
    const prior=state.tasks.find(t=>t.sourceRequestId===sourceRequestId)
    if(prior) {state.activeTaskId=prior.id;return {ok:true,taskId:prior.id,reused:true}}
    const t={id:'T'+randomUUID(),title,sourceRequestId,sourceText,activeStageId:null,stages:[]}
    state.tasks.push(t);state.tasks=state.tasks.slice(-STAGE_LIMITS.tasks);state.activeTaskId=t.id
    return {ok:true,taskId:t.id}
   })
  },
  defineStage({sessionId,taskId,scope,focus,criteria,subjectPaths=[],root,readEnabled}={}) {
   if(!ADVISOR_SCOPES.includes(scope)||scope==='delivery'||!text(focus,500)||!Array.isArray(criteria)||!criteria.length||criteria.length>8||criteria.some(c=>!text(c,500)))return fail('invalid-stage-input')
   if(!pathsOK(subjectPaths))return fail('invalid-subject-paths')
   if(['geometry','appearance'].includes(scope) && !subjectPaths.length)return fail('stage-subject-required')
   return mutate(sessionId,state=>{
    const t=task(state,taskId);if(!t || t.id!==state.activeTaskId)return fail('inactive-task')
    const budget={left:STAGE_LIMITS.bytes,hashes:new Map()}
    const prev=t.stages.find(s=>s.id===t.activeStageId)
    const previous=prev ? inspect(prev,{root,readEnabled,budget}) : null
    if(previous && !previous.advanceAllowed)return {ok:false,reason:'previous-stage-unresolved',stage:previous}
    if(t.stages.filter(s=>s.id!==prev?.id).some(s=>!inspect(s,{root,readEnabled,budget}).advanceAllowed))return fail('dependency-stage-unresolved')
    if(t.stages.length>=STAGE_LIMITS.stages)return fail('stage-limit')
    const s={id:'S'+(t.stages.length+1),scope,focus,subjectPaths:[...new Set(subjectPaths)],subjects:[],materials:[],checks:criteria.map((criterion,i)=>({id:'S'+(t.stages.length+1)+'.K'+(i+1),criterion,status:'unverified',evidenceRefs:[]})),lastReviewId:null}
    t.stages.push(s);t.activeStageId=s.id
    return {ok:true,taskId:t.id,stage:inspect(s,{root,readEnabled})}
   })
  },
  activateStage({sessionId,taskId,stageId}={}) {
   return mutate(sessionId,state=>{
    const t=task(state,taskId),s=t?.stages.find(s=>s.id===stageId)
    if(!t||t.id!==state.activeTaskId||!s)return fail('inactive-review-stage')
    t.activeStageId=s.id;return {ok:true,taskId:t.id,stageId:s.id}
   })
  },
  reviewSpec({sessionId,taskId,stageId}={}) {
   let st;try{st=load(sessionId)}catch(e){return fail(e.message)}
   if(problems.has(sessionId))return fail(problems.get(sessionId))
   const t=task(st,taskId),s=t?.stages.find(s=>s.id===stageId)
   if(!t||t.id!==st.activeTaskId||!s||s.id!==t.activeStageId)return fail('inactive-review-stage')
   return {ok:true,taskId:t.id,sourceRequestId:t.sourceRequestId,sourceText:t.sourceText,stage:copy(s)}
  },
  setSubjects({sessionId,taskId,stageId,subjectPaths}={}) {
   if(!pathsOK(subjectPaths))return fail('invalid-subject-paths')
   return mutate(sessionId,state=>{
    const t=task(state,taskId),s=t?.stages.find(s=>s.id===stageId)
    if(!t||t.id!==state.activeTaskId||!s||s.id!==t.activeStageId)return fail('inactive-review-stage')
    if(['geometry','appearance'].includes(s.scope) && !subjectPaths.length)return fail('stage-subject-required')
    s.subjectPaths=[...new Set(subjectPaths)];s.invalidated=true;s.pendingReviewId=null;s.lastVerdict='unverified'
    return {ok:true,taskId:t.id,stageId:s.id,action:'collect-evidence'}
   })
  },
  prepareReview({sessionId,taskId,stageId,root,readEnabled,materials=[]}={}) {
   const spec=store.reviewSpec({sessionId,taskId,stageId});if(!spec.ok)return spec
   const inputs=[...new Set([...(spec.stage.subjectPaths || []),...materials.filter(m=>m.kind==='file' && m.status!=='excluded').map(m=>m.path)])]
   const subjects=[],budget={left:STAGE_LIMITS.bytes}
   let problem=null
   if(inputs.length>8)return fail('subject-path-limit')
   for(const path of inputs) {
    const row={path,kind:'file',status:'unavailable',sha256:null}
    if(!readEnabled || !root) {problem='subject-read-disabled'}
    else try {
     const bounded=readBounded(root,path,Math.min(2*1024*1024,budget.left));budget.left-=bounded.data.length
     row.status='ready';row.sha256=hash(bounded.data)
    }catch {problem='subject-unavailable'}
    subjects.push(row)
   }
   if(['geometry','appearance'].includes(spec.stage.scope)) {
    if(!subjects.length)problem='subject-binding-unspecified'
    const changed=!!spec.stage.lastReviewId && subjects.some(m=>!(spec.stage.subjects || []).some(old=>old.path===m.path && old.sha256===m.sha256))
    const images=materials.filter(m=>m.kind==='image' && m.status==='ready' && m.evidenceType!=='reference')
    const reused=images.some(m=>spec.stage.materials.some(old=>old.kind==='image' && old.evidenceType!=='reference' && old.sha256===m.sha256))
    if(!images.length)problem='visual-current-evidence-unavailable'
    if(changed && reused)problem='visual-evidence-stale-after-subject-change'
   }
   const attemptId='A'+randomUUID()
   const saved=mutate(sessionId,state=>{
    const t=task(state,taskId),s=t?.stages.find(s=>s.id===stageId)
    if(!s || s.id!==t.activeStageId)return fail('inactive-review-stage')
    s.pendingReviewId=attemptId;s.hasPreparedReview=true;s.invalidated=true;s.lastFailure=null;s.lastVerdict='unverified'
    return {ok:true,attemptId,subjects,subjectProblem:problem}
   })
   return saved
  },
  reviewFailed({sessionId,taskId,stageId,reason,attemptId}={}) {
   return mutate(sessionId,state=>{
    const t=task(state,taskId),s=t?.stages.find(s=>s.id===stageId)
    if(!t||t.id!==state.activeTaskId||!s||s.id!==t.activeStageId)return fail('inactive-review-stage')
    if(attemptId && s.pendingReviewId!==attemptId)return fail('stale-review-attempt')
    s.pendingReviewId=null;s.invalidated=true;s.lastVerdict='unverified';s.lastFailure=String(reason || 'review-unavailable').slice(0,120)
    return {ok:true}
   })
  },
  recordReview({sessionId,taskId,stageId,reviewId,report,materials,subjects=[],attemptId,partial=false}={}) {
   if(!safe(reviewId)||!report||!Array.isArray(report.checks)||!report.checks.length||report.checks.length>8)return fail('invalid-stage-report')
   return mutate(sessionId,state=>{
    const t=task(state,taskId),s=t?.stages.find(s=>s.id===stageId)
    if(!t||t.id!==state.activeTaskId||!s||s.id!==t.activeStageId)return fail('inactive-review-stage')
    if((s.hasPreparedReview || attemptId!==undefined) && (!s.pendingReviewId || s.pendingReviewId!==attemptId))return fail('stale-review-attempt')
    if(!Array.isArray(subjects)||subjects.length>8||subjects.some(m=>!text(m.path,1000)||!['ready','unavailable'].includes(m.status)||m.status==='ready'&&!fingerprint(m.sha256)))return fail('invalid-review-subjects')
    if(s.subjectPaths?.some(path=>!subjects.some(m=>m.path===path)))return fail('missing-review-subject')
    const ids=new Set(report.checks.map(c=>c.checkId))
    if(ids.size!==report.checks.length || report.checks.some(c=>!s.checks.some(k=>k.id===c.checkId)||!['satisfied','failed','unverified'].includes(c.status)||!Array.isArray(c.evidenceRefs)||c.status==='satisfied'&&!c.evidenceRefs.length))return fail('stage-check-id-mismatch')
    if(!['pass','gaps','unverified','need_user'].includes(report.verdict))return fail('invalid-stage-verdict')
    if(report.checks.some(c=>c.evidenceRefs.length>12 || c.evidenceRefs.some(r=>!text(r,180))))return fail('invalid-stage-citation')
    if(!Array.isArray(materials))return fail('invalid-stage-material')
    const ms=materials.filter(m=>m?.status!=='excluded')
    if(!materialsOK(ms))return fail('invalid-stage-material')
    if(ms.length>8)return fail('stage-material-limit')
    s.subjects=subjects.map(m=>({path:m.path,kind:'file',status:m.status,sha256:m.sha256 || null}))
    s.materials=ms.map(m=>({path:m.path,kind:m.kind,status:m.status,sha256:m.sha256,evidenceType:m.evidenceType||'other'}))
    for(const c of s.checks) {
     const reviewed=report.checks.find(x=>x.checkId===c.id)
     if(reviewed) {c.status=partial?'unverified':reviewed.status;c.evidenceRefs=reviewed.evidenceRefs.slice(0,12);c.lastReviewId=reviewId}
     else if(c.status==='satisfied')c.status='stale'
    }
    s.invalidated=false;s.pendingReviewId=null;s.lastFailure=null; s.lastReviewId=reviewId; s.lastVerdict=partial?'unverified':report.verdict
    return {ok:true,taskId:t.id,stageId:s.id}
   })
  },
  status({sessionId,root,readEnabled}={}) {
   let state;try{state=load(sessionId)}catch(e){return fail(e.message)}
   const t=task(state),s=t?.stages.find(s=>s.id===t.activeStageId)
   const budget={left:STAGE_LIMITS.bytes,hashes:new Map()}
   const inspected=s?inspect(s,{root,readEnabled,budget}):null
   const dependencyStages=t?.stages.filter(k=>k.id!==s?.id).map(k=>inspect(k,{root,readEnabled,budget})).filter(k=>!k.advanceAllowed).map(k=>k.id)||[]
   return {ok:!problems.has(sessionId),advanceAllowed:!problems.has(sessionId) && inspected?.advanceAllowed===true && dependencyStages.length===0,dependencyStages,reason:problems.get(sessionId)||null,taskId:t?.id||null,title:t?.title||null,sourceRequestId:t?.sourceRequestId||null,
    stage:inspected,action:problems.has(sessionId)?'report-store-error':!t?'start-task':!s?'define-stage':inspected.action==='repair'?'repair':dependencyStages.length?'review-dependency':inspected.action,
    declaredCheckpointsOnly:true}
  },
  invalidate({sessionId,path}={}) {
   if(!text(path,1000))return fail('invalid-invalidation-path')
   return mutate(sessionId,state=>{
    const t=task(state);if(!t)return fail('inactive-task')
    const norm=p=>p.replaceAll(String.fromCharCode(92),'/').toLowerCase()
    let count=0
    for(const s of t.stages)if([...s.materials,...(s.subjects || [])].some(m=>norm(m.path)===norm(path))) {s.invalidated=true;count++}
    return {ok:true,invalidatedStages:count}
   })
  },
  advance({sessionId,taskId,stageId,root,readEnabled}={}) {
   const spec=store.reviewSpec({sessionId,taskId,stageId});if(!spec.ok)return spec
   const t=task(load(sessionId),spec.taskId),budget={left:STAGE_LIMITS.bytes,hashes:new Map()}
   const dependencies=t.stages.filter(s=>s.id!==stageId).map(s=>inspect(s,{root,readEnabled,budget})).filter(s=>!s.advanceAllowed)
   if(dependencies.length)return {ok:false,reason:'dependency-stage-unresolved',action:dependencies.some(s=>s.action==='repair')?'repair':'collect-evidence',stageIds:dependencies.map(s=>s.id)}
   const s=inspect(spec.stage,{root,readEnabled,budget})
   return s.advanceAllowed ? {ok:true,taskId:spec.taskId,stageId,action:'define-next-stage',declaredCheckpointsOnly:true} : {ok:false,reason:'stage-unresolved',stage:s,action:s.action}
  },
  summary(opts) { return renderStageSummary(store.status(opts)) },
  archive({sessionId}={}) {try{return copy(load(sessionId))}catch(e){return fail(e.message)}},
 }
 return store
}
