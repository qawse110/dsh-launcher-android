export const ADVISOR_SCOPES = ['general', 'geometry', 'appearance', 'code', 'interaction', 'performance', 'delivery', 'custom']
export const VISUAL_SCOPES = new Set(['geometry', 'appearance'])
export const SCOPE_LABELS = { general:'综合复核',geometry:'几何装配',appearance:'画面表现',code:'代码正确性',interaction:'交互逻辑',performance:'性能证据',delivery:'交付覆盖',custom:'自定义专项' }
export function validateScope(args) {
  const scope = args.scope || 'general'
  if (!ADVISOR_SCOPES.includes(scope)) return 'invalid-review-scope'
  if (args.focus !== undefined && (typeof args.focus !== 'string' || !args.focus.trim() || args.focus.length > 500)) return 'invalid-review-focus'
  if (scope !== 'general' && !args.focus?.trim()) return 'review-focus-required'
  if (args.evidenceRefs !== undefined && (!Array.isArray(args.evidenceRefs) || args.evidenceRefs.length > 12 || args.evidenceRefs.some(x=>typeof x!=='string'||!/^E[0-9]+$/.test(x)))) return 'invalid-evidence-refs'
  if (args.requiredScopes !== undefined && (scope !== 'delivery' || !Array.isArray(args.requiredScopes) || args.requiredScopes.length > 8 || args.requiredScopes.some(x=>!ADVISOR_SCOPES.includes(x)||['general','delivery'].includes(x)))) return 'invalid-required-scopes'
  if (args.requiredReviews !== undefined && (scope !== 'delivery' || !Array.isArray(args.requiredReviews) || args.requiredReviews.length > 12 || args.requiredReviews.some(x=>!x || !ADVISOR_SCOPES.includes(x.scope) || ['general','delivery'].includes(x.scope) || typeof x.focus !== 'string' || !x.focus.trim() || x.focus.length > 500))) return 'invalid-required-reviews'
  return null
}
export function scopePolicy(args) {
  const scope = args.scope || 'general'
  const visual = VISUAL_SCOPES.has(scope)
  return { scope, focus: args.focus || '', visual, label:SCOPE_LABELS[scope],
    allowTools: !visual && scope !== 'delivery', historyChars: scope === 'general' ? 48000 : scope === 'delivery' ? 8000 : 14000,
    imagesOnly: visual, omitImages: ['code','interaction','performance','delivery'].includes(scope) }
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
  if (!policy.visual && policy.scope !== 'delivery') {
    const refs = new Set(args.evidenceRefs || [])
    const paths = [...(args.artifacts || []), ...(args.files || []).map(x=>x.path)].map(x=>String(x).replaceAll(String.fromCharCode(92),'/').toLowerCase())
    records = snapshot.records.filter(row => refs.has(row.id) || paths.some(path => row.text.replaceAll(String.fromCharCode(92),'/').toLowerCase().includes(path)))
  }
  let used = 0, omitted = 0
  const selected = []
  for (const row of records.slice().reverse()) { if (used + row.text.length > policy.historyChars) { omitted++;continue }; selected.unshift(row);used+=row.text.length }
  return {...snapshot,records:selected,omitted,truncated:snapshot.userText.includes('[截断：') || selected.some(r=>r.text.includes('[截断：')),
    excludedByScope:snapshot.records.length-records.length,historyPolicy:policy.visual?'visual-no-history':policy.scope==='delivery'?'coverage-only':'selected-paths-or-ids'}
}
export function scopeInstructions(policy) {
  const common = '\n【本次专项范围】' + policy.label + '；对象/检查点：' + policy.focus + '\n只对本次focus中的验收点作结论，范围外不能计入通过与否。局部pass不代表整体通过。不要把“是否回答问题”代替成果是否符合要求。'
  if (policy.scope === 'geometry') return common + '\n独立先看图，不读代码、不根据测试通过判断形体。先定位对象，再检查形状与比例、朝向、相对位置、间隙或贴合、重叠与穿插、对称与重复实例的一致性。部件齐全不等于装配正确。\n替代预览（线框、平光、示意图、低保真截图）也可证明明显形体错误；缺真实成品只限制材质质感与性能项，不能成为跳过可见错位的理由。异常要说明哪份I材料、画面位置、涉及对象和置信度。看不清或缺少视角时标未验证，不因“看起来像某类东西”就判通过。'
  if (policy.scope === 'appearance') return common + '\n独立先看图，只检查focus中的取景与构图、明暗与色彩、清晰度与噪点、遮挡与可见性，或该画面本身的缺陷，不混代码逻辑和测试数量。说明图像来自真实产物还是替代预览：替代预览不能证明真实成品观感。'
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
