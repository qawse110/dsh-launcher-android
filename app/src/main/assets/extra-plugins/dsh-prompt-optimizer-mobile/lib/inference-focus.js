import {createHash,randomUUID} from 'node:crypto'
import {mkdirSync,existsSync,openSync,fstatSync,readSync,closeSync,writeFileSync,renameSync} from 'node:fs'
import {join} from 'node:path'
const hash=v=>createHash('sha256').update(v).digest('hex')
const identity=v=>typeof v==='string'&&v.length>0&&v.length<=2048
const closed=i=>['closed-by-tool-evidence','closed','resolved'].includes(i?.status)
const empty=()=>({requestId:null,acknowledged:[],problem:null})
function invocationKey(issue,requestId){
 const source=issue?.source,id=source?.id||issue?.id
 if(source?.requestId!==requestId)return null
 if(!/^E\d{1,16}$/.test(id||'')||!Number.isSafeInteger(source?.seq)||id!=='E'+source.seq||!identity(source.callId)||!identity(source.tool))return null
 return hash(JSON.stringify([issue.key||null,source.requestId||null,id,source.callId,source.tool,issue.operation||null]))
}
/** A focus view, never a repair/acceptance ledger. Raw openIssues are not changed. */
export function createInferenceFocus({home=null,namespace='default',limit=256}={}){
 const cap=Number.isSafeInteger(limit)&&limit>0?Math.min(limit,1024):256
 const directory=home?join(home,'po06-inference-focus',hash(String(namespace)).slice(0,16)):null
 const sessions=new Map(),tokens=new Map();let disposed=false
 const path=sid=>join(directory,hash(sid)+'.json')
 function load(sid){
  if(sessions.has(sid))return sessions.get(sid)
  const state=empty()
  if(directory&&existsSync(path(sid)))try{
   const fd=openSync(path(sid),'r');let text
   try{const n=fstatSync(fd).size;if(n>512*1024)throw Error('focus-state-too-large');const b=Buffer.alloc(n+1);let offset=0,read;while(offset<b.length&&(read=readSync(fd,b,offset,b.length-offset,null))>0)offset+=read;if(offset!==n)throw Error('focus-state-changed');text=b.subarray(0,n).toString('utf8')}finally{closeSync(fd)}
   const {payload,integrity}=JSON.parse(text)
   if(!payload||payload.version!==1||payload.sessionId!==sid||!identity(payload.requestId)||!Array.isArray(payload.acknowledged)||payload.acknowledged.length>cap||!payload.acknowledged.every(k=>/^[a-f0-9]{64}$/.test(k))||hash(JSON.stringify(payload))!==integrity)throw Error('invalid-focus-state')
   state.requestId=payload.requestId;state.acknowledged=[...new Set(payload.acknowledged)]
  }catch{state.problem='focus-state-unavailable-or-corrupt'}
  sessions.set(sid,state);while(sessions.size>200)sessions.delete(sessions.keys().next().value)
  return state
 }
 function save(sid,state){
  if(!directory)return
  try{mkdirSync(directory,{recursive:true});const payload={version:1,sessionId:sid,requestId:state.requestId,acknowledged:state.acknowledged};const tmp=path(sid)+'.tmp-'+randomUUID();writeFileSync(tmp,JSON.stringify({payload,integrity:hash(JSON.stringify(payload))}),{encoding:'utf8',mode:0o600});renameSync(tmp,path(sid))}catch{state.problem='focus-state-write-failed'}
 }
 return {
  select({sessionId,evidence}={}){
   if(disposed||!identity(sessionId)||!evidence||!identity(evidence.requestId)||evidence.completionClaimAllowed!==false)return {evidence,token:null}
   const state=load(sessionId)
   if(state.requestId!==evidence.requestId){state.requestId=evidence.requestId;state.acknowledged=[]}
   const seen=new Set(state.acknowledged),activeIssues=[],retainedIncidents=[],pending=[]
   for(const issue of (Array.isArray(evidence.openIssues)?evidence.openIssues:[])){
    if(!issue||closed(issue))continue
    if(issue.kind!=='invocation-failure'){activeIssues.push(issue);continue}
    const key=invocationKey(issue,evidence.requestId)
    if(key&&seen.has(key))retainedIncidents.push(issue)
    else{activeIssues.push(issue);if(key)pending.push(key)}
   }
   const token=pending.length?randomUUID():null
   if(token){tokens.set(token,{sessionId,requestId:evidence.requestId,keys:[...new Set(pending)]});while(tokens.size>32)tokens.delete(tokens.keys().next().value)}
   const view={...evidence,activeIssues,retainedIncidents,mode:activeIssues.length?'diagnose':'explore',completionClaimAllowed:false,
    focusPolicy:{policy:'new-invocations-once-product-failures-persistent',activeCount:activeIssues.length,retainedInvocationCount:retainedIncidents.length,acknowledgedMeans:'delivered-to-worker-not-fixed',persistence:!!directory,limitations:['Concurrent in-flight generations may both see a new invocation before either completes.','Recorded product failures and omitted failure details stay active until actual evidence closes them.']}}
   if(state.problem)view.limitations=[...(view.limitations||[]),state.problem]
   return {evidence:view,token}
  },
  markDelivered(token){
   const entry=tokens.get(token);tokens.delete(token)
   if(!entry)return {ok:false,reason:'unknown-or-expired-focus-token'}
   const state=load(entry.sessionId)
   if(disposed||state.requestId!==entry.requestId)return {ok:false,reason:'stale-focus-request'}
   state.acknowledged=[...new Set([...state.acknowledged,...entry.keys])].slice(-cap);save(entry.sessionId,state)
   return {ok:true,recorded:entry.keys.length,meaning:'delivered-to-worker-not-fixed'}
  },
  release(token){tokens.delete(token)},
  status:()=>({ready:!disposed,policy:'new-invocations-once-product-failures-persistent',persistent:!!directory,sessions:sessions.size,completionClaimAllowed:false}),
  dispose(){disposed=true;tokens.clear();sessions.clear()},
 }
}
