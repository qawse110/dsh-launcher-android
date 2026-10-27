import { EN_WORKFLOW } from './english-prompts.js'
// Stable, compact contract; task-specific advice comes from the capability state.
export const ADVISOR_WORKFLOW=[
 '【解题贡献与独立复核 · 不新增用户要求】不改变用户技术路线中已明确的决定，也不增加验收目标；普通解释与讨论无需为了流程而咨询。',
 '优先提高实际产物水平：有决定结果的方案选择或能力瓶颈时，在锁定办法前用develop_approach取得独立的具体构造、推导或可采用内容，不只要提醒。',
 '初版产物有实质提升空间时用improve_result，附实际正文currentResult或files/images，要求具体改法与收益依据；改善已合格产物也有价值。质量建议与review_result验收分开，不登记通过，也不固定咨询次数。',
 '将贡献落实为实际做法或内容，不只复述顾问意见；保留改前版本，对照实际新旧产物判断收益。keep时保留当前；无增益或新证据推翻建议就停，不因顾问建议就认定新版本更好。',
 '小任务可仅一次general；复杂任务在依赖某项成果继续前先复核该对象，不要最后才总验收，也不固定堆次数。',
 '复杂任务用advisor_stage：define_stage声明一个相关对象组、原任务结果检查点与subjectPaths，插件返回taskId/stageId/checkId；start_task只在用户切换任务时用；补验旧阶段先activate_stage；advance会机械拒绝失败/缺证/过期阶段。',
 'review_result只更新已声明检查项；已确认failed不是缺证，不能拿“待补”包装成完成，也不能替用户接受偏差。局部通过（reviewPassed/advance）不代表整个任务完成。',
 'scope是检查维度，focus是对象+检查点：geometry/appearance先独立审图、再查源码；源码不能证明运行，截图不能证明交互/性能，软件预览不能证明实际成品。文件可指定startLine/endLine；截断/缺失只审已见部分；图像能力未知标未检查。',
 '只能用已授权材料与真实附件；不开额外网络或重型截图凑材料。沿用原checkpoint id补证；材料或subject版本变化只失效相关阶段。',
 'diagnose_failure用于同路反复失败且无新证据：先判断信息增量，再决定继续、缩小实验或换路线。',
 'delivery只汇总必要requiredReviews与版本，不重新全量验收。',
 'PTC在run_code内真实调用：await tools.consult_task({...})；顾问默认不设总截止，外层调用如显式设置截止要足以容纳咨询；用户取消仍有效。'
].join('\n')
export function withAdvisorWorkflow(packet,policy,feedback='',dynamic='') {
 // 顾问关掉时**整段不出现**：否则模型会看到“用 consult_task 复核”的指示，
 // 而工具根本没注册（2026-10-23 改成注册层硬关闭后的配套）。
 if(policy?.injectPacket!==true)return String(packet || '')
 if(policy?.advisor===false)return String(packet || '')
 return [policy.englishMode?EN_WORKFLOW:ADVISOR_WORKFLOW,dynamic || String(packet || ''),dynamic ? '' : feedback].filter(Boolean).join('\n\n')
}
