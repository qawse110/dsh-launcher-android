import { isContributionMode } from './advisor-contribution.js'

export const ADVISOR_SCOPES = ['general', 'geometry', 'appearance', 'code', 'interaction', 'performance', 'delivery', 'custom']
export const VISUAL_SCOPES = new Set(['geometry', 'appearance'])
export const SCOPE_LABELS = { general:'综合复核',geometry:'几何装配',appearance:'画面表现',code:'代码正确性',interaction:'交互逻辑',performance:'性能证据',delivery:'交付覆盖',custom:'自定义专项' }
export const DELIVERY_ITEM_SCOPES = ADVISOR_SCOPES.filter(s => s !== 'general' && s !== 'delivery')

/**
 * 参数校验：返回 null（放行）/ 原因字符串 / {reason,detail}。
 *
 * GitHub #33A（真机：某会话 21 连败 0 成功，当日该 reason 共 22 次）：
 * `requiredScopes` / `requiredReviews` 的**全部**消费方都在 `policy.scope === 'delivery'` 之内，
 * 非 delivery 下它们是纯 no-op，却按硬错误把整次调用拒掉；而 schema 的 enum 又把 8 个值全给，
 * 调用方照着 schema 选值必被拒。现在：非 delivery 一律放行（也不改写调用方 args —— 宿主传入的
 * 可能是冻结对象，原地 delete 在严格模式下会抛），只有 delivery 内才做值校验，且拒绝理由带上
 * 当前值、允许值与正确用法。reason 仍以原码开头，保证按码归组的消费方不受影响。
 */
export function validateScope(args) {
  const scope = args.scope || 'general'
  if (!ADVISOR_SCOPES.includes(scope)) return 'invalid-review-scope'
  if (args.focus !== undefined && (typeof args.focus !== 'string' || !args.focus.trim() || args.focus.length > 500)) return 'invalid-review-focus'
  if (scope !== 'general' && !args.focus?.trim()) return 'review-focus-required'
  if (args.evidenceRefs !== undefined && (!Array.isArray(args.evidenceRefs) || args.evidenceRefs.length > 12 || args.evidenceRefs.some(x=>typeof x!=='string'||!/^E[0-9]+$/.test(x)))) return 'invalid-evidence-refs'
  const usage = name => name + ' 只在 scope="delivery" 时有效（其它 scope 下是 no-op，现不再拒整次调用）。'
    + '正确用法：scope="delivery" + focus="交付前覆盖" + requiredScopes 列「必要维度」（最多8项，取自 '
    + JSON.stringify(DELIVERY_ITEM_SCOPES) + '，不含 general/delivery），'
    + 'requiredReviews 列「必须核对的具体 scope+focus」（最多12项，每项 scope 同样取值、focus 非空且不超过500字）。'
  if (scope === 'delivery') {
    if (args.requiredScopes !== undefined && (!Array.isArray(args.requiredScopes) || args.requiredScopes.length > 8 || args.requiredScopes.some(x=>!ADVISOR_SCOPES.includes(x)||['general','delivery'].includes(x))))
      return { reason:'invalid-required-scopes', detail: usage('requiredScopes') + ' 当前收到 requiredScopes=' + JSON.stringify(args.requiredScopes) + '（scope=' + JSON.stringify(scope) + '）。' }
    if (args.requiredReviews !== undefined && (!Array.isArray(args.requiredReviews) || args.requiredReviews.length > 12 || args.requiredReviews.some(x=>!x || !ADVISOR_SCOPES.includes(x.scope) || ['general','delivery'].includes(x.scope) || typeof x.focus !== 'string' || !x.focus.trim() || x.focus.length > 500)))
      return { reason:'invalid-required-reviews', detail: usage('requiredReviews') + ' 当前收到 requiredReviews=' + JSON.stringify(args.requiredReviews) + '（scope=' + JSON.stringify(scope) + '）。' }
  }
  return null
}
export function scopePolicy(args) {
  const scope = args.scope || 'general'
  const visual = VISUAL_SCOPES.has(scope)
  const contribution = isContributionMode(args.mode)
  return { scope, focus: args.focus || '', visual, contribution, label:SCOPE_LABELS[scope],
    allowTools: scope !== 'delivery', historyChars: scope === 'general' ? 48000 : scope === 'delivery' ? 8000 : 14000,
    imagesOnly: false, omitImages: !contribution && ['code','interaction','performance','delivery'].includes(scope) }
}
export function scopedMaterials(args, policy) {
  const excluded = []
  const dropped = (items,kind) => items.forEach((row,i)=>excluded.push({ id:'excluded-'+kind+i,kind,path:typeof row==='string'?row:row.path,
    purpose:typeof row==='string'?'兼容成果材料':row.purpose,status:'excluded',sent:false,previewAvailable:false,reason:'scope-material-excluded' }))
  const prepared = {...args}
  if (policy.imagesOnly) { dropped(args.artifacts||[],'file');dropped(args.files||[],'file');prepared.artifacts=[];prepared.files=[] }
  if (policy.omitImages) { dropped(args.images||[],'image');prepared.images=[] }
  return { prepared, excluded }
}
export function scopedSnapshot(snapshot, args, policy) {
  if (!snapshot.ok || policy.scope === 'general') return snapshot
  let records = []
  // Explicit ids or paths select relevant evidence. Do not inject unrelated recent successes.
  if ((policy.contribution || !policy.visual) && policy.scope !== 'delivery') {
    const refs = new Set(args.evidenceRefs || [])
    const paths = [...(args.artifacts || []), ...(args.files || []).map(x=>x.path), ...(policy.contribution ? (args.images || []).map(x=>x.path) : [])].map(x=>String(x).replaceAll(String.fromCharCode(92),'/').toLowerCase())
    records = snapshot.records.filter(row => refs.has(row.id) || paths.some(path => row.text.replaceAll(String.fromCharCode(92),'/').toLowerCase().includes(path)))
  }
  let used = 0, omitted = 0
  const selected = []
  for (const row of records.slice().reverse()) { if (used + row.text.length > policy.historyChars) { omitted++;continue }; selected.unshift(row);used+=row.text.length }
  return {...snapshot,records:selected,omitted,truncated:snapshot.userText.includes('[截断：') || selected.some(r=>r.text.includes('[截断：')),
    excludedByScope:snapshot.records.length-records.length,historyPolicy:policy.contribution?'contribution-selected-evidence':policy.visual?'visual-no-history':policy.scope==='delivery'?'coverage-only':'selected-paths-or-ids'}
}
export function scopeInstructions(policy, englishMode = false) {
  if (policy.contribution) return englishMode
    ? '\n[Contribution focus] ' + policy.scope + ': ' + policy.focus + '\nCombine relevant permitted text, source, images and actual results to form concrete methods or improvements. Sources cannot establish runtime quality, nor can screenshots establish interaction or performance. Stay focused without losing decisive relationships to the original goal; optional quality improvements are not acceptance failures.'
    : '\n【解题/改进对象】' + policy.label + '；重点：' + policy.focus + '\n可结合已授权的相关文本、源码、图像与实际结果构思方法或改进，不机械隔离材料；源码不能证明运行、截图不能证明交互/性能。聚焦关键问题，但不遗漏它与原目标的决定性联系；可选拔高不是验收失败。'
  const common = '\n【本次专项范围】' + policy.label + '；对象/检查点：' + policy.focus + '\n只对本次focus中的验收点作结论，范围外不能计入通过与否。局部pass不代表整体通过。不要把“是否回答问题”代替成果是否符合要求。'
  if (policy.scope === 'geometry') return common + '\n独立先看实际图像形成可见观察，再用已授权源码或运行测量核对精确尺寸、算法和必要关联；来源不可互证，源码/测试通过不能代替形体图证。先定位对象，再检查形状与比例、朝向、相对位置、间隙或贴合、重叠与穿插、对称与重复实例的一致性。部件齐全不等于装配正确。\n替代预览（线框、平光、示意图、低保真截图）也可证明明显形体错误；缺真实成品只限制材质质感与性能项，不能成为跳过可见错位的理由。异常要说明哪份I材料、画面位置、涉及对象和置信度。看不清或缺少视角时标未验证，不因“看起来像某类东西”就判通过。'
  if (policy.scope === 'appearance') return common + '\n独立先看实际图像，只对focus中的取景与构图、明暗色彩、清晰度、遮挡或可见缺陷作画面结论；必要源码用于追因和可落实改法，不能替代图证或把测试数量当画面质量。说明图像来自真实产物还是替代预览：替代预览不能证明真实成品观感。'
  if (policy.scope === 'delivery') return common + '\n这次只核对用户目标的复核覆盖、未解决项与复核后变更，不从头重做各专项。coverage里的C编号是既有局部报告，不是原始成果事实。过期、材料变更、缺失或未确认版本不可支持当前版本通过；不要把某专项中一个focus的通过扩大成该类别全部通过。requiredScopes只是调用方列的必要维度，仍对照用户原话检查有无遗漏与跨模块风险。'
  return common + '\n只读与本次对象相关的文件与原始证据；追踪必要依赖到实际实现文件，禁止泛扫整个工程。有疑点时先用源码核对该疑点，不重新覆盖其它不相关专项。'
}

// Detect recorded source writes conservatively; evidence images/logs alone do not stale a review.
export function revisionMarker(events) {
  let last = 'none'
  const names = new Map()
  for (let i = 0; i < (events || []).length; i++) {
    const e=events[i],d=e.data||{}
    if(e.type==='tool/call'||e.type==='tool/ptc-dispatch-start') names.set(d.subCallId||d.callId,{name:d.name,args:d.arguments})
    if(!['tool/result','tool/ptc-dispatch'].includes(e.type))continue
    const key=d.subCallId||d.message?.toolCallId
    const call=names.get(key)
    if(!call||!['write','edit','mcp__godot-ai__script_create','mcp__godot-ai__script_patch'].includes(call.name))continue
    let args=call.args
    if (typeof args === 'string') { try { args=JSON.parse(args) } catch { args=null } }
    const path=args?.file_path||args?.path||''
    if(/\.(png|jpe?g|webp|gif|log|txt)$/i.test(path))continue
    if(d.isError===true||d.message?.isError===true)continue
    last=String(e.seq??i)
  }
  return 'write:' + last
}
