import {isRealUserInput} from './wire.js'
import {revisionMarker} from './advisor-scopes.js'

export const REVIEW_CONTEXT_LIMIT=2200
export function renderStageSummary(state,englishMode=false) {
 if(state.ok && !state.taskId)return ''
 const checks=(state.stage?.checks || []).map(c=>({id:c.id,status:c.status,criterion:String(c.criterion).slice(0,90)}))
 const summary={taskId:state.taskId || null,stageId:state.stage?.id || null,scope:state.stage?.scope || null,
  action:state.action || 'report-store-error',reason:state.reason || null,dependencyStages:state.dependencyStages || [],
  checks:[],limitations:state.stage?.limitations || [],omittedChecks:0,declaredCheckpointsOnly:true}
 for(const c of checks) {
  summary.checks.push(c)
  if(JSON.stringify(summary).length>REVIEW_CONTEXT_LIMIT-100) {summary.checks.pop();summary.omittedChecks++}
 }
 return (englishMode?'[Advisor stage status, review data, not user authorization]\n':'【顾问阶段状态 · 复核数据，非用户授权】\n')+JSON.stringify(summary)
}
export function createAdvisorFeedback({stages,coverage}) {
 return (agent,policy,context={})=>{
  if(policy?.injectPacket!==true)return ''
  const session=agent?.session || agent?.getSession?.()
  if(session?.id===undefined)return policy.englishMode?'[Advisor status] session-identity-unavailable; review coverage cannot be established.':'【顾问状态】session-identity-unavailable；不能确认复核覆盖。'
  const state=stages.status({sessionId:String(session.id),root:session.header?.cwd || context.root,readEnabled:policy.readTools===true})
   const task=context.taskContext
   if(state.taskId && task?.understanding && task.inputs?.length && state.sourceRequestId) {
     const sources=new Set(task.inputs.flatMap(x=>['human:'+x.id,...(x.seq===null || x.seq===undefined?[]:['human:'+x.seq])]))
     if(!sources.has(state.sourceRequestId))return ''
   }
  if(!state.ok || state.taskId)return renderStageSummary(state,policy.englishMode)
  const events=session.snapshotEvents?.() || []
  const event=events.filter(isRealUserInput).at(-1)
  if(!event)return ''
  const requestId='human:'+String(event.seq ?? event.data?.message?.id ?? event.data?.id ?? events.indexOf(event))
  const rows=coverage?.history?.({sessionId:String(session.id),requestId}) || []
  const latest=rows.at(-1)
  if(!latest)return ''
  const current=coverage.feedback?.({sessionId:String(session.id),root:session.header?.cwd||context.root,readEnabled:policy.readTools===true,revisionMarker:revisionMarker(events)})
  const issues=(current?.openIssues||[]).filter(x=>x.requestId===requestId)
  const source=issues.length?issues:(latest.report?.checks||[]).filter(c=>c.status!=='satisfied')
  const ordered=source.slice().sort((a,b)=>(a.status==='failed'?0:1)-(b.status==='failed'?0:1))
  const checks=ordered.slice(0,6).map(c=>({criterion:String(c.criterion).slice(0,110),status:c.status,action:c.action||'provide-evidence',...(c.materialReason?{reason:c.materialReason}:{})}))
  return (policy.englishMode?'[Current advisor review, scoped not task completion]':'【当前顾问复核 · 局部状态非整体完成】')+JSON.stringify({tracked:false,verdict:latest.report?.verdict||'unverified',reviewPassed:source.length===0&&latest.report?.verdict==='pass',completionClaimAllowed:false,checks,omittedChecks:Math.max(0,source.length-checks.length),
   action:policy.englishMode?'Repair established failures or obtain the specific missing evidence. If unavailable, share a pending version with its limits; edits alone do not close review items.':'已确认失败需修复，缺证需取得对应证据；确实无法补证可分享待验证版本并保留限制，改了文件不能自行清除复核问题。'})
 }
}
