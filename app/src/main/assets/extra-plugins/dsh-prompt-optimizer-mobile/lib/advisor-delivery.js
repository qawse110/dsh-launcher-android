import {createHash} from 'node:crypto'
import {isRealUserInput} from './wire.js'
import {claimEvidenceState,evidencePathIdentity} from './advisor-evidence.js'
import {revisionMarker} from './advisor-scopes.js'
import {materialPath,readBounded} from './advisor-materials.js'
const text=c=>typeof c==='string'?c:Array.isArray(c)?c.filter(b=>b.type==='text').map(b=>String(b.text||'')).join('\n'):''
const parse=a=>{try{return typeof a==='string'?JSON.parse(a):a}catch{return null}}
const safeId=s=>typeof s==='string'&&/^[A-Za-z0-9._:@-]{1,240}$/.test(s)
const clone=v=>JSON.parse(JSON.stringify(v))
function outputValue(data){const body=text(data?.content||data?.message?.content);const value=parse(body);return value&&typeof value==='object'&&!Array.isArray(value)?value:null}
// Reconstruct one displayed turn from actual public tool responses. No model text classification or stop/steer.
export function advisorDeliveryStatus({sessionId,seq,events,root=null,readEnabled=false,enabled=true}={}){
 const base={ok:true,sessionId,seq,requestId:null,status:'not-reviewed',checks:[],counts:{failed:0,unverified:0,stale:0,satisfied:0},limitations:[],completionClaimAllowed:false,scopeOnly:true}
 const unavailable=reason=>({...base,status:'unavailable',limitations:[reason]})
 if(!safeId(sessionId)||!Number.isSafeInteger(seq)||seq<0)return{...unavailable('invalid-delivery-identity'),ok:false}
 if(!enabled)return{...base,hidden:true}
 if(!Array.isArray(events))return unavailable('session-events-unavailable')
 const anchor=events.find(e=>e.seq===seq);if(!anchor)return unavailable('displayed-event-unavailable')
 const eligible=events.filter(e=>Number.isSafeInteger(e.seq)&&e.seq<=seq)
 const start=eligible.filter(e=>e.type==='turn/start').at(-1)
 const turn=eligible.filter(e=>!start||e.seq>=start.seq)
 const human=turn.filter(isRealUserInput).at(-1);if(!human)return unavailable('turn-human-request-unavailable')
 const requestId='human:'+String(human.seq);base.requestId=requestId
 const calls=new Map(),reviews=new Map();let contribution=null,declaredStage=null
 for(const e of turn){const d=e.data||{}
  if(e.type==='tool/call'||e.type==='tool/ptc-dispatch-start'){const name=d.name;if(name==='consult_task'||name==='advisor_stage')calls.set(d.subCallId||d.callId,{name,args:parse(d.arguments)||{}});continue}
  if(!['tool/result','tool/ptc-dispatch'].includes(e.type))continue
  const call=calls.get(d.subCallId||d.message?.toolCallId||d.callId);if(!call||d.isError||d.message?.isError)continue
  const out=outputValue(d);if(!out||out.sessionId&&out.sessionId!==sessionId||out.requestId&&out.requestId!==requestId)continue
  if(call.name==='advisor_stage'){if(out.ok&&out.stage?.checks)declaredStage=out.stage;continue}
  const mode=out.mode||call.args.mode
  if(mode==='develop_approach'||mode==='improve_result'){
   if(out.ok&&!out.partial&&out.report&&['suggestion','keep'].includes(out.report.verdict))contribution={out,mode};continue
  }
  if(mode!=='review_result')continue
  const scope=out.reviewScope||call.args.scope||'general',focus=out.focus||call.args.focus||call.args.question||''
  const explicit=out.stageState?.stage?.subjects||out.subjects||[]
  const observed=explicit.length?explicit:(out.materials||[]).filter(m=>m.status!=='excluded')
  const targets=[...new Set(observed.map(m=>evidencePathIdentity(m.path,root)||String(m.path||'')).filter(Boolean))].sort()
  const key=JSON.stringify([scope,focus,out.stageState?.taskId||'',out.stageState?.stage?.id||'',targets])
  const prior=reviews.get(key)
  reviews.set(key,{out,scope,focus,history:[...(prior?.history||[]),out]})
 }
 const hashes=new Map();let budget=8*1024*1024
 const version=row=>{
  if(!row?.path||!/^[a-f0-9]{64}$/i.test(row.sha256||''))return'unknown'
  if(!readEnabled||!root)return'unknown'
  try{const actual=materialPath(root,row.path);if(!hashes.has(actual)){if(hashes.size>=32)throw Error('budget');const max=Math.min(row.kind==='image'?5*1024*1024:2*1024*1024,budget);const got=readBounded(root,row.path,max);budget-=got.data.length;hashes.set(actual,createHash('sha256').update(got.data).digest('hex'))}return hashes.get(actual)===row.sha256?'same':'changed'}catch{return'missing-or-unreadable'}
 }
 const all=[]
 for(const {out,scope,focus,history}of reviews.values()){
  const unresolved=new Map()
  for(const old of history){
   const oldChecks=old.stageState?.stage?.checks||old.report?.checks||[]
   const oldAssessment=claimEvidenceState(old.report),hostBound=oldAssessment.policy==='claim-evidence-v1'&&old.evidenceAssessment?.source==='host-claim-evidence'
   const oldSubjects=old.stageState?.stage?.subjects||old.subjects||[]
   const targetFresh=oldSubjects.every(s=>version(s)==='same')
   for(const c of oldChecks){
    if(c.status==='failed')unresolved.set(c.criterion,c)
    if(c.status==='satisfied'&&old.ok&&!old.partial&&old.reviewPassed===true&&targetFresh&&oldAssessment.policy!=='invalid'){
     const deps=hostBound?c.evidenceBindings:(old.materials||[]).filter(m=>m.status!=='excluded')
     if(deps?.length&&deps.every(m=>m.kind==='record'?old.revisionMarker===revisionMarker(eligible):(m.status==='ready'||m.supported===true)&&version(m)==='same'))unresolved.delete(c.criterion)
    }
   }
   for(const c of old.openIssues||[])if(c.status==='failed'&&(!c.requestId||c.requestId===requestId))unresolved.set(c.criterion,c)
  }
  const carriedFailures=[...unresolved.values()]
  if(!out.ok||out.partial){base.limitations.push(out.partial?'consultation-interrupted':'review-unavailable');for(const c of carriedFailures||[])all.push({criterion:String(c.criterion||'Confirmed issue').slice(0,240),status:'failed',scope,focus});continue}
  const stage=out.stageState?.stage,checks=(stage?.checks||out.report?.checks||[]).map(c=>({...c}))
  for(const failure of carriedFailures||[]){const c=checks.find(x=>x.criterion===failure.criterion);if(c)c.status='failed';else checks.push({...failure,status:'failed'})}
  const assessment=claimEvidenceState(out.report),trustedBindings=assessment.policy==='claim-evidence-v1'&&out.evidenceAssessment?.source==='host-claim-evidence'
  if(assessment.policy==='invalid')base.limitations.push('claim-evidence-metadata-invalid')
  const subjects=stage?.subjects||out.subjects||[]
  const subjectChanged=subjects.some(s=>version(s)!=='same')
  for(const c of checks){
   let status=['failed','unverified','stale','satisfied'].includes(c.status)?c.status:'unverified'
   const bindings=trustedBindings?c.evidenceBindings:null
   const dependencies=Array.isArray(bindings)&&bindings.length?bindings:(out.materials||[]).filter(m=>m.status!=='excluded')
   if(status==='satisfied'&&(subjectChanged||!dependencies.length||dependencies.some(m=>m.kind==='record'?out.revisionMarker!==revisionMarker(eligible):version(m)!=='same')))status='stale'
   all.push({criterion:String(c.criterion||'Review evidence').slice(0,240),status,scope,focus:String(focus).slice(0,160),...(c.checkId||c.id?{checkId:c.checkId||c.id}:{})})
  }
  if(out.reviewPassed!==true&&!checks.some(c=>c.status!=='satisfied'))base.limitations.push('review-not-passed')
 }
 if(!reviews.size&&declaredStage)for(const c of declaredStage.checks||[])all.push({criterion:String(c.criterion||'Declared checkpoint').slice(0,240),status:c.status==='failed'?'failed':'unverified',scope:declaredStage.scope,checkId:c.id})
 for(const c of all)base.counts[c.status]++
 base.checks=all.slice(0,12);if(all.length>12)base.limitations.push('checks-omitted:'+String(all.length-12))
 base.limitations=[...new Set(base.limitations)]
 base.status=base.counts.failed?'known-defects':base.counts.unverified||base.counts.stale||base.limitations.length?'verification-pending':reviews.size?'reviewed-scope':'not-reviewed'
 if(contribution){const out=contribution.out,changed=(out.materials||[]).filter(m=>m.sent&&m.sha256).some(m=>version(m)!=='same');base.contribution={status:changed?'result-changed':out.report.verdict==='keep'?'keep':out.comparison?.status||'available',summary:String(out.report.summary||'').slice(0,500),benefitVerified:false,acceptance:false}}
 return clone(base)
}

// Host inspect() is a documented cold read and never resumes an Agent. Share only in-flight
// inspections; settled snapshots are not cached across later refreshes or permission changes.
export function createAdvisorDeliveryReader({getAgent,inspect,policy,rootFor}={}) {
 const pending=new Map()
 return async(sessionId,seq)=>{
  const access=policy?.(sessionId)||{},empty=()=>advisorDeliveryStatus({sessionId,seq,events:null,enabled:access.injectPacket===true})
  if(!safeId(sessionId)||!Number.isSafeInteger(seq)||seq<0)return empty()
  if(access.injectPacket!==true)return empty()
  try{
   let data
   if(typeof inspect==='function'){
    if(!pending.has(sessionId)){const promise=Promise.resolve().then(()=>inspect(sessionId));pending.set(sessionId,promise);promise.finally(()=>{if(pending.get(sessionId)===promise)pending.delete(sessionId)}).catch(()=>{})}
    data=await pending.get(sessionId)
    if(data==null){const agent=getAgent?.(sessionId),session=agent?.session||agent?.getSession?.();if(!session||String(session.id)!==sessionId)return empty();data={meta:{...session.header,id:session.id},events:session.snapshotEvents?.()}}
    if(String(data?.meta?.id)!==sessionId||!Array.isArray(data?.events))return empty()
   }else{
    const agent=getAgent?.(sessionId),session=agent?.session||agent?.getSession?.()
    if(!session||String(session.id)!==sessionId)return empty()
    data={meta:session.header,events:session.snapshotEvents?.()}
   }
   const current=policy?.(sessionId)||{}
   return advisorDeliveryStatus({sessionId,seq,events:data.events,root:data.meta?.cwd||rootFor?.(sessionId),enabled:current.injectPacket===true,readEnabled:current.readTools===true})
  }catch{return empty()}
 }
}
