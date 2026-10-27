import {drain} from './eval-llm.js'
const finiteUsage=u=>u&&typeof u==='object'&&Object.values(u).some(v=>typeof v==='number'&&Number.isFinite(v))
// Advisor-only settlement guard. Preserve the optimizer's historical default drainer unchanged.
export async function drainAdvisor(stream,started,sink){
 let thrown=null
 const observed=(async function*(){try{for await(const chunk of stream)yield chunk}catch(e){thrown=String(e?.message||e)}})()
 const result=await drain(observed,started,sink),kind=typeof result.finish==='string'?result.finish:result.finish?.kind
 const error=thrown||(kind&&kind!=='stop'?'advisor-stream-'+String(kind)+(result.finish?.failure?.code?':'+result.finish.failure.code:''):null)
 const known=finiteUsage(result.usage)?1:0
 return{...result,...(error?{error}:{}),usageKnownCalls:known,usageUnknownCalls:1-known,usageComplete:known===1}
}
export function combineAdvisorUsage(first,result){
 const sum={};for(const u of [first.usage,result.usageSum||result.usage])for(const [key,value]of Object.entries(u||{}))if(typeof value==='number'&&Number.isFinite(value))sum[key]=(sum[key]||0)+value
 const firstKnown=Number.isSafeInteger(first.usageKnownCalls)?first.usageKnownCalls:finiteUsage(first.usage)?1:0
 const firstUnknown=Number.isSafeInteger(first.usageUnknownCalls)?first.usageUnknownCalls:firstKnown?0:1
 const nextKnown=Number.isSafeInteger(result.usageKnownCalls)?result.usageKnownCalls:finiteUsage(result.usageSum||result.usage)?1:0
 const nextUnknown=Number.isSafeInteger(result.usageUnknownCalls)?result.usageUnknownCalls:result.usageComplete===false||!nextKnown?1:0
 return{...result,usageSum:Object.keys(sum).length?sum:null,usageKnownCalls:firstKnown+nextKnown,usageUnknownCalls:firstUnknown+nextUnknown,usageComplete:firstUnknown+nextUnknown===0&&first.usageComplete!==false&&result.usageComplete!==false}
}
