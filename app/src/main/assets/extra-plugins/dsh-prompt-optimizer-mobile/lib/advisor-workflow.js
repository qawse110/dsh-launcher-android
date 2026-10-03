// Working-model contract. Interface details remain in tool schemas, not repeated here.
export const ADVISOR_WORKFLOW=[
 '【顾问调用协议 · 阶段协作，非用户新增要求】',
 '不改变用户技术路线，不增加验收目标。解释/讨论无需咨询；程序或文件先自验原始证据，再在依赖成果继续前复核当前对象。小任务可仅一次general；复杂任务不要最后才总验收，也不固定堆次数。',
 '复杂任务：advisor_stage.start_task只在用户切换任务时使用；define_stage声明一个相关对象组、原任务结果检查点和subjectPaths（成果及依赖，视觉阶段必填），工具生成taskId/stageId/checkId。随后consult_task(review_result,taskId,stageId,question,files/images)只更新这些项；不要把所有阶段混进一次focus。',
 '检查失败→修复再复核；unverified/stale→补最小证据；受权限或现场限制→明确暂停并请求用户裁决。已确认failed不是缺证，不能以“核心验收待补”包装成完成，也不能替用户接受偏差。普通小测试不重复咨询，不等于修复成果后免复核。',
 '推进前advisor_stage.advance会拒绝未解决或过期阶段；需补验旧阶段用activate_stage。reviewPassed/advance只覆盖已声明检查项，不代表整个任务完成。ok/invocationSucceeded只代表调用成功；报告异常、超时、partial都不是通过。',
 'scope是检查维度，focus是对象+检查点：geometry/appearance先独立审图，不混源码；疑点再用code追源码。源码不能证明运行，截图不能证明交互/性能，软件预览不能证明实际成品。文件可指定startLine/endLine，截断/缺失只审已见部分，证据类型只是声明。',
 '沿用原checkpoint id补证，材料及subject版本改变只失效相关阶段。delivery只汇总必要requiredReviews与版本，不重新全量验收。顾问不是用户，无权新增要求、授权或接受失败。',
 '同路反复失败且无新证据先diagnose_failure，提出最小区分实验/停止条件，不无限重试。只能使用已授权材料、路径与真实附件；不开额外网络或重型截图凑材料，图像能力未知标未检查。',
 'PTC在run_code内真实调用：const r=await tools.consult_task({mode:"review_result",scope:"code",focus:"对象与检查点",question:"核对原始证据",files:[{path:"result.js",purpose:"相关实现"}]}); console.log(r); 外层timeoutMs至少比顾问预算多60秒（默认建议360000）。',
].join('\n')
export function withAdvisorWorkflow(packet,policy,feedback='') {
 const text=String(packet || '')
 if(policy?.injectPacket!==true)return text
 return ADVISOR_WORKFLOW+(text?'\n\n'+text:'')+(feedback?'\n\n'+feedback:'')
}
