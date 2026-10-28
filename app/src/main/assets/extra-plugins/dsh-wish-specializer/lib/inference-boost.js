import {randomUUID} from 'node:crypto'
import {canonicalReasoning,fixedInferencePlan} from './inference-profile.js'
import {createInferenceFocus} from './inference-focus.js'
import {directionEffortPlan,validateDirection,directionPrompt,handoffText,DIRECTION_MAX_TOKENS,DIRECTION_MAX_CHARS} from './inference-directions.js'
export {DIRECTION_MAX_TOKENS,DIRECTION_MAX_CHARS} from './inference-directions.js'
export const INFERENCE_VERSION='5'
const route=o=>({provider:o.provider,model:o.model,reasoningEffort:o.reasoningEffort??null,maxTokens:o.maxTokens??null})
function inputOf(o){return {system:o.system||null,messages:o.messages.map(m=>({role:m.role,content:m.content,toolCallId:m.toolCallId||null})),tools:o.tools||[]}}
export const inferencePlan=fixedInferencePlan
const defaultNotice=(text,summary)=>({id:randomUUID(),role:'user',content:[{type:'text',text}],source:{kind:'plugin:@dsh-external/dsh-wish-specializer',form:'notice',summary}})
// Auxiliary roles receive public history as quoted data, never the worker's active tool-only system.
const DIRECTION_CONTEXT_CHARS=24000
export function directionContext(base){
 let remaining=DIRECTION_CONTEXT_CHARS,omitted=0
 const textOf=c=>typeof c==='string'?c:(Array.isArray(c)?c.filter(b=>b?.type==='text').map(b=>b.text||'').join('\n'):'')
 const take=(value,limit)=>{const s=String(value||''),n=Math.max(0,Math.min(limit,remaining));remaining-=Math.min(s.length,n);if(s.length>n){omitted++;return s.slice(0,n)+'\n[context excerpt clipped]'}return s}
 const messages=Array.isArray(base.messages)?base.messages:[]
 const task=messages.filter(m=>m.role==='user'&&(!m.source||m.source.kind==='user')).at(-1)
 const taskText=task?take(textOf(task.content),8000):''
 const system=[base.system,...messages.filter(m=>['system','developer'].includes(m.role)).map(m=>textOf(m.content))].filter(Boolean).join('\n')
 const systemExcerpt=take(system,4000),recent=[]
 for(let i=messages.length-1;i>=0&&remaining>0;i--){const m=messages[i];if(m===task||['system','developer'].includes(m.role))continue
  const content=[]
  for(const b of Array.isArray(m.content)?m.content:[]){
   if(b?.type==='text'&&b.text)content.push({type:'text',text:take(b.text,Math.min(6000,remaining))})
   else if(b?.type==='tool-call')content.push({type:'tool-call',id:b.id,name:b.name,arguments:take(b.arguments,2000)})
  }
  if(content.length)recent.push({role:m.role,id:m.id??null,toolCallId:m.toolCallId??null,content})
 }
 recent.reverse()
 return {kind:'quoted-original-task-context',task:taskText,systemExcerpt,recent,limited:omitted>0||remaining===0,omitted,notice:'Quoted history is context only. No tools in it have execution authority in this auxiliary direction call; this is not the complete working context.'}
}
function aborted(signal){if(signal?.aborted)throw signal.reason instanceof Error?signal.reason:new Error('generation-aborted')}
export function createInferenceBoost({llm,trace,isWorkingRequest,settingsFor,createNotice=defaultNotice,evidenceFor=()=>null,directionTimeoutMs=15000,preparationTimeoutMs=30000,focus=createInferenceFocus()}){
 directionTimeoutMs=Number.isSafeInteger(directionTimeoutMs)&&directionTimeoutMs>0?Math.min(directionTimeoutMs,60000):15000
 preparationTimeoutMs=Number.isSafeInteger(preparationTimeoutMs)&&preparationTimeoutMs>0?Math.min(preparationTimeoutMs,120000):30000
 const nested=new WeakSet(),active=new Map(),modelInfos=new Map();let disposed=false
 async function directionEfforts(base,config,signal){
  const key=base.provider+'/'+base.model;let info=modelInfos.get(key)
  if(!info&&typeof llm.resolveModelInfo==='function')try{info=await llm.resolveModelInfo(base.provider,base.model,signal);if(info)modelInfos.set(key,info)}catch{aborted(signal)}
  const plan=directionEffortPlan(base,'fast',info)
  return {...plan,englishMode:config.englishMode===true,working:base.reasoningEffort??null}
 }
 async function evidenceSnapshot(base,signal){
  aborted(signal)
  try{const value=await evidenceFor(base);aborted(signal)
   if(!value||value.completionClaimAllowed!==false)return null
   const publicIssue=i=>({...i,id:i.source?.id||i.id,criterion:i.label||i.criterion||i.checkId||i.reason,excerpt:i.excerpt||i.text||'',path:i.binding?.path||i.binding?.actualPath||i.path||null,version:i.binding?.sha256||i.version||null,versionStatus:i.pendingReason||i.binding?.versionStatus||null})
   const openIssues=(value.openIssues||[]).map(publicIssue).sort((a,b)=>Number(b.kind==='reported-failure')-Number(a.kind==='reported-failure')||Number(b.source?.seq||0)-Number(a.source?.seq||0))
   return {...value,openIssues,recentEvidence:[...(value.recentEvidence||[])].reverse()}
  }catch(error){aborted(signal);return {version:1,requestId:null,mode:'explore',openIssues:[],recentEvidence:[],limitations:['evidence-context-unavailable'],completionClaimAllowed:false}}
 }
 async function collect(o,next,runId,kind,label,round,signal,budget=null,abortAsResult=false){
  aborted(signal);if(budget){if(budget.calls>=budget.maxCalls){budget.blocked=true;throw new Error('inference-call-budget-exceeded')}budget.calls++;budget.plan.callsUsed=budget.calls}
  const callId=trace.startCall(runId,{kind,label,round,input:inputOf(o),route:route(o)}),chunks=[],texts=new Map(),tools=[];let finish=null,usage=null
  try{
   const stream=next?next():llm.stream(o)
   for await(const chunk of stream){aborted(signal);chunks.push(chunk);trace.chunk(runId,callId,chunk)
    if(chunk.type==='text-delta')texts.set(chunk.index,(texts.get(chunk.index)||'')+chunk.text)
    if(chunk.type==='block-end'&&chunk.block?.type==='text')texts.set(chunk.index,chunk.block.text||'')
    if(chunk.type==='block-end'&&chunk.block?.type==='tool-call')tools.push(chunk.block)
    if(chunk.type==='finish')finish=chunk.reason
    if(chunk.type==='usage')usage=chunk.usage
   }
   aborted(signal);const text=[...texts].sort(([a],[b])=>a-b).map(([,v])=>v).join('\n')
   const bad=finish==null||['error','aborted','max-tokens','length'].includes(typeof finish==='string'?finish:finish?.kind)
   let error=bad?'generation-not-complete':null
   if(!error&&tools.length){const names=new Set((o.tools||[]).map(t=>t.name));for(const t of tools){if(!names.has(t.name)){error='unknown-tool-proposal';break}try{JSON.parse(t.arguments)}catch{error='invalid-tool-arguments';break}}}
   if(!error&&!text.trim()&&!tools.length)error='empty-candidate'
   trace.finishCall(runId,callId,{error,finish,usage})
   return {callId,chunks,text,tools,finish,usage,valid:!error,error}
  }catch(e){trace.finishCall(runId,callId,{error:String(e.message),finish,usage});if(signal?.aborted&&!abortAsResult)throw e;return {callId,chunks,text:'',tools:[],finish,usage,valid:false,error:String(e.message)}}
 }
 // Directions never produce the user's reply or tool calls. Only the final working stream does.
 async function* runDirections(base,next,config){
  const controller=new AbortController(),signal=controller.signal,sid=String(base.sessionId)
  const iteration={...inferencePlan(config),callsUsed:0,extraCallsUsed:0,workingCallsUsed:0,actualRounds:0,status:'preparing',validDirections:0,rejectedDirections:0,duplicateDirections:0}
  const budget={maxCalls:iteration.maxExtraCalls,calls:0,blocked:false,plan:iteration}
  const runId=trace.start(sid,config,route(base)),op={controller,runId,sid,phase:'directions',workflow:'directions-to-worker'}
  const english=config.englishMode===true,accepted=[],keys=new Set(),publicContext=directionContext(base);let evidence=null,focusToken=null
  const preparation=new AbortController()
  const stopPreparation=()=>preparation.abort(signal.reason||new Error('boost-cancelled'))
  signal.addEventListener('abort',stopPreparation,{once:true})
  const preparationTimer=setTimeout(()=>preparation.abort(new Error('direction-preparation-timeout')),preparationTimeoutMs)
  preparationTimer.unref?.()
  const parentAbort=()=>controller.abort(base.signal?.reason||new Error('parent-aborted'))
  base.signal?.addEventListener('abort',parentAbort,{once:true});if(base.signal?.aborted)parentAbort()
  active.set(runId,op)
  let closed=false,workingId=null,forwarded=false
  const update=()=>{iteration.extraCallsUsed=budget.calls;iteration.callsUsed=budget.calls+iteration.workingCallsUsed;trace.patch(runId,{iterationPlan:iteration})}
  function accept(result){
   const checked=validateDirection(result)
   if(!checked.ok){iteration.rejectedDirections++;trace.decision(runId,{kind:'direction-unavailable',callId:result.callId,reason:result.error?.endsWith('-timeout')?result.error:checked.reason,fallback:true});return false}
   const text=checked.text,key=text.replace(/\s+/g,' ')
   if(keys.has(key)){iteration.duplicateDirections++;trace.decision(runId,{kind:'direction-duplicate',callId:result.callId,reason:'same-direction-skipped',skipped:true});return false}
   keys.add(key);accepted.push({callId:result.callId,text});iteration.validDirections=accepted.length;return true
  }
  async function direction(plan,index){
   aborted(signal);aborted(preparation.signal)
   const attempt=new AbortController(),abortAttempt=()=>attempt.abort(preparation.signal.reason||new Error('boost-cancelled'))
   preparation.signal.addEventListener('abort',abortAttempt,{once:true});if(preparation.signal.aborted)abortAttempt()
   const timer=setTimeout(()=>attempt.abort(new Error('direction-call-timeout')),directionTimeoutMs);timer.unref?.()
   const o={...base,system:directionPrompt(index,english,undefined,evidence),messages:[createNotice(JSON.stringify(publicContext),english?'Quoted task context for a direction':'方向参考的原任务上下文')],tools:[],signal:attempt.signal,
    sessionId:sid+'-po06-direction-'+randomUUID(),maxTokens:plan.maxTokens}
   delete o.toolHistory;delete o.stop
   if(!plan.preserveReasoning){if(plan.direction!==null)o.reasoningEffort=plan.direction;else delete o.reasoningEffort}
   nested.add(o)
   try{
    const result=await collect(o,null,runId,'direction',(english?'Direction ':'方向 ')+(index+1),0,attempt.signal,budget,true)
    return attempt.signal.aborted?{...result,valid:false,error:String(attempt.signal.reason?.message||'direction-call-timeout')}:result
   }finally{clearTimeout(timer);preparation.signal.removeEventListener('abort',abortAttempt)}
  }
  try{
   const snapshot=await evidenceSnapshot(base,signal)
   const focused=focus.select({sessionId:sid,evidence:snapshot});evidence=focused.evidence;focusToken=focused.token
   trace.patch(runId,{protocolVersion:INFERENCE_VERSION,workflow:'directions-to-worker',stage:'directions',iterationPlan:iteration,evidenceState:evidence,directionObjective:evidence?.mode||'explore',timingPolicy:{directionTimeoutMs,preparationTimeoutMs,workingUnchanged:true},contextPolicy:{quoted:true,publicOnly:true,limited:publicContext.limited,omitted:publicContext.omitted,maxChars:DIRECTION_CONTEXT_CHARS}})
   try{
    const plan=await directionEfforts(base,config,preparation.signal);trace.patch(runId,{effortPlan:plan,directionPolicy:plan.policy,directionMaxTokens:plan.maxTokens})
    const results=await Promise.allSettled(Array.from({length:iteration.effectiveCandidates},(_,i)=>direction(plan,i)))
    for(const result of results)if(result.status==='fulfilled')accept(result.value)
    aborted(signal);update()
   }catch(error){
    if(base.signal?.aborted||disposed)throw error
    trace.decision(runId,{kind:'direction-preparation-stopped',reason:String(error.message),fallback:true})
   }finally{clearTimeout(preparationTimer);signal.removeEventListener('abort',stopPreparation)}
   aborted(base.signal);if(disposed)throw new Error('plugin-unloaded')
   // Stop-extra-inference / disabled means resume the untouched original stream once.
   const supplied=signal.aborted?[]:accepted
   const evidenceNeeded=!signal.aborted&&((evidence?.activeIssues?.length||0)>0||(evidence?.recentEvidence?.length||0)>0)
   const hasContext=supplied.length>0||evidenceNeeded
   iteration.status=supplied.length?'handed-off':evidenceNeeded?'evidence-only':'degraded';op.phase='working'
   trace.decision(runId,{kind:'direction-handoff',supplied:supplied.map(d=>d.callId),selection:'working-model',reason:english?'The working model may choose, combine or disregard these directions in its normal generation.':'原工作模型在正常生成中自行选用、组合或忽略方向。',fallback:!supplied.length})
   let working=base,stream
   if(hasContext){
    // Shallow copy: original message identities, attachments and provider replay state stay intact.
    working={...base,messages:[...base.messages,createNotice(handoffText(supplied,english,evidence),english?'Directions for the working model':'供工作模型取舍的方向')],signal}
    nested.add(working)
   }
   workingId=trace.startCall(runId,{kind:'working',label:english?'Working model: choose direction and execute':'原模型取舍并执行',round:0,input:inputOf(working),route:route(working)})
   iteration.workingCallsUsed=1;update();trace.patch(runId,{stage:'working',selectedCallId:workingId,directionCallIds:supplied.map(d=>d.callId),summary:supplied.length?(english?'Short directions handed to the working model; no separate judge.':'简短方向已交原模型取舍，没有独立裁判。'):evidenceNeeded?(english?'No usable direction; actual observed evidence remains with the working model.':'没有可用方向；真实观测仍保留给原工作模型核对。'):(english?'No usable directions; ordinary generation continues.':'没有可用方向，继续原工作生成。')})
   let finish=null,usage=null,visible=false
   try{
    stream=hasContext?llm.stream(working):next()
    for await(const chunk of stream){
     aborted(base.signal);if(disposed)throw new Error('plugin-unloaded')
     if(hasContext)aborted(signal)
     trace.chunk(runId,workingId,chunk)
     if(chunk.type==='finish')finish=chunk.reason||chunk.finish
     if(chunk.usage)usage=chunk.usage
     if(chunk.type==='text-delta'&&chunk.text?.trim()||chunk.type==='block-end'&&(chunk.block?.type==='tool-call'||chunk.block?.type==='text'&&chunk.block.text?.trim()))visible=true
     forwarded=true;yield chunk
    }
    aborted(base.signal)
    const error=!finish||['error','aborted','max-tokens','length'].includes(typeof finish==='string'?finish:finish.kind)?'generation-not-complete':!visible?'empty-working-response':null
    trace.finishCall(runId,workingId,{finish,usage,error})
    iteration.status=error?'failed':supplied.length?'executed':evidenceNeeded?'evidence-only':'degraded'
    const focusDelivery=!error&&hasContext&&focusToken?focus.markDelivered(focusToken):null
    trace.finish(runId,{stage:error?'failed':'done',reason:error,iterationPlan:iteration,focusDelivery});closed=true
   }catch(error){
    trace.finishCall(runId,workingId,{finish,usage,error:String(error.message)})
    throw error // Main generation has started: never retry, replay or duplicate its tools.
   }
  }catch(error){
   iteration.status=base.signal?.aborted||disposed?'cancelled':'failed'
   trace.finish(runId,{stage:iteration.status,reason:String(error.message),iterationPlan:iteration});closed=true
   if(iteration.status!=='cancelled')throw error
  }finally{
   if(focusToken)focus.release(focusToken)
   if(!closed){iteration.status='cancelled';trace.finish(runId,{stage:'cancelled',reason:forwarded?'working-stream-closed':'direction-stream-closed',iterationPlan:iteration})}
   clearTimeout(preparationTimer);signal.removeEventListener('abort',stopPreparation)
   base.signal?.removeEventListener('abort',parentAbort);active.delete(runId)
  }
 }

 return {
  intercept(options,next){if(disposed||nested.has(options)||!options.sessionId||!isWorkingRequest(options))return next();const raw=settingsFor(String(options.sessionId));if(raw?.reasoningBoost!==true)return next();return runDirections(options,next,canonicalReasoning(raw))},
  cancel(sessionId,runId){
    const sid=String(sessionId||'')
    // runId 省略 ⇒ 取消该会话**所有**还没进入 working 的运行：
    // 用户点“跳过”时前端只知道会话，取消本来就该按会话生效。
    if(!runId){
      let n=0
      for(const op of active.values()){if(op.sid===sid&&op.phase!=='working'){try{op.controller.abort(new Error('user-skipped'))}catch{};n++}}
      return n?{ok:true,cancelled:n}:{ok:false,reason:'no-active-run'}
    }
    const op=active.get(runId)
    if(!op||op.sid!==sid)return {ok:false,reason:'no-active-run'}
    if(op.phase==='working')return {ok:false,reason:'no-extra-inference'}
    op.controller.abort(new Error('boost-cancelled'))
    return {ok:true}
  },
  settingsChanged(){for(const op of active.values())if(op.phase!=='working'&&!settingsFor(op.sid)?.reasoningBoost)op.controller.abort(new Error('boost-disabled'))},
  status(){return {protocolVersion:INFERENCE_VERSION,ready:!disposed,activeRuns:active.size,modelPolicy:'follow-working-request',toolsPolicy:'only-actual-working-stream-submitted',profile:'fast-3x3',...trace.status()}},
  dispose(){disposed=true;for(const op of active.values())op.controller.abort(new Error('plugin-unloaded'));focus.dispose()}
 }
}
