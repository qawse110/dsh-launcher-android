# skills-manager 运行时证据（真机 2026-10-28，未重启 dsh）

## 1. 鉴权入口
- cookie 来源：/data/user/0/com.dsh.nextapp1/shared_prefs/dsh_console.xml → dsh_web_auth_cookie（WebAuth.ensureSession 交换后持久化）
- 带 cookie GET http://127.0.0.1:3080/ → 200（不带 → 401）

## 2. 服务端半侧（HTTP API 活）
- GET /api/dsh-skills-manager/state → 200，data.roots 22 项，首项 key=dsh、path=<files>/.dsh/skills、native=true、enabled=true
- GET /api/dsh-skills-manager/sidebar-entry → 200 {ok:true,data:{enabled:true}}
- 进程 pid 12957 启动于 2026-10-28T08:51:47Z，早于 16:55 的装配 ⇒ 装配后未重启即热加载生效

## 3. 写路径（真实执行 + 原样回滚）
- 无客户端标记 → POST category-create 403 {"code":"error.proto.forbidden"}（lib/index.js:160 要求 x-dsh-skills-manager: 1）
- 带标记 → POST category-create 200 {data:{root:"dsh",category:{id:"c9effb9c09829e88",name:"zz-dshchk-probe"}}}；state 立即可见；POST category-delete 200 后消失
- 状态文件 .dsh/skills-manager/state.json 已按备份原样恢复：sha256 f345dab03e9a46289e19d4c9976e1a8cdb1e61b11c676748fa3c9a695dbdeb9d（1503 B），cmp 与备份逐字节相同

## 4. 客户端 UI（真实 WebView 渲染）
- settings.section：设置 → 导航第 6 项「技能」（带 data-dssm-nav-icon）→ 打开 dssm-section：标题「技能 v1.2.20」、页签 全局技能/项目技能/发现技能/回收站、统计 0 个技能/0 个已启用/0 个已停用/0 个诊断异常、来源 DSH 与 公共 Agent
- sidebar.panellist + main：侧栏「技能」按钮 → .dssm-main-panel 361×350 渲染同一面板，按钮含 GitHub/问题反馈/检查更新/刷新/创建技能/导入技能/来源目录/新建分类/启停来源 DSH
- 截图：runtime/evid-settings-skills.png（139,563 B）、runtime/evid-sidebar-skills.png（148,216 B）、runtime/evid-plugins-bundle.png
- 页面内 58 个 [class*=dssm] 节点、2 个注入 style（dssm-settings-nav-icon-style / dssm-sidebar-entry-style）

## 5. 未证
- create_skill 工具实际执行：调用被权限闸拦下（the user rejected tool "create_skill"），未做绕过；插件源码 :358 注册的 ask 闸门本身可读证
- plugins.bundle.config 槽位在本页未渲染出独立卡片（该槽位由 dsh-client-ui-plugin-manager 在内置插件详情页按 entryKey 分发，需展开具体插件卡片）

## 6. 原始数据
```json
{
 "url": "http://127.0.0.1:3080/",
 "stats": "[\"0 个技能\",\"0 个已启用\",\"0 个已停用\",\"0 个诊断异常\"]",
 "tabs": "[\"全局技能\",\"项目技能\",\"发现技能\",\"回收站\"]",
 "sectionHTMLLength": 4000,
 "sectionHTML": "<section class=\"dssm-section\"><style>.dssm-destination{display:flex;flex-direction:column;gap:12px}.dssm-destination .dssm-field{display:flex;flex-direction:column;gap:6px;min-width:0}.dssm-destination-pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.dssm-destination-pair .dssm-menu-select-wrap{width:100%;min-width:0}.dssm-destination-pair .dssm-menu-select-wrap,.dssm-destination-pair span[class*=\"_root_\"],.dssm-destination-pair .dssm-source-select-menu{display:flex!important;width:100%!important;min-width:0!important;height:auto!important;padding:0!important;margin:0!important;border:0!important;background:transparent!important}.dssm-destination-pair .dssm-menu-select-trigger{display:flex!important;width:100%!important;min-width:0!important;height:36px!important;border-radius:var(--dsw-radius-md,10px)!important;padding:0 12px!important;box-sizing:border-box!important}@media (max-width:420px){.dssm-destination-pair{grid-template-columns:minmax(0,1fr)}}.dssm-destinatio
```
```json
{
 "panel": {
  "rect": {
   "w": 361,
   "h": 350
  },
  "text": "技能v1.2.20\nGitHub\n问题反馈\n检查更新\n\n统一加载和管理本机 Agent Skills。\n\n全局技能\n项目技能\n发现技能\n回收站\n0 个技能\n0 个已启用\n0 个已停用\n0 个诊断异常\n全部来源\n全部状态\nDSH\n0 个技能\n公共 Agent\n0 个技能",
  "buttons": [
   "GitHub",
   "问题反馈",
   "检查更新",
   "全局技能",
   "项目技能",
   "发现技能",
   "回收站",
   "全部来源",
   "全部状态",
   "刷新",
   "创建技能",
   "导入技能",
   "来源目录",
   "DSH\n0 个技能",
   "新建分类",
   "启停来源 DSH",
   "公共 Agent\n0 个技能",
   "新建分类"
  ],
  "rootLists": 0
 },
 "api": "{\"status\":200,\"roots\":22,\"first\":\"dsh\"}",
 "pngBytes": 148216,
 "at": "2026-10-28T09:58:52.236Z"
}
```