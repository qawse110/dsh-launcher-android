import {isRealUserInput} from './wire.js'
const relevant=new Set(['user/message','tool/call','tool/result','tool/ptc-dispatch-start','tool/ptc-dispatch'])
const unavailable=(reason,requestId=null)=>({version:1,requestId,mode:'explore',openIssues:[],recentEvidence:[],limitations:[reason],completionClaimAllowed:false})
/** Bridge only existing live sessions and actually assembled request history. No agent creation. */
export function createInferenceEvidenceContext({store,getSession,policy,rootFor=session=>session.header?.cwd}={}){
 const primed=new WeakMap()
 function context(session){const p=policy(String(session.id));return{enabled:p?.reasoningBoost===true,root:rootFor(session),readEnabled:p?.readTools===true}}
 return {
  observe(session,event){
   if(!session?.id||!relevant.has(event?.type))return
   try{const ctx=context(session)
    if(!ctx.enabled){if(isRealUserInput(event))store.clear(String(session.id));return}
    store.observe(session,event,ctx)
   }catch{/* Observation must not stop the actual tool or user request. */}
  },
  evidenceFor(options){
   try{
    const sid=String(options.sessionId||''),session=getSession(sid)
    if(!session||String(session.id)!==sid)return unavailable('session-unavailable')
    const ctx=context(session);if(!ctx.enabled)return unavailable('boost-disabled')
    const events=session.snapshotEvents?.()
    if(!Array.isArray(events))return unavailable('session-evidence-unavailable')
    const actual=events.filter(isRealUserInput).at(-1)
    if(!actual||!Number.isSafeInteger(actual.seq))return unavailable('request-evidence-unavailable')
    const requestId='human:'+actual.seq,actualMessage=actual.data?.message||actual.data
    const source=(options.messages||[]).filter(m=>m.role==='user'&&m.source?.kind==='user').at(-1)
    // A new turn or branch must never receive evidence from a different user's message.
    if(!source?.id||source.id!==actualMessage?.id)return unavailable('request-source-unmatched',requestId)
    if(primed.get(session)!==requestId){store.seed(session,ctx);primed.set(session,requestId)}
    return store.snapshot({sessionId:sid,requestId,root:ctx.root,readEnabled:ctx.readEnabled})
   }catch{return unavailable('evidence-context-unavailable')}
  },
  status:()=>store.status(),
  dispose:()=>store.dispose?.(),
 }
}
