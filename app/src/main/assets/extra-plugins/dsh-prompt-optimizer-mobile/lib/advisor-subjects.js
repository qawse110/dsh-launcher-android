import {createHash} from 'node:crypto'
import {readBounded} from './advisor-materials.js'
import {extname} from 'node:path'
const hash=data=>createHash('sha256').update(data).digest('hex')
export function captureReviewSubjects(paths,{root,enabled}={}){
 if(!Array.isArray(paths)||paths.length>8||paths.some(p=>typeof p!=='string'||!p.trim()||p.length>1000))return{ok:false,reason:'invalid-review-subjects',subjects:[]}
 const subjects=[];let left=8*1024*1024
 for(const path of [...new Set(paths)]){
  if(!root||!enabled)return{ok:false,reason:'subject-read-disabled',subjects}
  try{const kind=/\.(png|jpe?g|gif|webp)$/i.test(extname(path))?'image':'file',cap=kind==='image'?5*1024*1024:2*1024*1024
   const read=readBounded(root,path,Math.min(cap,left));left-=read.data.length;subjects.push({path,kind,status:'ready',sha256:hash(read.data)})
  }catch{return{ok:false,reason:'review-subject-unavailable',subjects:[...subjects,{path,kind:'file',status:'unavailable',sha256:null}]}}
 }
 return{ok:true,subjects}
}
export function reviewSubjectsCurrent(subjects,options){const now=captureReviewSubjects(subjects.map(s=>s.path),options);return now.ok&&subjects.every(s=>now.subjects.some(n=>n.path===s.path&&n.sha256===s.sha256))}
