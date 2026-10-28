// 许愿模式的验收工具：把"我觉得好了"换成一次可复现的检查。
// 它不自己起进程——通过宿主的 bash 工具执行，继承同一套沙箱与超时策略。
const PARAMS={type:'object',additionalProperties:false,required:['criterion','command'],properties:{
 criterion:{type:'string',minLength:1,maxLength:200,description:'这条检查要证明什么（一句话，可判定）'},
 command:{type:'string',minLength:1,maxLength:2000,description:'可复现的命令；同一条命令跑两次应得到同样结论'},
 timeoutMs:{type:'integer',minimum:1000,maximum:120000,description:'可选：期望的超时（秒级粒度），默认沿用 bash 工具的策略'},
}}
const fail=(reason,extra={})=>({ok:false,reason,...extra})
const tail=s=>String(s??'').slice(-1200)
const exitOf=text=>{const m=/\[exit code:\s*(-?\d+)\]/.exec(String(text??''));return m?Number(m[1]):null}
export const name='wish-check'
export const apply=async(ctx)=>{
 const run=(scope,args,exec)=>scope.tools.execute({name:'bash',callId:'wish-check-'+Math.random().toString(36).slice(2),arguments:{command:String(args.command),description:'wish_check: '+String(args.criterion).slice(0,60)},agent:exec?.agent,signal:exec?.signal})
 ctx.inject(['tools'],(scope)=>{
  let off=null
  try{
   off=scope.tools.register({
    name:'wish_check',
    description:'跑一条可复现的验收命令，返回结构化结果（退出码 + 输出尾部）。用它代替"看起来好了"；同一条命令跑两次应得到同样结论。',
    parameters:PARAMS,
    output:{schema:{type:'object',additionalProperties:true},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},
    presentCall:()=>({card:'generic',kind:'other'}),
    async execute(args,exec){
     if(!args||typeof args.criterion!=='string'||!args.criterion.trim())return fail('criterion-required')
     if(typeof args.command!=='string'||!args.command.trim())return fail('command-required')
     const started=Date.now()
     let result
     try{result=await run(scope,args,exec)}
     catch(error){return fail('check-failed-to-run',{criterion:args.criterion,detail:String(error?.message??error).slice(0,200)})}
     const text=(result?.content??[]).map(p=>typeof p?.text==='string'?p.text:'').join('\n')
     const exitCode=exitOf(text)??exitOf(result?.value?.text)
     const ok=result?.isError!==true&&exitCode===0
     return {ok,criterion:args.criterion,exitCode,ms:Date.now()-started,tail:tail(text)}
    }})
  }catch(error){ctx.logger?.warn?.('[wish-check] unavailable: '+String(error?.message??error))}
  if(off)ctx.on?.('dispose',()=>{try{off()}catch{}})
 })
}
