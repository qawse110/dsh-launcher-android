const key=c=>c.checkId||c.criterion
// The image-only observation is frozen before source support is disclosed. It is not acceptance bookkeeping.
export function imageFirstMessages(prompt,images){
 const p=JSON.parse(prompt)
 const imageOnly={mode:p.mode,question:'Independently observe the original goal, requested focus and declared checkpoints from the actual images. Caller self-assessment and implementation claims are withheld in this phase.',workspace:p.workspace,review:p.review,stageContract:p.stageContract,
  snapshot:{userText:p.snapshot.userText,requestId:p.snapshot.requestId,records:[],omitted:0,truncated:p.snapshot.truncated},
  artifacts:p.artifacts.filter(x=>String(x.id).startsWith('I')),observationOnly:true,
  instruction:'Observe the actual images independently before source/tests. Return the usual report JSON. For each unverified check add gapKind:"source" only when a precise implementation fact/measurement can resolve it; use "view" for missing/unclear views, "runtime" for behavior needing execution, otherwise "unknown". Do not infer exact dimensions or execution from uncalibrated pixels. For a concrete visible failure, mark a finding needsSource:true only if a specific authorized source fact can materially improve its diagnosis or repair. Successful image observations alone do not need source support. This is not final acceptance.'}
 return[{role:'user',content:[{type:'text',text:JSON.stringify(imageOnly)},...images]}]
}
export function reconcileVisualReport(first,final){
 const checks=final.checks.map(c=>({...c})),held=[]
 for(const observed of first.checks||[]){const target=checks.find(c=>key(c)===key(observed));const locked=observed.status==='failed'||observed.status==='unverified'&&observed.gapKind!=='source'
  if(!locked)continue
  if(!target){checks.push({...observed});held.push(key(observed));continue}
  if(observed.status==='failed'&&target.status!=='failed'){Object.assign(target,{status:'failed',evidenceRefs:observed.evidenceRefs});held.push(key(observed))}
  else if(observed.status==='unverified'&&target.status==='satisfied'){target.status='unverified';held.push(key(observed))}
 }
 const findings=[...first.findings,...final.findings].filter((f,i,a)=>a.findIndex(x=>x.text===f.text&&JSON.stringify(x.evidenceRefs)===JSON.stringify(f.evidenceRefs))===i)
 return{...final,checks,findings,...(final.verdict==='pass'&&checks.some(c=>c.status!=='satisfied')?{verdict:checks.some(c=>c.status==='failed')?'gaps':'unverified'}:{}),visualObservation:{source:'image-only-first-pass',heldChecks:held,checks:first.checks}}
}
export function visualDiagnosticReport(first){
 const report=JSON.parse(JSON.stringify(first)),checks=report.checks.map(c=>c.status==='satisfied'?{...c,status:'unverified'}:c)
 return{...report,checks,verdict:checks.some(c=>c.status==='failed')?'gaps':'unverified',summary:'Image observations retained; source follow-up is incomplete or invalid, so this is not completed acceptance. '+report.summary}
}
