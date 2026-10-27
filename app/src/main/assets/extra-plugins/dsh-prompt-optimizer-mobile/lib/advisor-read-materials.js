import {posix} from 'node:path'
export function contributionPathIdentity(path, root=null) {
  const slash=s=>posix.normalize(String(s || '').replace(/\\/g,'/'))
  const windows=process.platform==='win32' || /^[a-z]:/i.test(String(root || path))
  const key=s=>{const n=slash(s);return windows?n.toLowerCase():n}
  let value=key(path)
  if(root){const base=key(root).replace(/\/$/,'');if(value.startsWith(base+'/'))value=value.slice(base.length+1)}
  return value.replace(/^\.\//,'')
}
const rangesOf=row=>row.readRanges || (Number.isInteger(row.selectedStartLine ?? row.startLine) && Number.isInteger(row.selectedEndLine ?? row.endLine)
 ? [{startLine:row.selectedStartLine ?? row.startLine,endLine:row.selectedEndLine ?? row.endLine,selectionComplete:row.selectionComplete!==false}] : [])
// Stage material limits count file versions, not how many ranges the advisor read.
export function mergeReadMaterialVersions(rows,root=null){
 const merged=[],seen=new Map()
 for(const row of rows || []){
  const identity=row.path&&row.sha256?JSON.stringify([contributionPathIdentity(row.path,root),row.kind || 'file',row.sha256]):null
  const old=identity?seen.get(identity):null
  if(!old){const copy={...row,readRanges:rangesOf(row).map(r=>({...r}))};merged.push(copy);if(identity)seen.set(identity,copy);continue}
  const all=[...old.readRanges,...rangesOf(row)],unique=new Map(all.map(r=>[JSON.stringify(r),r]));old.readRanges=[...unique.values()]
  old.selectionComplete=old.selectionComplete!==false && row.selectionComplete!==false
  old.wholeFileComplete=old.wholeFileComplete===true && row.wholeFileComplete===true
  if(old.status==='truncated'||row.status==='truncated'||old.selectionComplete===false){old.status='truncated';old.truncated=true}
  // Neither separated ranges nor a single version fingerprint prove whole-file inspection.
  if(old.readRanges.length>1){old.selectionScope='multiple-line-ranges';delete old.startLine;delete old.endLine;delete old.selectedStartLine;delete old.selectedEndLine}
 }
 return merged
}
export function traceReadMaterials(trace,root=null){
 const rows=[]
 for(const row of trace || []){
  const e=row.evidence
  if(row.tool!=='read'||row.ok!==true||row.rejected||!row.resultAvailable||!e?.sha256)continue
  rows.push({...e,kind:'file',evidenceType:'source',source:'advisor-read',sent:true})
 }
 return mergeReadMaterialVersions(rows,root)
}
