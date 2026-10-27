window.__ModuleLoader__.load({
  id: "dsh-codearts-auth",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// plugin-src/client/index.js
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(client_exports);

// plugin-src/management-rpc.mjs
var ENDPOINT = "jet-hub";
function callManagementRpc(connection, channel, method, payload, signal) {
  return connection.rpc.call("/api", ENDPOINT, { method, payload }, signal);
}
function unwrapRpcResult(result) {
  if (result?.ok === true) return result.value;
  if (result?.ok === false) {
    const error = new Error(result.error?.message || "Jet Hub API 请求失败");
    error.code = result.error?.code;
    throw error;
  }
  return result;
}

// plugin-src/client/jet-hub-styles.js
var STYLES = `
.dim-jh-page { display: flex; flex-direction: column; height: 100%; }
/* 「侧栏」面板的宿主（main 槽）：中央面板自己不留白，只给顶部一条 28px 的
   标题带（插件市场页同款）。设置页里的 .dim-jh-page 则由 SettingsRoot 缩进，
   两条入口共用同一个组件、靠这一层补丁拉开差别。
   ⚠️ 顶部清障**只在 darwin 上叠加**（2026-10-26 修双重预留）：
   Windows 的框架已经把整块内容区按 padding-top: var(--dsh-windows-titlebar-height)
   （40px）下推过标题栏了，而 --dsh-frame-top-clearance 在 Windows 上正是同一个
   40px ⇒ 这里若无条件再叠一次，顶部就空出 40 + 28 + 40 = 108px，用户看到的是
   「卡片上方一大片白」。macOS 的框架不给这层 padding（红绿灯浮在内容上），
   所以只有 darwin 需要补。判据与插件市场页的 .V7pFBG_pageHead 逐字同源。
   ⚠️ 本文件是 JS 模板字符串，注释里**不能出现反引号**（会提前闭合）。 */
.dim-jh-panelHost { box-sizing: border-box; height: 100%; min-height: 0; display: flex; flex-direction: column; padding: 28px 24px 24px; }
[data-platform='darwin'] .dim-jh-panelHost { padding-top: calc(28px + var(--dsh-frame-top-clearance, 0px)); }
.dim-jh-panelHost > .dim-jh-page { flex: 1 1 auto; min-height: 0; }
/* ⚠️ 左右 padding 为 0（2026-10-14）：宿主 SettingsRoot 已经把整个 section
   内容区按 padding 0 24px 24px 缩进了一层（类名 .wCInkW_options，见
   @deepseek-ai/dsh-client-ui-settings-general/SettingsRoot.module.css）。
   此前这里再写 24px，页头就比下方内容（.dim-jh-layout 无 padding）多缩进
   一层，按钮行看起来往里缩、与 provider 列表左边界对不齐。
   改为 0 后页头与内容对齐到同一条 24px 基准线，并净得 48px 横向空间
   （页头按钮多，这 48px 直接决定「渠道原生搜索」开关是否换行）。
   注意：本文件是 JS 模板字符串，注释里不能出现反引号。
   ⚠️ 不要加回来：它省不了任何东西，只会重新制造那层错位。 */
.dim-jh-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 0; border-bottom: 1px solid var(--dsw-alias-border-default, #e5e5e5); }
/* ⚠️ 页头左侧的标题块**已整块删除**（2026-10-07）：
   ① 「Jet Hub」标题本体（.dim-jh-brand / .dim-jh-brandName）—— 页头一排已有
      7 个按钮，标题只占宽度、不带任何操作。CSS 一并删除（留在样式表里的
      「无引用规则」没有任何价值，只会在下次重构时被误当成生效样式）。
   ② 副标题「提供商凭据与多账号管理」（.dim-jh-brandDesc）—— 2026-10-06，
      按钮太多，副标题既显示不全又挤占页头高度。
   ⚠️ **两者都不要加回来**：设置页语义由 .dim-jh-page 的 aria-label
   「Jet Hub Provider 设置」与宿主左侧「Jet Hub」导航项承担，不丢。 */

/* 布局：对齐 dsh-im 的两栏 */
.dim-jh-layout { display: flex; flex: 1; overflow: hidden; }

/* 左侧导航：align dsh-im .dim-rail */
/* ⚠️ 宽度 228px 是「尽量给右侧让位」与「最长行不出省略号」的交点。算式（含滚动条）：
     可用文字宽 = W − 12(rail padding 6×2) − 2(按钮边框) − 20(按钮 padding 10×2)
                     − 30(图标) − 8(图标间距) − 15(Windows 经典滚动条) = W − 85
     W = 228 ⇒ 可用 **143px**，刚好装得下最长行 WorkBuddy (国际版) —— 它实测要 141px
     （!25 的实测表：200px + 行尾开关时标签只剩 77px、该行超宽 64px ⇒ 77 + 64 = 141）。
   与 !25 的 243px 相比省出 15px，再加上开关移走后消失的那条 8px 空列
   ⇒ 右侧账号区净得约 23px。**再往回收就会截断最长行**（用户已报过一次
   「workbuddy国际版有省略号」），要更窄只能改短 label —— 但那会与
   RaccoonProduct / QODER_CN 等 displayName 的跨文件一致性断言冲突，故未做。
   ⚠️ 测量本身的三条坑（inline 元素 clientWidth 恒 0 会得到假阴性、不能靠行高判折行、
   滚动条吃掉约 15px）见工作区 jet-hub-provider-toggle-notes.md。 */
.dim-jh-rail { width: 228px; border-right: 1px solid var(--dsw-alias-border-default, #e5e5e5); padding: 6px; overflow-y: auto; display: grid; align-content: start; gap: 8px; }

/* 每个 provider 按钮：align dsh-im .dim-channel */
/* padding 与图标间距比 !25 各收窄 2px（12→10、10→8）：这两处是**纯开销**，
   省下的每一像素都直接变成标签可用宽度，比加宽 rail 划算 —— 正是靠这 4px
   才把「不截断」所需的 rail 宽度从 232px 压到 228px。 */
.dim-jh-provider { width: 100%; min-height: 48px; display: grid; grid-template-columns: 30px minmax(0, 1fr); align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l2, #eef0f3); border-radius: 14px; color: inherit; background: var(--dsw-alias-bg-layer-3, #fff); box-shadow: 0 2px 8px rgb(31 35 41 / 3%); font: inherit; text-align: left; cursor: pointer; transition: border-color .16s ease, background .16s ease, box-shadow .16s ease; }
.dim-jh-provider:hover { border-color: color-mix(in srgb, #1677ff 25%, var(--dsw-alias-border-l2, #eef0f3)); background: color-mix(in srgb, #1677ff 2%, var(--dsw-alias-bg-layer-3, #fff)); box-shadow: 0 5px 16px rgb(31 35 41 / 5%); }
.dim-jh-provider[aria-selected="true"] { border-color: color-mix(in srgb, #1677ff 43%, var(--dsw-alias-border-l2, #dfe1e5)); color: #1677ff; background: color-mix(in srgb, #1677ff 12%, var(--dsw-alias-bg-layer-3, #fff)); box-shadow: 0 3px 12px rgb(51 112 255 / 7%); }
.dim-jh-provider:focus-visible { outline: none; border-color: color-mix(in srgb, #1677ff 72%, var(--dsw-alias-border-l2, #dfe1e5)); box-shadow: 0 0 0 1px color-mix(in srgb, #1677ff 24%, transparent) inset, 0 3px 12px rgb(51 112 255 / 7%); }

/* 图标容器：align dsh-im .dim-logo */
.dim-jh-providerIcon { width: 30px; height: 30px; display: grid; place-items: center; border-radius: 9px; box-shadow: 0 1px 3px rgb(31 35 41 / 7%); overflow: hidden; }
.dim-jh-providerIcon img { display: block; width: 20px; height: 20px; border-radius: 2px; }
.dim-jh-providerIcon.codearts { background: white; }
.dim-jh-providerIcon.buddy { background: white; }
.dim-jh-providerIcon.workbuddy { background: white; }
.dim-jh-providerIcon.lobsterai { background: white; }
.dim-jh-providerIcon.qoder { background: white; }
/* Qoder 中国版：官方 ICO 缩图，白底容器中对比度足够。 */
.dim-jh-providerIcon.qodercn { background: white; }
.dim-jh-providerIcon.trae { background: white; }
/* Raccoon Work（商汤）：官方图标是深蓝底白色面具，白底容器中显示清晰。 */
.dim-jh-providerIcon.raccoon { background: white; }
/* MiniMax Code（中国版）：官方 logo **自带浅蓝底** #7DC6FF，白底容器中显示清晰。
   ⚠️ 本文件的样式整体是一个模板字符串 —— 注释里**不能出现反引号**（会提前终止）。 */
.dim-jh-providerIcon.minimax { background: white; }
/* MiniMax Code（国际版）：与上面中国版**共用同一个 logo**，故同样给白底容器。
   ⚠️ 每个 logoClass 都必须各自声明背景（本文件没有兜底规则），漏了会让该行容器
      没有底色、与其它行视觉不一致 —— 与 officeace 那次「注释失实且无守卫」同型。 */
.dim-jh-providerIcon.minimaxintl { background: white; }
/*
 * ZCode（智谱）：图标自带深色圆角底 + 青色 Z，本身即完整图形，
 * 故容器保持透明（加白底反而会出现一圈突兀的方块）。
 */
.dim-jh-providerIcon.zcode { background: transparent; }
/* Gemini Code Assist：内联 SVG 自带蓝紫渐变星形，白底容器中显示清晰。
   ⚠️ 本文件的样式整体是一个模板字符串 —— 注释里**不能出现反引号**（会提前终止）。 */
.dim-jh-providerIcon.gemini { background: white; }
/* Accio（阿里）：内联 SVG 自带品牌橙圆角方块 + 白色 A 字，白底容器中显示清晰。
   ⚠️ 本文件的样式整体是一个模板字符串 —— 注释里**不能出现反引号**（会提前终止）。 */
.dim-jh-providerIcon.accio { background: white; }
/* OfficeAce（华为 MaaS / 果办）：内联 SVG **自带不透明红底 + 白字 OA**，
   故容器用 transparent（与 zcode 同因：图标自己不透明，再叠白底是多余的）。
   ⚠️ 这一条是 2026-10-13 合并审计补的 —— 此前 provider-icons.js 的注释
      声称「样式见本文件」，而本文件**零命中 officeace**（注释失实且无守卫）。
   ⚠️ 本文件的样式整体是一个模板字符串 —— 注释里**不能出现反引号**（会提前终止）。 */
.dim-jh-providerIcon.officeace { background: transparent; }
/* AStudio：内联 SVG 自带不透明品牌蓝底 + 白字 A，容器白底与其它内联 SVG 家一致。 */
.dim-jh-providerIcon.astudio { background: white; }
/* 聚合 provider：内联 SVG（三渠道汇聚），白底容器中显示清晰。
   ⚠️ 加这一条是必要的 —— 上面每家的 logoClass 都各自声明了背景，
      没有兜底规则，缺了会让聚合的图标容器**没有背景**（与其它行不一致）。 */
.dim-jh-providerIcon.aggregate { background: white; }
/* Codely（Unity 团结引擎）：内联 SVG 自带深灰圆角底 + 白色 U，本身即完整图形，
   故容器保持透明（与 zcode / officeace 同因：图标自己不透明，再叠白底是多余的）。
   ⚠️ 本文件的样式整体是一个模板字符串 —— 注释里不能出现反引号（会提前终止）。 */
.dim-jh-providerIcon.codely { background: transparent; }

/* provider 文案：align dsh-im .dim-channelCopy */
.dim-jh-providerLabel { min-width: 0; display: grid; }
.dim-jh-providerLabel strong { overflow: hidden; color: inherit; font-size: 14px; line-height: 20px; font-weight: 680; text-overflow: ellipsis; white-space: nowrap; }

/* ── 供应商级一键开关（左侧 rail 的分组 + 行尾开关）── */
/* 分组：与 rail 同为 grid，组之间留出间隔。分组只是展示分组，不改变声明顺序。 */
.dim-jh-railGroup { display: grid; gap: 8px; }
.dim-jh-railGroup + .dim-jh-railGroup { margin-top: 10px; }
.dim-jh-railGroupTitle { padding: 2px 4px 0; font-size: 12px; line-height: 16px; font-weight: 600; color: var(--dsw-alias-label-tertiary, #8f959e); }
/* 每行：只有一个选择按钮（开关已搬到页头的「供应商开关」弹窗）。
   ⚠️ 列宽仍写 minmax(0, 1fr) 而不是 1fr：grid 项的 min-width 默认 auto，
   长供应商名会把行撑宽、撑出 rail（与模型行那次「开关不可见」的缺陷同型）。
   ⚠️ **不要再留第二列**：!25 时代这里是 minmax(0, 1fr) auto 给行尾开关用；
   开关移走后那一列虽为 0 宽，**8px 的列间距却照样计入**，于是在卡片右侧
   留下一条看着像「rail 没铺满」的空白。用户报障原话：
   「去掉开关后右边有片空白，要省略让右边的账号池区域显示更宽」。 */
.dim-jh-providerRow { display: grid; grid-template-columns: minmax(0, 1fr); }
.dim-jh-providerRow .dim-jh-provider { min-width: 0; }

/* 右侧面板。
   ⚠️ 2026-10-26 用户要求「页头滚动时应该只滚动账号列表」：本容器改为
   **纵向 flex**，把「谁滚动」这件事交给子组件自己决定 ——
   .dim-jh-accountSection 内部只让 .dim-jh-accountList 滚，
   .dim-jh-aggPanel 自己滚。若本容器仍是普通块级 + overflow-y: auto，
   滚动会发生在**它**身上 ⇒ 账号管理页的标题/提示/按钮组跟着一起滚走。
   ⚠️ overflow-y: auto 保留为兜底（子项没撑开时仍能滚），正常路径下不会出现滚动条。 */
.dim-jh-panel { flex: 1; min-width: 0; display: flex; flex-direction: column; padding: 24px; overflow-y: auto; }
.dim-jh-empty { text-align: center; padding: 40px; color: var(--dsw-alias-label-tertiary, #888); }
.dim-jh-empty p { margin: 8px 0; font-size: 14px; }

/* 账号卡片 */
.dim-jh-accountCard { position: relative; border: 1px solid var(--dsw-alias-border-l2, #eef0f3); border-radius: 14px; padding: 14px 16px; margin-bottom: 10px; background: var(--dsw-alias-bg-layer-3, #fff); box-shadow: 0 2px 8px rgb(31 35 41 / 3%); transition: border-color .16s ease, box-shadow .16s ease, opacity .16s ease; }
.dim-jh-accountCard:hover { border-color: color-mix(in srgb, #1677ff 22%, var(--dsw-alias-border-l2, #eef0f3)); box-shadow: 0 5px 16px rgb(31 35 41 / 5%); }
.dim-jh-accountCard[data-enabled="false"] { opacity: 0.62; }

/* 拖拽排序 */
/* 抓取柄：独立的小区域，避免与卡片内的按钮/文本选择冲突 */
.dim-jh-dragHandle { flex: none; width: 16px; height: 20px; display: flex; align-items: center; justify-content: center; cursor: grab; color: var(--dsw-alias-label-tertiary, #9aa0a6); font-size: 12px; line-height: 1; letter-spacing: -1px; user-select: none; border-radius: 4px; }
.dim-jh-dragHandle:hover { color: var(--dsw-alias-label-secondary, #5f6672); background: rgb(31 35 41 / 5%); }
.dim-jh-dragHandle:active { cursor: grabbing; }
/* 正在被拖动的卡片：淡出以表明它已"拿起" */
.dim-jh-accountCard[data-dragging="true"] { opacity: 0.4; border-style: dashed; }
/* 拖拽悬停的目标位置：插入线。上方=插到该卡片之前，下方=之后。 */
.dim-jh-accountCard[data-dropBefore="true"]::before { content: ''; position: absolute; left: 0; right: 0; top: -6px; height: 3px; border-radius: 2px; background: #1677ff; }
.dim-jh-accountCard[data-dropAfter="true"]::after { content: ''; position: absolute; left: 0; right: 0; bottom: -6px; height: 3px; border-radius: 2px; background: #1677ff; }
/* 序号徽标：让当前优先级一目了然（顺序即自动选号优先级） */
.dim-jh-accountOrder { flex: none; min-width: 18px; padding: 0 5px; border-radius: 6px; font-size: 11px; line-height: 17px; font-weight: 600; text-align: center; color: var(--dsw-alias-label-secondary, #5f6672); background: rgb(31 35 41 / 6%); }
/* 排序提示：与按钮组同处 .dim-jh-panelHead 第二行（用户 2026-10-26
   「将按钮行合并到文案行最右侧」，随后「文案改为一行显示」）。
   ⚠️ white-space: nowrap 是这次需求的核心：提示必须单行，不随窗口变窄折行。
   折行会让第二行变成两行高、把按钮组挤到垂直居中的怪位置，观感也乱。
   ⚠️ flex: 0 1 auto 而**不是** 1 1 0：1 1 0 的基准宽是 0，nowrap 下浏览器
   仍按 min-content 撑开，结果是「要么整行、要么溢出」；0 1 auto 按内容宽
   起算，配合 min-width: 0 才能在空间不足时真正收缩。
   ⚠️ overflow: hidden + text-overflow: ellipsis 是 nowrap 的必要配套：
   没有它们，窄窗口下文本会溢出到按钮组底下互相压字。省略号是最后手段，
   完整文案挂在元素的 title 上，悬停仍可读全。
   ⚠️ 上下 margin 归零：这一行的高度由两者中较高者决定，旧值 margin: 0 0 10px
   是「独占一行」时代的遗留，留着会在按钮组下方多出一截空隙。 */
.dim-jh-orderHint { flex: 0 1 auto; min-width: 0; margin: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8f959e); }

/* 顶部一行：状态点 + 名称 + 状态标签 */
.dim-jh-accountTop { display: flex; align-items: center; gap: 8px; }
.dim-jh-accountStatus { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-label-tertiary, #9aa0a6); }
.dim-jh-accountStatus[data-on="true"] { background: #22c55e; box-shadow: 0 0 0 3px rgb(34 197 94 / 14%); }
.dim-jh-accountName { flex: 1 1 auto; min-width: 0; overflow: hidden; font-size: 14px; line-height: 20px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); text-overflow: ellipsis; white-space: nowrap; }
.dim-jh-accountTag { flex: none; padding: 1px 8px; border-radius: 999px; font-size: 11px; line-height: 17px; font-weight: 500; }
.dim-jh-accountTag[data-tone="on"] { color: #15803d; background: rgb(34 197 94 / 12%); }
.dim-jh-accountTag[data-tone="off"] { color: var(--dsw-alias-label-tertiary, #8f959e); background: rgb(143 149 158 / 12%); }
/* 「限额中」标记：与 metaRow 的 warn 同色系，让「沉到底部的原因」一眼可辨。 */
.dim-jh-accountTag[data-tone="warn"] { color: #b45309; background: rgb(227 116 0 / 12%); }
/* 状态徽章兼作启停开关（用户 2026-10-26：把底部「停用」按钮的功能合并进来）。
   ⚠️ 只加「可点」的观感，不动 data-tone 的配色 —— 绿 / 灰两态与合并前逐字一致。 */
/* 用户反馈「不明显」（2026-10-26）：只给 cursor 不够 —— 胶囊本身太像一个
   纯展示标签。加 1px 边框，把它做成按钮的样子。
   ⚠️ 边框会让盒子长 2px（上下各 1px），故 padding 各减 1px 抵掉，
   与旁边的静态标签（如「限额中」）**保持等高** —— 同一行里两枚标签差
   2px 高度非常显眼。
   ⚠️ 先给 transparent 兜底再按 tone 上色：这样即使以后新增 tone，
   也不会有哪一态突然变高。 */
.dim-jh-accountTag[data-clickable="true"] { cursor: pointer; user-select: none; padding: 0 7px; border: 1px solid transparent; }
.dim-jh-accountTag[data-clickable="true"][data-tone="on"] { border-color: rgb(34 197 94 / 45%); }
.dim-jh-accountTag[data-clickable="true"][data-tone="off"] { border-color: rgb(143 149 158 / 40%); }
.dim-jh-accountTag[data-clickable="true"]:hover { filter: brightness(0.94); }
/* hover 时把边框也压深：只靠背景亮度变化，在浅色主题下几乎看不出。 */
.dim-jh-accountTag[data-clickable="true"][data-tone="on"]:hover { border-color: #15803d; }
.dim-jh-accountTag[data-clickable="true"][data-tone="off"]:hover { border-color: var(--dsw-alias-label-tertiary, #8f959e); }
.dim-jh-accountTag[data-clickable="true"]:active { transform: translateY(1px); }
/* 焦点圈：去掉它等于把「键盘可达」退化回只能用鼠标。 */
.dim-jh-accountTag[data-clickable="true"]:focus-visible { outline: 2px solid #1677ff; outline-offset: 1px; }

/* 元信息：键值对齐的网格 */
.dim-jh-accountMeta { display: grid; gap: 3px; margin: 8px 0 0; }
.dim-jh-metaRow { display: grid; grid-template-columns: 52px minmax(0, 1fr); align-items: baseline; gap: 8px; }
.dim-jh-metaRow dt { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8f959e); }
.dim-jh-metaRow dd { min-width: 0; margin: 0; overflow: hidden; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, #646a73); text-overflow: ellipsis; white-space: nowrap; }
.dim-jh-metaRow dd[data-tone="warn"] { color: #e37400; }
/* 积分未取到时的弱化提示。与 warn 区分：这不是异常，只是还没有数据 */
.dim-jh-metaRow dd[data-tone="muted"] { color: var(--dsw-alias-label-tertiary, #8f959e); }
.dim-jh-metaRow code { padding: 1px 5px; border-radius: 5px; background: var(--dsw-alias-bg-layer-2, #f4f5f7); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }

/* 账号卡片上的积分余额。
   覆盖 metaRow 的 overflow:hidden / nowrap —— 这里要的是横向排列的
   数值 + 次要说明，而 dd 默认样式是为单行截断文本准备的。 */
.dim-jh-metaRow dd.dim-jh-creditValue { display: flex; flex-direction: row; align-items: baseline; gap: 6px; overflow: visible; }
.dim-jh-creditTotal { font-size: 13px; font-weight: 600; color: #1677ff; font-variant-numeric: tabular-nums; }
.dim-jh-creditPackages { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8f959e); }
/* 分桶说明（三档带色）：永久绿 / 长期黄 / 临期红 + 倒计时（用户 2026-10-12）。
   ⚠️ 颜色语义与 credit-expiry.js 的 expirySplitParts 一一对应：
     permanent（服务端没给到期时间，真·永久）→ ok 绿
     longTerm（有到期时间但还早）              → warn 黄
     expiring（窗口内，再不用就作废）          → error 红
   ⚠️ 与 .dim-jh-badgeNotePart 同一套 tone 变量（深浅主题各自有定义）。 */
.dim-jh-creditPoolPart { font-size: 11px; font-variant-numeric: tabular-nums; }
.dim-jh-creditPoolPart[data-tone="ok"] { color: var(--dsw-alias-state-success-primary, #15803d); }
.dim-jh-creditPoolPart[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary, #b45309); }
.dim-jh-creditPoolPart[data-tone="error"] { color: var(--dsw-alias-state-error-primary, #d93025); }
.dim-jh-creditPoolPart[data-tone="muted"] { color: var(--dsw-alias-label-tertiary, #8f959e); }
.dim-jh-creditPoolSep { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8f959e); }
/* 已失效额度：弱化的橙色提示，与主数值的蓝色明确区分 */
.dim-jh-creditExpired { font-size: 11px; color: #b45309; }
/* 独立池（AStudio 星火积分等）：与上方三档分桶并列的事实标注。
   用中性灰而**不是** warn 橙 —— 它不是「快过期」的告警，而是「这笔钱不能混用」
   的说明；用橙色会与临期档抢注意力。 */
.dim-jh-creditExclusive { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8f959e); }

/* 限额重置徽章行 */
.dim-jh-rateLimits { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 8px; }
.dim-jh-rateLimitsLabel { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8f959e); }

/* 操作按钮：横向一行，右对齐 */
.dim-jh-accountActions { display: flex; flex-direction: row; flex-wrap: nowrap; justify-content: flex-end; gap: 8px; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--dsw-alias-border-l2, #f0f1f3); }

/* 带操作按钮的积分行：第三列 auto 让按钮贴最右（用户报障「底部那排按钮
   别单独占一行」）。⚠️ 只有传了 actions 的调用方才带这个类名 —— 其余
   provider 的 .dim-jh-metaRow 仍是两列，逐字不变。 */
.dim-jh-metaRow--actions { grid-template-columns: 52px minmax(0, 1fr) auto; }
/* 挂进积分行后就不再需要「独立成行」的那些装饰（上边距 / 分隔线），
   否则会在按钮上方多出一条线并撑高行距。
   align-self: center 覆盖 metaRow 的 baseline —— 按钮是 flex 容器，
   按基线对齐会贴到文字基线下方。 */
.dim-jh-metaRow--actions .dim-jh-accountActions { margin-top: 0; padding-top: 0; border-top: 0; align-self: center; }

/* 按钮：align dsh-im .dim-deliveryButton */
.dim-jh-btn { font-size: 12px; line-height: 18px; padding: 4px 12px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 8px; background: var(--dsw-alias-bg-layer-3, #fff); cursor: pointer; color: var(--dsw-alias-label-primary, #1f2329); white-space: nowrap; transition: border-color .15s ease, background .15s ease, color .15s ease; }
.dim-jh-btn:hover:not(:disabled) { border-color: color-mix(in srgb, #1677ff 40%, var(--dsw-alias-border-l2, #dfe1e5)); color: #1677ff; background: color-mix(in srgb, #1677ff 6%, var(--dsw-alias-bg-layer-3, #fff)); }
.dim-jh-btn[data-kind="primary"] { background: #1677ff; color: #fff; border-color: #1677ff; }
.dim-jh-btn[data-kind="primary"]:hover:not(:disabled) { background: #0f5fce; border-color: #0f5fce; color: #fff; }
.dim-jh-btn[data-kind="danger"] { color: #d93025; border-color: color-mix(in srgb, #d93025 35%, var(--dsw-alias-border-l2, #dfe1e5)); }
.dim-jh-btn[data-kind="danger"]:hover:not(:disabled) { color: #b3261e; border-color: #d93025; background: rgb(217 48 37 / 6%); }
.dim-jh-btn:disabled { opacity: 0.5; cursor: default; }


/* 纯图标按钮（如「领取新手任务」的礼物图标）。
   ⚠️ 存在的理由：.dim-jh-accountActions 是 flex-wrap: nowrap，
   行内已有 5 个文字按钮，再加一个「领取新手任务」会被挤出容器（用户报障）。
   故把它压成等宽等高的方形图标按钮，文案移到 title tooltip。
   正方形靠固定 padding（左右 = 上下）实现，不依赖内容宽度。
   ⚠️ 本文件整体是一个 JS 模板字符串，注释里**不能出现反引号** —— 会提前
   终止字符串（本次构建失败的成因）。 */
.dim-jh-iconBtn { display: inline-flex; align-items: center; justify-content: center; padding: 4px 8px; min-width: 26px; }
.dim-jh-iconBtn svg { display: block; }
/* 图标 + 短文字（如「模型列表」的列表图标 + 「模型」二字）。
   ⚠️ 与 .dim-jh-iconBtn 的区别：那个是纯图标（正方形，文案全在 title 里），
   这个是「图标打头、文字收尾」，横向排列且保留 6px 间距 —— 没有这条间距，
   svg 会紧贴文字，看着像一个怪字符。
   ⚠️ 本文件整体是 JS 模板字符串，注释里绝不能出现反引号（本行因此红过多次）。 */
.dim-jh-iconTextBtn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
.dim-jh-iconTextBtn svg { display: block; flex: none; }
/* 加载态：图标自转（「刷新积分」换图标后没有文字可换，只能靠动效表达进行中）。
   ⚠️ 必须尊重 prefers-reduced-motion —— 前庭功能敏感的用户会被旋转动画伤到，
   这是无障碍硬要求，不是可选项。降级后仍有 .dim-jh-btn:disabled 的 .5 透明度可辨识。
   ⚠️ 两条选择器缺一不可：纯图标按钮（刷新积分 / 新建账号 / 删除）用
   .dim-jh-iconBtn，而「图标 + 短文字」按钮（模型、永久积分）用
   .dim-jh-iconTextBtn —— 只写前者时，后者的图标在加载态**不会转**，
   用户眼神落在图标上就以为没点上。
   ⚠️ 本文件整体是 JS 模板字符串，注释里绝不能出现反引号（本行就因此红过一次）。 */
@keyframes dim-jh-spin { to { transform: rotate(360deg); } }
.dim-jh-iconBtn[data-loading="true"] svg,
.dim-jh-iconTextBtn[data-loading="true"] svg { animation: dim-jh-spin .9s linear infinite; }
@media (prefers-reduced-motion: reduce) {
  .dim-jh-iconBtn[data-loading="true"] svg,
  .dim-jh-iconTextBtn[data-loading="true"] svg { animation: none; }
}

/* 限流 TTL 徽章 */
.dim-jh-ttlBadge { display: inline-block; padding: 1px 8px; border-radius: 999px; background: rgb(227 116 0 / 10%); color: #b45309; font-size: 11px; line-height: 17px; font-weight: 500; }

/* 面板标题区：标题独占一行，操作按钮另起一行。
   此前用单行 space-between 把标题与 5 个按钮挤在一起，面板一窄就溢出被裁掉。

   ⚠️⚠️ **刻意不写 align-items（= 默认 stretch）**（2026-10-21 合并审计的**根因修法**）。

   原先这里是 align-items: flex-start ⇒ panelHead 是 column flex、交叉轴是**水平**
   ⇒ 每个子项按 fit-content 收缩到 **max-content**。后果是**一整类**「窄条/贴左」缺陷，
   而不只是账号卡片那一格：

   - .dim-jh-accountList：单账号时卡片缩成 ~257px 窄条（多账号时被那句约 1200px 长的
     排序提示撑宽，所以只有单账号暴露）—— 这是用户真机看到的那一格；
   - .dim-jh-probeNotice / .dim-jh-empty / 补偿卡片：**短文案**时渲染成带边框背景的
     **窄药丸**；其中 .dim-jh-empty 的加载文案 正在读取账号列表… 还带
     text-align: center ⇒ 每次开面板都看到一句**贴左**的加载提示（最常被看到的一格）。

   ⇒ 去掉 align-items 让全部子项 stretch 到面板宽，**一次修好账号列表 + 7 个兄弟**。

   ⚠️ **本次唯一的可见行为变化**：.dim-jh-headerActions 有 justify-content: center，
   而它此前是 max-content 宽（没有空余可分配 ⇒ 居中不生效、观感贴左）；现在它整宽 ⇒
   按钮总宽小于面板宽时**真的居中**（这正是它声明 center 的本意）。
   ⚠️ 2026-10-26 起改为贴右（见下方 .dim-jh-headerActions 段落），本段只保留
   「不要改回 flex-start」这条仍然成立的结论。

   ⚠️ **不要**把它改回 flex-start：那会同时复发上面那一整类缺陷
   （而下面 .dim-jh-accountList 那两条规则只能兜住账号列表这一格）。

   ⚠️ 2026-10-26 由 column 改为 **row + wrap**（用户要求「将按钮行合并到
   文案行最右侧」）。布局契约（同日第三次改后，账号列表已移出本容器）：
     第一行 = .dim-jh-panelTitle（flex: 1 0 100% 强制独占）
     第二行起 = 各条 .dim-jh-probeNotice（flex: 1 0 100% 各占一整行，见下方规则）
     最后一行 = .dim-jh-orderHint（flex: 0 1 auto）+ .dim-jh-headerActions
              （margin-left: auto 贴右）
   ⚠️ 账号列表**不再**是本容器的子项（它挪到 .dim-jh-accountSection 下，
   由那里负责滚动）—— 所以本容器里没有「第三行起 = accountList」那条了。
   ⚠️ 三个子项的 flex-basis 是**互相依赖**的：任何一项改成 auto，那一行就会
   与相邻项挤在一起。改布局时三处一起看，别只改一处。
   ⚠️ align-items: center 让「提示 + 按钮组」那一行里两种高度的元素垂直居中对齐。 */
.dim-jh-panelHead { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 16px; }
/* 标题独占一行（用户 2026-10-26「将按钮行合并到文案行最右侧」的配套）。
   ⚠️ flex-basis: 100% 是唯一能让标题单独占一行的写法：wrap + basis 100%
   会把后续兄弟挤到下一行，而**不必**给 panelHead 换 flex-direction。 */
.dim-jh-panelHead > .dim-jh-panelTitle { flex: 1 0 100%; }
/* 面板级状态提示（探测结果 / 锁定状态 / 领取结果 / 新手任务 / 登录链接 / 补偿卡）。
   ⚠️ 2026-10-26 用户要求「信息应该在按钮行上方行，而不是下方行」：这些提示
   已从 section 直接子节点搬进 panelHead、排在按钮组之前，**必须各占一整行**。
   缺了 flex: 1 0 100% 这条，它们是 flex: 0 1 auto 的，会与按钮组挤在同一行 ——
   正是「补偿积分已领取」被挤到按钮组右侧那个报障的形态。
   ⚠️ margin-bottom 归零：行间距由 panelHead 的 gap: 10px 统一给，
   两套间距并存会让提示与按钮行之间多出一截。
   ⚠️ 必须是**直接子级**选择器：若哪天有人给这些提示包一层容器，本规则
   与下面那两条 tone 规则会一起失效（它们全部挂在直接子级上）。 */
.dim-jh-panelHead > .dim-jh-probeNotice { flex: 1 0 100%; margin-bottom: 0; }
/* 账号管理页：整页是一个纵向 flex，**只有账号列表滚动**（用户 2026-10-26
   「页头滚动时应该只滚动账号列表」）。
   布局契约：
     第一行 .dim-jh-panelHead   —— flex: none，页头恒在顶部，不参与滚动
     第二行 .dim-jh-accountList —— flex: 1 1 auto + min-height: 0 + overflow-y: auto
                                    （以及「正在读取 / 空态」那几个 .dim-jh-empty）
   ⚠️ min-height: 0 是必需的：flex 子项默认 min-height: auto，内容多时它会被
   撑到内容高而不是收缩，于是滚动条又跑回 .dim-jh-panel 上，页头照旧跟着滚。
   ⚠️ 非列表态（loading / error / 空账号）用的是 .dim-jh-empty，同样给 flex: 1 1 auto
   让它在剩余空间里居中，而不是把 section 撑出滚动。 */
.dim-jh-accountSection { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
.dim-jh-accountSection > .dim-jh-panelHead { flex: none; }
.dim-jh-accountSection > .dim-jh-empty { flex: 1 1 auto; min-height: 0; overflow-y: auto; }

/* 账号列表容器：宽度与账号数量无关，并且**它就是滚动容器**
   （用户 2026-10-26「页头滚动时应该只滚动账号列表」）。
   ⚠️ 2026-10-26 第二次改：本容器此前是 .dim-jh-panelHead 的子项
   （那时用 flex: 1 0 100% 靠 wrap 强制独占一行）。现在它在
   .dim-jh-accountSection（**纵向** flex）里，那套 basis: 100% 的写法
   在纵向主轴下等于「高度取满容器且不许收缩」⇒ 内容多时直接溢出、
   滚动条跑回 .dim-jh-panel 上，页头又开始跟着滚。
   正确写法是 flex: 1 1 auto + min-height: 0 + overflow-y: auto。
   ⚠️ 根因已在上面 .dim-jh-panelHead 修掉（去掉 align-items: flex-start），
      故 align-self 现在是**冗余兜底** —— 保留是刻意的：万一有人把
      align-items: flex-start 改回来，账号列表（用户唯一明确报障过的那一格）仍正确。
   ⚠️ min-width: 0 在纵向 flex 的**交叉轴**方向是惰性声明，保留只为将来
      本容器改成横向排布时承重；**不要**把它当成「账号列表靠它才整宽」。 */
.dim-jh-accountList { flex: 1 1 auto; align-self: stretch; min-width: 0; min-height: 0; overflow-y: auto; }
.dim-jh-accountList > .dim-jh-accountCard { width: 100%; box-sizing: border-box; }
.dim-jh-panelTitle { margin: 0; font-size: 16px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); }

/* 操作按钮组。**两类页头共用同一个类名**，对齐方式不同：
   ① 全局页头（.dim-jh-header 内）：供应商 / 一键签到 / 备份 / 恢复 / 网关 /
      Token 用量 / 渠道原生搜索 —— **居中**；
   ② 账号管理页头（.dim-jh-panelHead 内）：模型列表 / 刷新 / 一键领取积分 /
      重测所有 / 重置所有 / 新建账号 —— **贴右**（与排序提示同一行）。
   ⚠️ 故基础规则写**居中**，贴右只在 .dim-jh-panelHead 的直接子级选择器下覆盖。
   2026-10-26 我先直接把基础规则改成 flex-end，结果把全局页头那排按钮也
   一起拖到了最右（用户截图报障「供应商…渠道原生搜索按钮行应该保持居中」）——
   共用类名改默认值会波及另一处，这是本文件最常犯的一类错。
   ⚠️ 允许换行：按钮数量随 provider / 状态变化，固定单行在窄窗口下必然溢出。
   ⚠️ 本文件 CSS 装在**模板字符串**里 —— 注释内绝不能出现反引号，否则提前
   闭合、esbuild 报 "Expected ; but found ..." 并把指针指到注释行（2026-10-07
   在同一天内踩了两次，故把这条写进最常改的页头段落）。
   ⚠️ 页头左侧标题块（.dim-jh-brand / .dim-jh-brandName）已删除（2026-10-07）。
   ⚠️ 全局页头的对齐历经三次调整，**当前是居中**：
   ① 有标题时：space-between 靠标题把按钮推到右边；
   ② 标题删除后：改 flex: 1 + 默认左对齐（贴左，注释原话「保持原观感」）；
   ③ 2026-10-14：用户要求改**居中**（justify-content: center）——
      按钮组是页头唯一内容，居中让整排在视觉上更平衡，也不与下方内容左边界打架。
   ⚠️ 居中与 flex: 1 1 auto 并存是**必需的**：去掉 flex 后容器宽度收缩到内容宽，
   justify-content 就没有可分配的空间、视觉上退回贴左。 */
.dim-jh-headerActions { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 8px; flex: 1 1 auto; min-width: 0; }

/* 账号管理页头里的那一组**贴右**（用户 2026-10-26「将按钮行合并到文案行最右侧」）：
   margin-left: auto 是主手段（排序提示存在时把它顶到最右），
   justify-content: flex-end 是兜底（提示为 null、本组独占一行时同样贴右）。
   ⚠️ 两条缺一不可：只留 flex-end 时提示会与按钮组之间留一大段空白；
   只留 auto 时「账号 ≤ 1、提示不渲染」那种状态下按钮组会贴左。
   ⚠️ flex: 1 1 auto 在这里的作用是让本组吃掉第二行的剩余宽度，
   auto 外边距才有效（若本组收缩到内容宽，auto 外边距没有可分配空间，
   视觉上会贴着提示末尾而不是贴右）。 */
.dim-jh-panelHead > .dim-jh-headerActions { justify-content: flex-end; margin-left: auto; }

/* 上一次「重测 / 重置」的结果提示 */
.dim-jh-probeNotice { margin-bottom: 12px; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l2, #eef0f3); background: var(--dsw-alias-bg-layer-2, #f7f8fa); font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, #646a73); }
.dim-jh-probeNotice[data-tone="ok"] { border-color: color-mix(in srgb, #22c55e 35%, var(--dsw-alias-border-l2, #eef0f3)); background: rgb(34 197 94 / 8%); color: #15803d; }
.dim-jh-probeNotice[data-tone="warn"] { border-color: color-mix(in srgb, #e37400 35%, var(--dsw-alias-border-l2, #eef0f3)); background: rgb(227 116 0 / 8%); color: #b45309; }
.dim-jh-probeNotice[data-tone="error"] { border-color: color-mix(in srgb, #d93025 35%, var(--dsw-alias-border-l2, #eef0f3)); background: rgb(217 48 37 / 8%); color: #b3261e; }
.dim-jh-probeDetails { margin: 6px 0 0; padding-left: 18px; display: grid; gap: 2px; }
.dim-jh-probeDetails li { font-size: 12px; line-height: 18px; }
/* 授权链接 + 复制按钮同行。链接不设 min-width: 0 时，300+ 字符的 URL 会把按钮顶出可视区。 */
.dim-jh-loginLinkRow { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 6px; }
.dim-jh-loginLink { flex: 1 1 240px; min-width: 0; color: var(--dsw-alias-link); word-break: break-all; }
/* 复制失败时把链接变成一次点击全选，用户能直接 Ctrl+C。 */
.dim-jh-loginLinkRow[data-copy-state="failed"] .dim-jh-loginLink { user-select: all; }

/* 登录弹窗 */
.dim-jh-loginOverlay { position: fixed; inset: 0; background: rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.dim-jh-loginDialog { background: var(--dsw-alias-bg-layer-1, #fff); border-radius: 12px; padding: 24px; min-width: 320px; box-shadow: 0 8px 32px rgba(0,0,0,0.15); }
.dim-jh-loginDialog h3 { margin: 0 0 8px; font-size: 16px; }
.dim-jh-loginDialog p { font-size: 13px; color: var(--dsw-alias-label-secondary, #555); margin: 0 0 16px; }
.dim-jh-loginActions { display: flex; gap: 8px; justify-content: flex-end; }

/* ── 模型列表弹窗（「显示列表」） ── */
/* 复用登录弹窗的遮罩模式：fixed 覆盖全屏，z-index 高于设置页内容。
   3000 高于 .dim-jh-loginOverlay 的 1000，保证两个弹窗同时存在时模型列表在上。 */
.dim-jh-modalOverlay { position: fixed; inset: 0; z-index: 3000; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgba(0,0,0,0.32); }
/* ⚠️ .dim-jh-modalOverlay--top（顶部锚定修饰类）已于 2026-10-26 **整体删除**，
   全仓已无任何 className 用到它。它当初存在的理由（2026-10-07 真实报障
   「输入文字后整个弹框的位置会发生改变，有点突兀」）并没有消失：
   align-items: center 会把「弹窗高度变化」直接翻译成「整体位置跳动」——
   模型列表弹窗搜索后从 32 项变 3 项，实测 top 从 4px 跳到 187px。
   当时的解法是把上边缘钉死在顶部（flex-start + 8vh）。
   现在用户要求**所有弹窗一律居中**（视觉一致性优先），故改为
   「居中 + 给弹窗兜一个 min-height」，把高度变化区间压到 (min-height, max-height]。
   见下方 .dim-jh-modal 的 min-height 注释。
   ⚠️ 若日后仍有「弹窗上下跳」的报障，正解是给**列表型**弹窗固定 height，
   而不是把本修饰类加回来（加回来就等于又一次违反「全部居中」）。
   ⚠️ 本文件整体是 JS 模板字符串，注释里**不能出现反引号**（会提前终止字符串）。 */
/* 弹窗本体：max-height 按视口封顶，min-height 兜住居中时的跳动幅度。
   min-height 取 300px 的由来：模型列表 3 项时内容高约 260px，兜到 300 后
   与「32 项撑满 640px」的位移差从约 380px 降到约 340px —— 仍有位移，但
   视觉上不再像「跳了一下」；再往上兜（如 480px）会让表单型小弹窗空出一大片。 */
.dim-jh-modal { display: flex; flex-direction: column; width: min(560px, 100%); min-height: min(300px, calc(100vh - 48px)); max-height: min(640px, calc(100vh - 48px)); padding: 20px 22px; border-radius: 14px; background: var(--dsw-alias-bg-layer-1, #fff); box-shadow: 0 16px 48px rgba(0,0,0,0.22); }
/* Token 用量弹窗：比通用弹窗宽一档（960px），高度上限 700px（2026-10-26 用户指定）。
   ⚠️ 这里同时把 min-height 压回 0：通用 .dim-jh-modal 的 min-height 是 300px
   （为居中时兜住「列表变短导致整体跳动」），但本弹窗的内容永远够高，
   那条兜底只会让它下边框多空出一截 —— 本弹窗要的是「上下收紧」。
   max-height 取 700px：比通用 640px 高、比原 820px 矮；1080p 下遮罩内边距
   24px×2 之后仍有余量，汇总区 3 张卡片 + 明细表十余行的常见形态不出滚动条。 */
.dim-jh-modal--ledger { width: min(960px, 100%); min-height: 0; max-height: min(700px, calc(100vh - 48px)); }
.dim-jh-modalHead { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dim-jh-modalTitle { min-width: 0; display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px; font-size: 15px; line-height: 22px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); }
.dim-jh-modalSubtitle { overflow: hidden; font-size: 12px; line-height: 18px; font-weight: 400; color: var(--dsw-alias-label-tertiary, #8f959e); text-overflow: ellipsis; white-space: nowrap; }
/* 头部右侧按钮组与标题里的计数徽标 */
.dim-jh-modelPanelActions { flex: none; display: flex; align-items: center; gap: 8px; }
.dim-jh-modelPanelCount { font-size: 12px; line-height: 18px; font-weight: 400; color: var(--dsw-alias-label-tertiary, #8f959e); }
.dim-jh-modalHint { flex: none; margin: 10px 0 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8f959e); }
/* 弹窗提示里的强调词：danger=危险操作（覆盖/不可撤销），warn=警示（妥善保管） */
.dim-jh-emph-danger { color: #b3261e; font-weight: 600; }
.dim-jh-emph-warn { color: #b45309; font-weight: 600; }
.dim-jh-modal .dim-jh-probeNotice { flex: none; margin: 10px 0 0; }
/* .dim-jh-modelBulkBar（模型列表顶部「打开全部 / 关闭全部」工具条）已于
   2026-10-26 随按钮一起删除。分组按钮走 .dim-jh-modelGroupBtn，不受影响。
   ⚠️ 本条注释里**不能**出现反引号：STYLES 整段是模板字符串，写一个就提前闭合。 */
/* 搜索 + 状态筛选条（Cline 目录近 500 条，没有它就只能一页页翻）。
   允许换行：窄面板下搜索框与三个状态按钮放不进一行。 */
.dim-jh-modelFilterBar { flex: none; display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
/* 搜索框占据剩余宽度，最小 140px —— 再窄就输不下有意义的模型名片段。 */
.dim-jh-modelSearch { flex: 1 1 140px; min-width: 140px; width: auto; }
.dim-jh-modelStatusFilter { flex: none; display: flex; align-items: center; gap: 6px; }
/* 选中的筛选按钮高亮：三个按钮外观一致时用户看不出当前筛的是什么。 */
.dim-jh-modelStatusFilter .dim-jh-btn[data-active="true"] { border-color: #1677ff; color: #1677ff; background: color-mix(in srgb, #1677ff 10%, var(--dsw-alias-bg-layer-3, #fff)); font-weight: 600; }
/* 列表区独立滚动：头部与说明固定，模型多时只滚中间 */
/* ⚠️ overflow-x: hidden 是**兜底**，不是主修复（主修复见下方 grid 的 minmax）。
   没有它时，任何一行的偶然溢出都会让整个弹窗出现横向滚动条，而横向滚动条会把
   每一行的**开关**一起推出可视区 —— 用户报障「开关在最右边，要横向滑动才看得到」。
   ⚠️ 本文件整体是 JS 模板字符串，注释里**不能出现反引号**（会提前终止字符串，
   本次就因此构建失败过一次）—— 说明 CSS 属性时一律不加反引号。 */
.dim-jh-modalBody { flex: 1 1 auto; min-height: 0; margin-top: 10px; overflow-y: auto; overflow-x: hidden; }
.dim-jh-modalBody .dim-jh-empty { padding: 24px; }

/* 每行一个模型：左侧名称 + id，右侧开关 */
/* ⚠️ grid-template-columns: minmax(0, 1fr) 是**必须的**，不能省。
   单列 grid 的列宽默认是 auto，而 grid 项的 min-width 默认也是 auto ——
   两者叠加会让列宽按**最宽内容**撑开，于是长 id 把行推宽、行末的开关被挤出
   弹窗右边缘（真实缺陷：Cline 有 300 个 id 超过 20 字符，几乎每行都中招，
   表现为「开关在最后，需要横向滑动，我看不到」）。
   minmax(0, 1fr) 把列的最小宽度显式压到 0，行才会跟着容器收缩。 */
.dim-jh-modelList { display: grid; grid-template-columns: minmax(0, 1fr); gap: 2px; }
/* 行本身是 grid 项也是 flex 容器，两处都需要 min-width: 0 才允许收缩。 */
.dim-jh-modelRow { display: flex; align-items: center; gap: 12px; min-width: 0; padding: 7px 8px; border-radius: 8px; cursor: pointer; transition: background .15s ease; }
.dim-jh-modelRow:hover { background: var(--dsw-alias-bg-layer-2, #f7f8fa); }
/* 已关闭的模型整体降透明度：一眼能看出哪些被隐藏了 */
.dim-jh-modelRow[data-disabled="true"] .dim-jh-modelInfo { opacity: 0.5; }

/* 行首的供应商图标（2026-10-26，用户要求「所有页面供应商和模型左侧 + 图标」）。
   ⚠️ .dim-jh-providerIcon 的基类尺寸是 30px —— 那是给左栏 rail 的 48px 高按钮
   用的；模型行 padding 只有 7px，直接套会顶高整行、把行距撑开。
   故这里用**后代选择器**就地收窄，不动基类（rail 与两处弹窗共用同一枚 class）。
   flex: none 是必需的：同行的 .dim-jh-modelInfo 是 flex: 1 1 auto，
   图标若参与收缩会被长模型名挤成一条线。
   阴影也去掉 —— 22px 的方块配 30px 的那层投影会显脏。 */
.dim-jh-modelRow > .dim-jh-providerIcon { flex: none; width: 22px; height: 22px; border-radius: 6px; box-shadow: none; }
.dim-jh-modelRow > .dim-jh-providerIcon img { width: 15px; height: 15px; }
/* 已关闭的模型连图标一起降透明度：只淡文字会让图标显得「亮着但不可用」。 */
.dim-jh-modelRow[data-disabled="true"] > .dim-jh-providerIcon { opacity: 0.5; }

/* 「供应商开关」弹窗的行拖拽（2026-10-06）。
   视觉语言与账号卡片（.dim-jh-accountCard[data-dragging] 系）完全一致：
   源行淡出虚线、落点行画插入线。
   ⚠️ 这几行**必须带 .dim-jh-modal 作用域前缀**：.dim-jh-modelRow 是共享类名，
   ModelToggle（模型列表弹窗）与 GatewayPanel 也在用它们。那些行不设
   data-dropBefore/After，伪元素无 content 故不渲染，但给它们挂 position:relative
   仍是作用域过宽 —— 将来任一处加 absolute 子元素都会莫名受影响。
   与既有的 .dim-jh-modal .dim-jh-probeNotice 同一收窄惯例。
   ⚠️⚠️ 本文件整体是一个 JS **模板字符串**：注释里**禁止**出现反引号，
   否则会提前终止字符串、把后面的 CSS 当成代码解析（实测报 TS2304）。 */
.dim-jh-modal .dim-jh-modelRow { position: relative; }
.dim-jh-modal .dim-jh-modelRow[data-dragging="true"] { opacity: 0.4; border-style: dashed; }
.dim-jh-modal .dim-jh-modelRow[data-dropBefore="true"]::before { content: ''; position: absolute; left: 0; right: 0; top: -5px; height: 3px; border-radius: 2px; background: #1677ff; }
.dim-jh-modal .dim-jh-modelRow[data-dropAfter="true"]::after { content: ''; position: absolute; left: 0; right: 0; bottom: -5px; height: 3px; border-radius: 2px; background: #1677ff; }
/* 拖拽柄在弹窗行里略收窄：行高比账号卡片矮（padding 7px vs 14px），
   16px 宽的柄会顶着模型名，缩到 14px 并把 gap 让出来。 */
.dim-jh-modal .dim-jh-modelRow .dim-jh-dragHandle { width: 14px; }
.dim-jh-modelInfo { flex: 1 1 auto; min-width: 0; display: flex; align-items: baseline; gap: 8px; }
/* 名称与 id 都必须能收缩（min-width: 0 + 可收缩的 flex-basis），否则长内容会
   顶宽整行。展示名优先保留，故 id 另加 max-width 上限。
   ⚠️ id 早期是 flex: none（拒绝收缩）—— 那正是「开关被挤出可视区」最直接的成因。 */
.dim-jh-modelName { flex: 0 1 auto; min-width: 0; overflow: hidden; font-size: 13px; line-height: 19px; font-weight: 500; color: var(--dsw-alias-label-primary, #1f2329); text-overflow: ellipsis; white-space: nowrap; }
.dim-jh-modelId { flex: 0 1 auto; min-width: 0; max-width: 46%; overflow: hidden; padding: 1px 5px; border-radius: 5px; background: var(--dsw-alias-bg-layer-2, #f4f5f7); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--dsw-alias-label-tertiary, #8f959e); text-overflow: ellipsis; white-space: nowrap; }

/* ── 模型能力标记（如「可发图片」）──
   ⚠️ 只标在**支持**的那一类模型上：不标 = 不支持。这样用户扫一眼清单就知道
   哪些模型能发图，不必靠撞一次 unsupported_content 才发现。
   flex: none 是必需的 —— 它是行尾的固定标签，参与收缩会被 id/name 挤没。 */
.dim-jh-modelBadge { flex: none; padding: 1px 6px; border-radius: 5px; background: var(--dsw-alias-color-success-light, #e8ffea); color: var(--dsw-alias-color-success, #00875a); font-size: 11px; line-height: 16px; white-space: nowrap; }

/* ── 已下架（失效）模型（2026-10-06 复审 !66）──
   ⚠️ **必须放在上面 .dim-jh-modelName / .dim-jh-modelId 基础规则之后**：
   tests/unit/model-filter.spec.ts 的 ruleOf() 按**源码顺序**取第一条匹配规则，
   把带 [data-dead] 的规则写在前面会让它误取到本块、跳过基础规则。
   ⚠️⚠️ **本块内禁止出现反引号**（AGENTS.md 红线：样式是模板字符串，注释里的
   反引号会提前闭合模板；tests/unit/zcode-channel-dialog.spec.ts 有专门用例守着）。
   与「已关闭」**必须视觉可区分**：一个是用户的主动选择（开关可拨回），
   一个是系统判定上游已移除（只能点「重新显示」恢复）。若长得一样，用户会去拨
   那个根本不存在的开关，于是以为「模型被吞了、插件有 bug」。
   ⇒ 用左侧警示竖条 + 琥珀色角标，与「已关闭」的纯淡出区分开。 */
.dim-jh-modelRow[data-dead="true"] { box-shadow: inset 3px 0 0 var(--dsw-alias-warning, #d48806); }
.dim-jh-modelRow[data-dead="true"] .dim-jh-modelInfo { opacity: 1; }
.dim-jh-modelRow[data-dead="true"] .dim-jh-modelName { color: var(--dsw-alias-warning, #d48806); }
.dim-jh-modelDead {
  flex: none;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-warning, #d48806);
  background: color-mix(in srgb, var(--dsw-alias-warning, #d48806) 12%, transparent);
}
.dim-jh-modelRestore {
  flex: none;
  padding: 2px 10px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--dsw-alias-text-secondary, #4e5969);
  background: var(--dsw-alias-bg-layer-2, #f7f8fa);
  border: 1px solid var(--dsw-alias-border-l2, #dfe1e5);
  cursor: pointer;
}
.dim-jh-modelRestore:hover:not(:disabled) {
  color: #1677ff;
  border-color: color-mix(in srgb, #1677ff 40%, var(--dsw-alias-border-l2, #dfe1e5));
}
.dim-jh-modelRestore:disabled { opacity: 0.5; cursor: default; }
/* 顶部批量恢复条 */
.dim-jh-modelDeadBar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 6px 0;
  padding: 7px 10px;
  border-radius: 8px;
  font-size: 12px;
  color: var(--dsw-alias-text-secondary, #4e5969);
  background: color-mix(in srgb, var(--dsw-alias-warning, #d48806) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-warning, #d48806) 26%, transparent);
}

/* ── 思考档位对照表 ──
   与模型清单的行**刻意不同**：那两行的 id/name 用 ellipsis 截断（清单要紧凑），
   而对照表的内容本身就是用户要抄的东西 —— 截断等于让功能失效
   （真实反馈：「你这对照表字符过长都被省略了」）。
   故这里用 grid 竖排：第一行模型 id + 徽标，后两行整宽、可换行、可选中复制。
   ⚠️ 绝不能加 text-overflow: ellipsis / white-space: nowrap。 */
.dim-jh-effortRow { display: grid; grid-template-columns: minmax(0, 1fr); gap: 3px; min-width: 0; padding: 7px 8px; border-radius: 8px; }
.dim-jh-effortRow:hover { background: var(--dsw-alias-bg-layer-2, #f7f8fa); }
.dim-jh-effortHead { display: flex; align-items: center; gap: 8px; min-width: 0; }
/* 模型 id 在这里允许换行（对照表不追求单行紧凑），但仍优先占满剩余宽度。 */
.dim-jh-effortModel { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-primary, #1f2329); }
.dim-jh-effortLine { min-width: 0; overflow-wrap: anywhere; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, #4e5969); }
.dim-jh-effortLabel { color: var(--dsw-alias-label-tertiary, #8f959e); }
/* 搜索结果为空时的提示（与其它空状态同款观感）。 */
.dim-jh-effortEmpty { padding: 8px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8f959e); }
/* 档位对照行里的模型名也**不得截断**（用户 2026-10-04：「所有胶囊内容都没有
   完整显示」）。这里本就没写 ellipsis，但补一条**显式**声明把意图锁住：
   下面「网关弹窗里的胶囊」那条 .dim-jh-modelId 规则不该被误用到它身上，
   而将来若有人给 .dim-jh-effortModel 加上截断，这条会立刻在单测里变红。
   ⚠️ 本文件整体是一个 JS 模板字符串，注释里**不能出现反引号** —— 会提前
   终止字符串（见 .dim-jh-iconBtn 处的同款警告）。 */
.dim-jh-gatewayModal .dim-jh-effortModel { overflow: visible; text-overflow: clip; white-space: normal; overflow-wrap: anywhere; }

/* ── 网关弹窗的排版收紧（用户 2026-10-04 要求：「这几段话之间的行间距小一点」）──
   ⚠️ 必须加 .dim-jh-gatewayModal 前缀：.dim-jh-modalHint 是**共用**类，
   另有 24 处调用点（账号面板、opencode 弹窗、备份弹窗…），本次只该动网关弹窗
   —— 全局把 10px 改成 6px 会悄悄改掉那些页面的观感。
   本弹窗有 8 处说明行，10px × 8 ≈ 80px 空隙，收成 6px 后观感明显紧凑。 */
.dim-jh-gatewayModal .dim-jh-modalHint { margin-top: 6px; }
/* 弹窗顶部那三行是**同一段话**（推荐 / 协议 / 地址），彼此再紧一档，
   否则它们看起来像三个互不相干的段落。
   ⚠️ 现在「思考档位对照表」那段的两句说明也用这个类（同样是一段话拆成两行，
   为的是不让品牌名 CC Switch 在行尾被从中间切开）。 */
.dim-jh-gatewayModal .dim-jh-gatewayLine { margin-top: 4px; }

/* ── 三段功能区的**分隔**（用户 2026-10-04：「这三坨字全混在一起有点难看清」）──
   用户把弹窗分成三块：① 开关 + 连接信息（推荐 / 协议 / 地址 / API KEY）
   ② 模型 ID 清单 ③ 思考档位对照表。
   此前三段之间只靠一个 16px 的 margin，而每段内部又各有若干行 12px 灰字，
   视觉上连成一片 —— 用户找不到「下一块从哪开始」。

   做法：段间用**一条上边框 + 更大的上间距**切开，段内保持原有的紧凑。
   ⚠️ 用 border-top 而不是背景色块：弹窗会被截图，色块在深色主题下还要另配
   一整套 token（本文件别处同理，见 .dim-jh-gatewayCards 的注释）。
   ⚠️ 第一段**不要**上边框（它紧跟在弹窗标题下，加线会像多出一条分隔条）。 */
.dim-jh-gatewaySection { display: block; }
.dim-jh-gatewaySection + .dim-jh-gatewaySection {
  margin-top: 12px; padding-top: 10px;
  border-top: 1px solid var(--dsw-alias-border-l2, #eef0f3);
}
/* 段标题比正文说明重一档，作为「这块讲什么」的锚点。
   ⚠️ 不能沿用 .dim-jh-modalHint 那套 12px 灰字 —— 段标题与段内说明同为灰色时，
   分隔线的效果会被抵消（用户仍然分不清哪一行是标题）。 */
.dim-jh-gatewaySectionTitle { margin: 0; font-size: 13px; line-height: 19px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); }
/* 段内第一行紧跟段标题，不再叠那 6px。 */
.dim-jh-gatewaySectionTitle + .dim-jh-modalHint { margin-top: 3px; }
/* 弹窗末尾那条安全提示：与上面三段拉开，且**不属于任何一段**（它是整个弹窗的脚注）。 */
.dim-jh-gatewayModal .dim-jh-gatewayFootnote { margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--dsw-alias-border-l2, #eef0f3); }

/* ── 密钥行：小号按钮，不让按钮把这一行撑高 ──
   ⚠️ 用户 2026-10-04 报障：「复制密钥」「显示明文」大到把这行撑开。
   根因是 .dim-jh-btn 是**通用**按钮（padding 4px 12px + line-height 18px
   ⇒ 约 28px 高），而同行只有 18px 高的说明文字 —— 按钮比文字高 10px，
   整行的高度就被它顶起来了。这里单独压到约 22px，与文字行接近。
   ⚠️ 不能直接改 .dim-jh-btn（30+ 处调用点：页头、卡片头、对照表…）。
   ⚠️ 用户随后又要求「下面的四个按钮也按复制密钥的大小来统一」，故把
   清单/对照表那两个操作行（.dim-jh-gatewayActions）并进同一条规则 ——
   两处必须是**同一条规则**，各写一份迟早一处改了另一处没改。 */
.dim-jh-gatewayKeyRow { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.dim-jh-gatewayKeyRow .dim-jh-btn,
.dim-jh-gatewayModal .dim-jh-gatewayActions .dim-jh-btn { padding: 2px 8px; font-size: 11px; line-height: 16px; border-radius: 6px; }
/* 「API KEY：」标签：与按钮同基线、不可压缩（否则窄面板下会折成两行）。 */
.dim-jh-gatewayKeyRow .dim-jh-gatewayKeyLabel { flex: none; margin: 0; }
/* 下方两个操作行（模型清单 / 思考档位对照表）的间距也向密钥行看齐（8px → 6px）：
   四个按钮既然压成小号，原来的 8px 间隔配小按钮会显得松散。
   ⚠️ 另加 flex-wrap: wrap：.dim-jh-modelPanelActions 默认是 nowrap
   （页头那两三个固定按钮用它没问题），而这两行的按钮文案带**动态计数**
   （「复制全部 1234 个 ID」「复制对照表（1234 行）」），计数一长，nowrap
   会把按钮推出容器、点不到。实测当前数据（15 个模型）在 364px 窄弹窗下不出问题，
   但那是**当前数据**的结论 —— 换行让它对任意计数都成立。
   ⚠️ 本文件整体是一个 JS 模板字符串，注释里**不能出现反引号**（会提前终止字符串）。
   我在这条注释里用反引号括了一次类名，直接把文件从中间截断、构建产物语法错误 ——
   写类名时**裸写**，要强调就用「」或**。 */
.dim-jh-gatewayModal .dim-jh-gatewayActions { gap: 6px; flex-wrap: wrap; }

/* ── 网关清单：**一个供应商一张卡片**（模型清单与档位对照表共用）──
   用户 2026-10-03 报障：此前按「一个模型一行」平铺，同一家的
   deepseek-account/deepseek-flash 与 deepseek-account/deepseek-v4-pro
   看起来毫无关系；用户真正要对照的是「哪家有哪些模型」，故改成分组卡片。
   分组判据在 openai-gateway-panel.js 的 groupGatewayEntries（纯函数，可单测）。
   ⚠️ 本文件整体是 JS 模板字符串，注释里**不能出现反引号**（会提前终止字符串）。 */
.dim-jh-gatewayCards { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
/* 卡片：细边框 + 圆角，与复用的分组头（.dim-jh-modelGroup）同一种规格语言。
   ⚠️ min-width: 0 是**必需**的：卡片是 grid 项，默认 min-width: auto 会被
   内部长 id 撑开，从而把整个弹窗顶出横向滚动条（模型列表踩过同一个坑）。 */
.dim-jh-gatewayCard { min-width: 0; border: .5px solid var(--dsw-alias-border-l3, #e5e5e5); border-radius: 10px; overflow: hidden; }
/* 卡片头：吸顶。清单很长时滚到底部仍要能看出「我在哪一家」。
   背景用不透明层色，否则卡内行会从下面透出来。 */
.dim-jh-gatewayCardHead { position: sticky; top: 0; z-index: 2; display: flex; align-items: flex-start; flex-wrap: wrap; gap: 4px 8px; min-width: 0; padding: 6px 8px; background: var(--dsw-alias-bg-layer-2, #f7f8fa); border-bottom: .5px solid var(--dsw-alias-border-l3, #e5e5e5); }
/* 卡片标题（可点，折叠开关）：占满剩余宽度。
   ⚠️ 用户 2026-10-04 报障「网关里的胶囊内容都没有完整显示」：此处原先是
   ellipsis + nowrap，长供应商名（或展示名）被截成 deepseek-accou…，
   而卡片标题正是用户**唯一**能确认「这一家是谁」的地方。
   改为换行显示：整行放不下时 title 独占一行，计数与「复制本组」按钮落到第二行。
   ⚠️ 绝不能加回 text-overflow: ellipsis / white-space: nowrap。 */
.dim-jh-gatewayCardToggle { flex: 1 1 auto; min-width: 0; padding: 2px 0; border: 0; background: transparent; color: var(--dsw-alias-label-primary, #1f2329); font-size: 12.5px; line-height: 18px; font-weight: 600; text-align: left; overflow-wrap: anywhere; cursor: pointer; }
.dim-jh-gatewayCardToggle:hover { color: var(--dsw-alias-brand-primary, #1677ff); }
/* 计数与按钮：可以掉到第二行，但**不换行、不截断**（flex: none 保证不被挤没）。 */
.dim-jh-gatewayCardCount { flex: 0 0 auto; margin-left: auto; font-size: 11px; line-height: 17px; font-variant-numeric: tabular-nums; white-space: nowrap; color: var(--dsw-alias-label-tertiary, #8f959e); }
.dim-jh-gatewayCardHead .dim-jh-gatewayCardBtn { flex: none; padding: 2px 8px; font-size: 11px; }
/* 卡片标题里的供应商图标（2026-10-26）。
   ⚠️ 基类是 display: grid（block-level）—— 直接塞进这个按钮会在图标前后**各断
   一行**，标题当场变成三行。而按钮本身不是 flex 容器（它是 flex: 1 1 auto 的
   **项**），故这里只能用 inline-grid + vertical-align 把它压回文字流。
   负的 vertical-align 是让 18px 方块的中线对准 12.5px 文字的视觉中线。 */
.dim-jh-gatewayCardToggle > .dim-jh-providerIcon { display: inline-grid; vertical-align: -5px; width: 18px; height: 18px; margin-right: 4px; border-radius: 5px; box-shadow: none; }
.dim-jh-gatewayCardToggle > .dim-jh-providerIcon img { width: 13px; height: 13px; }
.dim-jh-gatewayCardBody { display: grid; grid-template-columns: minmax(0, 1fr); gap: 1px; padding: 3px 4px 5px; }
/* 一行模型（**只读**，无开关）：短名字 + 展示名 + 能力标记。
   ⚠️ 行内显示的是去掉供应商前缀的名字（见 gatewayModelKeyOf）—— 卡片头已经
   写清了是哪一家，再重复一遍前缀只会把整行挤到只剩省略号。
   ⚠️ 这里刻意**不用** .dim-jh-modelRow：那个类带 cursor: pointer 与 hover 底色，
   是给「整行可点切换开关」的 label 用的，用在这里会被读成可点。 */
.dim-jh-gatewayModelRow { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 5px 6px; border-radius: 6px; }
.dim-jh-gatewayModelRow:hover { background: var(--dsw-alias-bg-layer-2, #f4f5f7); }
/* ⚠️ 这里曾有一条「.dim-jh-gatewayModelRow .dim-jh-modelId { max-width: 52% }」
   （把模型列表那 46% 的上限放宽到 52%）。**已删除**，别再写回来：
   它的优先级 (0,2,0) 与下面那条两级通配 (0,2,0) **完全相同**，
   于是谁生效**只取决于源码先后** —— 一个纯粹靠「写在对的位置」维持的假象。
   下面那条把 max-width 直接设成 none（且覆盖了开关行与 curl 代码块），
   一行里本该完整显示的东西，不该还留一个 52% 的上限等着被谁「压过去」。
   ⚠️ 本文件是 JS 模板字符串，注释里**绝不能出现反引号**（我在这条注释上
   第四次踩到同一个坑）—— 类名与代码一律裸写。 */

/* ── 网关弹窗里的「胶囊」一律完整显示（用户报障 2026-10-04）──
   原话：「网关这里面的所有胶囊内容都没有完整显示，应当修正使其完整显示内容」。
   胶囊 = 行内的 <code> ID 块（.dim-jh-modelId）、能力标记（.dim-jh-modelBadge）、
   档位对照行里的模型名（.dim-jh-effortModel）。

   ⚠️ 根因是那三个类**天生带截断**，而且是给**别处**设计的：
   .dim-jh-modelId 是 max-width 46% + ellipsis + nowrap（模型列表要紧凑，
   一行里还得塞下开关）；.dim-jh-modelBadge 是 nowrap；模型名同理。
   而网关弹窗里这些内容**就是要被读/被抄的东西** —— 截断等于让功能失效。

   ⚠️ 只能加 .dim-jh-gatewayModal 前缀：.dim-jh-modelId 在模型列表里
   另有用途（那里的紧凑是刻意的，见 model-filter.js 的模块注释），
   全局去掉 max-width 会把整个模型列表撑坏。

   ⚠️⚠️ **选择器只能写「弹窗 + 类名」两级，绝不能夹中间祖先**（这里返工过一次）：
   第一版写的是「弹窗 + gatewayModelRow + modelId」这类**带中间祖先**的三条规则，
   结果**只覆盖到了卡片内的胶囊**。用户随即又截图框出三处仍在截断的地方，
   它们的祖先链各不相同：
     - 开关行：modalBody > modelRow > modelInfo > code
     - 两处 curl 代码块：modalBody > code
   三条祖先限定规则**一条都匹配不上** ⇒ 用户看到的还是「供 Pi / Cont…」与
   「curl … -H "…"」被吃掉。
   ⚠️ 当时的「机械审计」脚本也没抓到，因为它只检查**类名**有没有被某条网关规则
   覆盖 —— modelId 在卡片那条规则里「有覆盖」，于是整体判通过。
   **教训：判断一个元素会不会被截断，必须看它实际的祖先链，不能看类名是否出现过。**
   现在改成两级通配，弹窗内任何位置的这个类都生效（含 API KEY 明文那块 code）。
   ⚠️ 本文件整体是 JS 模板字符串，注释里**绝不能出现反引号** ——
   我在上面这段注释里用反引号括类名，第三次踩到了同一个坑（构建直接失败）。
   要强调就用「」或 ** 包住类名，永远裸写。 */
.dim-jh-gatewayModal .dim-jh-modelId,
.dim-jh-gatewayModal .dim-jh-modelName {
  max-width: none; overflow: visible; text-overflow: clip; white-space: normal; overflow-wrap: anywhere;
}
/* 能力标记（「可发图片」「需对照」）：短标签，但 flex: none + nowrap 会在
   窄面板下被挤出可视区 —— 允许换行远比被切掉好。 */
.dim-jh-gatewayModal .dim-jh-modelBadge {
  flex: 0 0 auto; white-space: normal; overflow-wrap: anywhere;
}
/* ⚠️ 顶部开关行的标题「启用本机网关」**不许被挤**（去掉 ID 胶囊的 max-width 后
   新引入的问题）：胶囊不再有 46% 上限，于是它把整行宽度吃光，
   而 .dim-jh-modelName 是 flex: 0 1 auto（可收缩）⇒ 标题被压成
   「启用本机网」「关」两行。
   判据：网关弹窗的开关行里，标题保持固有宽度（flex: none），
   让**副标题**去换行 —— 副标题是补充说明，标题是动作主体。
   ⚠️ 本文件是 JS 模板字符串，注释里**绝不能出现反引号**（又踩了一次，第五次）。 */
.dim-jh-gatewayModal .dim-jh-modelInfo > .dim-jh-modelName { flex: none; }
/* 搜索/空结果的容器：与对照表的 .dim-jh-effortEmpty 同款观感。 */
.dim-jh-gatewayEmpty { padding: 8px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8f959e); }

/* ── 「Token 用量」弹窗（渠道 × provider × 模型 三级汇总 + 最近明细）──
   数据来自本机内存账本（usage.tokenLedger），记账点在注册收敛层。
   卡片结构与网关弹窗的供应商卡片同一规格语言（细边框 + 圆角 + 吸顶头），
   但不吸顶：本弹窗层级只有两级，吸顶收益小于复杂度。
   ⚠️ 本文件整体是 JS 模板字符串，注释里绝不能出现反引号 —— 类名一律裸写。 */
.dim-jh-ledgerFilters { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.dim-jh-ledgerFilterBtn { padding: 2px 10px; font-size: 11.5px; line-height: 17px; border-radius: 999px; opacity: .72; }
.dim-jh-ledgerFilterBtn[data-active="true"] { opacity: 1; font-weight: 600; }
.dim-jh-ledgerCard { min-width: 0; border: .5px solid var(--dsw-alias-border-l3, #e5e5e5); border-radius: 10px; overflow: hidden; }
.dim-jh-ledgerCardHead { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 8px; padding: 7px 10px; background: var(--dsw-alias-bg-layer-2, #f7f8fa); border-bottom: .5px solid var(--dsw-alias-border-l3, #e5e5e5); }
.dim-jh-ledgerCardHead strong { font-size: 12.5px; line-height: 18px; color: var(--dsw-alias-label-primary, #1f2329); }
.dim-jh-ledgerCardSum { margin-left: auto; font-size: 11.5px; line-height: 17px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary, #4e5969); white-space: nowrap; }
.dim-jh-ledgerProvider { padding: 4px 10px 6px; }
.dim-jh-ledgerProvider + .dim-jh-ledgerProvider { border-top: .5px solid var(--dsw-alias-border-l3, #eef0f3); }
/* 账号层（第 2 期）：只在多账号（或含「未归属」）时渲染，缩进一层；
   单账号 provider 不展开 —— 一比一的中间层是纯噪音。 */
.dim-jh-ledgerAccount { min-width: 0; }
.dim-jh-ledgerAccount + .dim-jh-ledgerAccount { border-top: .5px dashed var(--dsw-alias-border-l3, #eef0f3); }
.dim-jh-ledgerAccountHead { display: flex; align-items: baseline; gap: 8px; padding: 3px 0 1px 8px; }
.dim-jh-ledgerAccountName { min-width: 0; font-size: 11.5px; line-height: 17px; font-weight: 600; color: var(--dsw-alias-label-secondary, #4e5969); overflow-wrap: anywhere; }
.dim-jh-ledgerAccountSum { margin-left: auto; flex: none; font-size: 11px; line-height: 16px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-tertiary, #8f959e); white-space: nowrap; }
.dim-jh-ledgerProviderHead { display: flex; align-items: baseline; gap: 8px; padding: 4px 0 2px; }
.dim-jh-ledgerProviderName { min-width: 0; font-size: 12px; line-height: 18px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); overflow-wrap: anywhere; }
.dim-jh-ledgerProviderSum { margin-left: auto; flex: none; font-size: 11px; line-height: 16px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-tertiary, #8f959e); white-space: nowrap; }
.dim-jh-ledgerModel { display: flex; align-items: baseline; gap: 8px; min-width: 0; padding: 2px 0 2px 10px; }
.dim-jh-ledgerModelName { flex: 1 1 auto; min-width: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; line-height: 17px; color: var(--dsw-alias-label-secondary, #4e5969); overflow-wrap: anywhere; }
.dim-jh-ledgerModelReq { flex: none; font-size: 11px; line-height: 16px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-tertiary, #8f959e); white-space: nowrap; }
.dim-jh-ledgerModelTokens { flex: none; font-size: 11.5px; line-height: 17px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary, #1f2329); white-space: nowrap; }
/* 均值格（首字 · 速率）：三级汇总行（渠道/账号/模型）共用，等宽数字对齐。 */
.dim-jh-ledgerPerf { flex: none; font-size: 11px; line-height: 16px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-tertiary, #8f959e); white-space: nowrap; }
/* ── 历史视图（第 4 期）：GitHub 风格每日用量格 + 展开的日聚合树 ── */
.dim-jh-ledgerSection { margin-bottom: 14px; }
.dim-jh-ledgerSectionTitle { font-size: 13px; line-height: 19px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); margin-bottom: 6px; }
.dim-jh-ledgerHeatmapWrap { width: 100%; overflow-x: auto; padding: 4px 3px 8px; }
.dim-jh-ledgerHeatmap { display: grid; grid-auto-flow: column; grid-template-rows: repeat(4, 12px); grid-auto-columns: 12px; gap: 4px; width: max-content; }
.dim-jh-ledgerHeatmapCell { appearance: none; box-sizing: border-box; width: 12px; height: 12px; padding: 0; border: 1px solid rgba(34, 211, 238, .16); border-radius: 3px; background: rgba(34, 211, 238, .07); box-shadow: 0 0 2px rgba(34, 211, 238, .08); transition: background .12s ease, box-shadow .12s ease, transform .12s ease; }
.dim-jh-ledgerHeatmap button.dim-jh-ledgerHeatmapCell { cursor: pointer; }
.dim-jh-ledgerHeatmapCell[data-level="1"] { background: rgba(34, 211, 238, .25); box-shadow: 0 0 4px rgba(34, 211, 238, .16); }
.dim-jh-ledgerHeatmapCell[data-level="2"] { background: rgba(34, 211, 238, .46); box-shadow: 0 0 5px rgba(34, 211, 238, .28); }
.dim-jh-ledgerHeatmapCell[data-level="3"] { background: rgba(6, 182, 212, .84); border-color: rgba(103, 232, 249, .75); box-shadow: 0 0 7px rgba(34, 211, 238, .5); }
.dim-jh-ledgerHeatmapCell[data-level="4"] { background: #0e7490; border-color: #67e8f9; box-shadow: 0 0 12px rgba(34, 211, 238, .9), inset 0 0 5px rgba(103, 232, 249, .72); }
.dim-jh-ledgerHeatmap button.dim-jh-ledgerHeatmapCell:hover { transform: scale(1.18); border-color: #a5f3fc; box-shadow: 0 0 10px rgba(34, 211, 238, .8); }
.dim-jh-ledgerHeatmapCell[data-today="true"] { outline: 1px solid #cffafe; outline-offset: 1px; }
.dim-jh-ledgerHeatmapCell[data-active="true"] { outline: 2px solid #67e8f9; outline-offset: 2px; }
.dim-jh-ledgerHeatmap button.dim-jh-ledgerHeatmapCell:focus-visible { outline: 2px solid #cffafe; outline-offset: 2px; }
.dim-jh-ledgerDayPeek { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 14px; min-height: 30px; margin-top: 7px; padding: 5px 9px; border-radius: 7px; background: var(--dsw-alias-bg-layer-2, #f7f8fa); color: var(--dsw-alias-label-secondary, #4e5969); font-size: 11.5px; }
.dim-jh-ledgerDayPeek strong { color: var(--dsw-alias-label-primary, #1f2329); }
.dim-jh-ledgerChartHint { margin-top: 7px; color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 11px; }
.dim-jh-ledgerDeleteQuick { margin-left: auto; }
.dim-jh-ledgerDateRange { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.dim-jh-ledgerDateRange label { display: flex; align-items: center; gap: 5px; color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 11px; }
.dim-jh-ledgerDateRange input { width: 136px; padding: 3px 6px; font-size: 11px; }
.dim-jh-ledgerExport { flex: none; }
/* 明细表：紧凑小字；模型列允许换行（长 wire 名不能截断 —— 网关弹窗同一条教训）。 */
.dim-jh-ledgerEntryTools { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin: 12px 0 5px; }
.dim-jh-ledgerEntryTools strong { margin-right: 2px; font-size: 13px; color: var(--dsw-alias-label-primary, #1f2329); }
.dim-jh-ledgerEntryCount { margin-right: auto; color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 11px; font-variant-numeric: tabular-nums; }
.dim-jh-ledgerSearch { flex: 1 1 130px; width: auto; min-width: 120px; padding: 4px 7px; font-size: 11px; }
.dim-jh-ledgerSelect { min-width: 82px; max-width: 130px; padding: 4px 6px; border: 1px solid var(--dsw-alias-border-l2, #d0d3d9); border-radius: 6px; background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #1f2329); font-size: 11px; }
.dim-jh-ledgerTable { width: 100%; margin-top: 4px; border-collapse: collapse; table-layout: fixed; font-size: 11.5px; line-height: 17px; }
.dim-jh-ledgerTable th { position: sticky; top: 0; z-index: 1; padding: 4px 6px; text-align: left; font-weight: 600; color: var(--dsw-alias-label-tertiary, #8f959e); background: var(--dsw-alias-bg-layer-1, #fff); border-bottom: .5px solid var(--dsw-alias-border-l3, #e5e5e5); }
.dim-jh-ledgerTable td { padding: 3px 6px; border-bottom: .5px solid var(--dsw-alias-border-l3, #f0f1f3); font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary, #4e5969); vertical-align: baseline; }
.dim-jh-ledgerTable .dim-jh-ledgerEntryModel { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--dsw-alias-label-primary, #1f2329); overflow-wrap: anywhere; }
.dim-jh-ledgerTable tbody tr[data-error="true"] td { color: var(--dsw-alias-state-error-primary, #d93025); }
.dim-jh-ledgerTable .dim-jh-ledgerError { cursor: help; font-weight: 600; }
.dim-jh-ledgerTable .dim-jh-ledgerSuccess { color: var(--dsw-alias-state-success-primary, #25803c); }
.dim-jh-ledgerPagination { display: flex; align-items: center; justify-content: flex-end; gap: 7px; padding: 7px 0; color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 11px; }
@media (max-width: 700px) {
  .dim-jh-modal--ledger { padding: 14px 12px; }
  .dim-jh-ledgerPerf { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
  .dim-jh-ledgerEntryTools { align-items: stretch; }
  .dim-jh-ledgerEntryCount { flex: 1 1 50%; }
  .dim-jh-ledgerSearch { flex-basis: 100%; }
  .dim-jh-ledgerSelect { flex: 1 1 30%; max-width: none; }
  .dim-jh-ledgerTable { font-size: 10px; }
  .dim-jh-ledgerTable th, .dim-jh-ledgerTable td { padding: 3px 2px; overflow-wrap: anywhere; }
}

/* ── 模型列表的「计费/来源」分组（订阅 / 免费 / Cline Cloud / 按量计费）──
   分组由 model-groups.js 的纯函数决定（判据见其模块注释）；这里只管观感。
   ⚠️ 组头是**独立的 div**，绝不能包进 .dim-jh-modelRow 的 <label> 里 ——
   label 内点任意位置都会切换可见性开关（见 jet-hub.js 里「刻意不做多选」的说明）。 */
.dim-jh-modelGroup { min-width: 0; }
/* 组头吸顶：按量计费那组展开后有 460+ 行，滚到底部时也要能看到「我在哪一组」。
   背景用不透明层色，否则行会从下面透出来。 */
.dim-jh-modelGroupHead { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 8px; min-width: 0; padding: 6px 8px 5px; background: var(--dsw-alias-bg-layer-1, #fff); border-bottom: 0.5px solid var(--dsw-alias-border-l3, #e5e5e5); }
.dim-jh-modelGroupToggle { flex: 1 1 auto; min-width: 0; padding: 2px 0; border: 0; background: transparent; color: var(--dsw-alias-label-primary, #1f2329); font-size: 12.5px; font-weight: 600; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.dim-jh-modelGroupToggle:hover { color: var(--dsw-alias-brand-primary, #1677ff); }
.dim-jh-modelGroupCount { flex: none; font-size: 11px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-tertiary, #8f959e); }
/* 组头的两个按钮做紧凑处理：组头一行里要放下折叠标题 + 计数 + 两个按钮。 */
.dim-jh-modelGroupHead .dim-jh-modelGroupBtn { flex: none; padding: 2px 8px; font-size: 11px; }
.dim-jh-modelGroupBody { display: grid; grid-template-columns: minmax(0, 1fr); gap: 2px; padding: 2px 0 6px; }

/* 开关：基于 checkbox 绘制，保持原生语义（可聚焦、可键盘操作、可读屏） */
.dim-jh-switch { flex: none; appearance: none; -webkit-appearance: none; position: relative; width: 34px; height: 20px; margin: 0; border-radius: 999px; background: var(--dsw-alias-border-l2, #d0d3d9); cursor: pointer; transition: background .18s ease; }
.dim-jh-switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgb(31 35 41 / 20%); transition: transform .18s ease; }
.dim-jh-switch:checked { background: #1677ff; }
.dim-jh-switch:checked::after { transform: translateX(14px); }
.dim-jh-switch:focus-visible { outline: none; box-shadow: 0 0 0 2px color-mix(in srgb, #1677ff 30%, transparent); }
.dim-jh-switch:disabled { opacity: 0.5; cursor: default; }

/* 「渠道原生搜索」开关（页头，取代原「关闭」按钮）。
   white-space: nowrap 是必需的：页头按钮行不换行，而 label 内的文字
   默认会在窄面板下折成两行，把整行高度撑开（与页头按钮同款约束）。
   字号与 .dim-jh-btn 对齐，视觉上仍是「一排控件」的一部分。 */
.dim-jh-nativeSearch { flex: none; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; font-size: 13px; color: var(--dsw-alias-label-p, inherit); cursor: pointer; user-select: none; }

/* ── 账号备份（导出 / 恢复）── */
/* 口令输入框：宽度撑满弹窗内容区，避免在窄面板下挤坏布局。
   ⚠️ 背景必须用**真实存在**的 token。早期写的是 --dsw-alias-bg-input，而主题里
   根本没有这个 token（真实的是 bg-base / bg-layer-1/2/3）—— var() 遇不存在的
   token **不报错**，静默取 fallback #fff，于是深色模式下变成「浅色文字 + 白底」，
   文字完全看不见（用户报障）。这里对齐官方 Input 原语用的 bg-layer-1，
   并去掉 fallback 以免再次掩盖 token 拼错。 */
.dim-jh-input { box-sizing: border-box; width: 100%; padding: 6px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-layer-1); font-size: 13px; color: var(--dsw-alias-label-primary); }
.dim-jh-input:focus { outline: none; border-color: #1677ff; box-shadow: 0 0 0 2px color-mix(in srgb, #1677ff 20%, transparent); }
/* placeholder 用官方 Input 的 dimmed 色：默认色在深色模式下对比度不足。 */
.dim-jh-input::placeholder { color: var(--dsw-alias-label-dimmed); }
/* 加密勾选行：勾选框 + 文案一行排开 */
.dim-jh-checkRow { display: flex; align-items: center; gap: 8px; margin: 10px 0 4px; font-size: 13px; color: var(--dsw-alias-label-primary, #1f2329); cursor: pointer; }
.dim-jh-checkRow input[type="checkbox"] { margin: 0; accent-color: #1677ff; }
/* 两次口令输入：纵向堆叠 */
.dim-jh-formRows { display: flex; flex-direction: column; gap: 8px; margin: 8px 0 4px; }
/* ── 账号勾选（导出选账号 / 导入选账号）── */
/* 「全部」那行与逐条列表同宽，列表可滚动：账号多时不把弹窗撑爆 */
.dim-jh-accountPick { display: flex; flex-direction: column; margin: 6px 0 2px; }
.dim-jh-accountPickList { display: flex; flex-direction: column; max-height: 200px; overflow-y: auto; padding-right: 4px; }
/* 逐条行：缩进一级，视觉上从属于上面的「全部账号」 */
.dim-jh-accountPickRow { margin: 2px 0; padding-left: 14px; font-weight: 400; }
.dim-jh-accountPickName { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
/* 昵称过长时省略，而不是把 provider 标记挤出可视区 */
.dim-jh-accountPickName > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dim-jh-accountPickMeta { flex: none; font-size: 11px; color: var(--dsw-alias-label-tertiary, #8f959e); }
/* ── 导入方式单选（整体还原 / 单独导入）── */
.dim-jh-modePick { display: flex; flex-direction: column; margin: 4px 0 8px; }
.dim-jh-modePick input[type="radio"] { margin: 0; accent-color: #1677ff; }
/* 弹窗底部动作区：右对齐（生成/确认按钮） */
.dim-jh-modalActions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }


/* ── Cline「订阅额度」弹窗（官方额度窗口 + 请求记录）── */
/* 账号翻页器:⚠️ **一次只看一个账号**(参考实现同款,多账号全铺开会让
   额度卡与记录表都极长);额度窗口与请求记录**共享同一个索引**。
   ⚠️ 单账号时整行都不渲染(见 renderQuota)——箭头无处可去。 */
.dim-jh-quotaGroup { display: flex; flex-direction: column; gap: 12px; }
.dim-jh-quotaPager { display: flex; align-items: center; gap: 8px; }
/* 24×24 方形按钮(参考实现 .cp-usage-nav):箭头是导航控件,不是文字按钮。 */
.dim-jh-quotaArrow { box-sizing: border-box; width: 24px; height: 24px; flex: none; padding: 0; border: 0.5px solid var(--dsw-alias-border-l2, #d0d3d9); border-radius: 6px; background: transparent; color: var(--dsw-alias-label-primary, #1f2329); font-size: 13px; line-height: 1; cursor: pointer; }
.dim-jh-quotaArrow:hover { border-color: var(--dsw-alias-brand-primary, #1677ff); }
.dim-jh-quotaAccountName { display: flex; align-items: center; gap: 8px; flex: 1 1 auto; min-width: 0; }
.dim-jh-quotaAccountLabel { overflow: hidden; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); text-overflow: ellipsis; white-space: nowrap; }
.dim-jh-quotaIndex { flex: none; font-size: 12px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-tertiary, #8f959e); }
/* 读数区:**多窗口并排卡片**(grid,参考实现同款)。
   ⚠️ auto-fit + 最小 170px:窄面板自动换列,不会把卡片压成一条。 */
.dim-jh-quotaWindows { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; }
.dim-jh-quotaWindow { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border: 0.5px solid var(--dsw-alias-border-l2, #d0d3d9); border-radius: 8px; }
.dim-jh-quotaWindowHead { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.dim-jh-quotaWindowName { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary, #555); }
/* 百分比是这张卡唯一要读的数 —— 18px 大字(参考实现同款) */
.dim-jh-quotaWindowPercent { font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary, #1f2329); }
.dim-jh-quotaWindowPercent[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary, #d9822b); }
.dim-jh-quotaWindowPercent[data-tone="error"] { color: var(--dsw-alias-state-error-primary, #d93025); }
/* 进度条:宽度用的就是**夹取后**的百分比(与文案同一个值)。
   ⚠️ 正常档是**绿色**(参考实现 usageColor):全染品牌蓝会让「用掉九成」
   与「用掉一成」看起来一样,额度条就失去警示作用。 */
.dim-jh-quotaBar { height: 6px; overflow: hidden; border-radius: 999px; background: var(--dsw-alias-border-l2, #d0d3d9); }
.dim-jh-quotaBarFill { height: 100%; border-radius: 999px; background: var(--dsw-alias-state-success-primary, #2ea043); transition: width .3s; }
.dim-jh-quotaBarFill[data-tone="warn"] { background: var(--dsw-alias-state-warn-primary, #d9822b); }
.dim-jh-quotaBarFill[data-tone="error"] { background: var(--dsw-alias-state-error-primary, #d93025); }
.dim-jh-quotaReset { font-size: 12px; color: var(--dsw-alias-label-tertiary, #8f959e); }
/* 不可用 / 无窗口的静默文案(参考实现 .cp-muted) */
.dim-jh-quotaMuted { font-size: 12px; line-height: 17px; color: var(--dsw-alias-label-tertiary, #8f959e); word-break: break-word; }

/* 请求记录区:与额度区用上边框分开 */
.dim-jh-quotaLog { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--dsw-alias-border-default, #e5e5e5); }
.dim-jh-quotaSectionTitle { margin: 0 0 4px; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); }
/* 说明「记录是本地流水」的提示:让用户知道重启会清空,而不是丢数据。 */
.dim-jh-quotaLogHint { margin: 0 0 8px; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary, #8f959e); }
/* 表格容器:⚠️ 自带纵向滚动 + 表头 sticky(参考实现 .cp-history 的 280px):
   长列表在弹窗内滚,表头始终可见。 */
.dim-jh-quotaTableWrap { max-height: 280px; overflow: auto; padding: 0 4px 2px; }
.dim-jh-quotaTable { width: 100%; border-collapse: collapse; table-layout: auto; font-size: 12px; }
/* ⚠️ td 默认 overflow:hidden:TOKEN / 延迟 / 错误列必须各自改成 normal+visible,
   否则它们继承的截断会把内容吃掉(参考实现踩过同一个坑)。 */
.dim-jh-quotaTable th, .dim-jh-quotaTable td { padding: 6px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l2, #eee); font-size: 12px; vertical-align: middle; text-align: center; overflow: hidden; }
.dim-jh-quotaTable th { position: sticky; top: 0; z-index: 1; background: var(--dsw-alias-bg-layer-1, #fff); font-weight: 400; font-size: 11px; color: var(--dsw-alias-label-tertiary, #8f959e); white-space: nowrap; }
.dim-jh-quotaTable tbody tr:hover td { background: var(--dsw-alias-bg-layer-2, #f4f5f7); }
/* 列宽:状态点 16px、时间 82px(参考实现实测值,防时间戳被截断)。
   ⚠️ 用复合选择器:单独一个类的优先级压不过 .dim-jh-quotaTable td 的 (0,1,1)。 */
.dim-jh-quotaTable .dim-jh-quotaDotCol { width: 16px; }
.dim-jh-quotaTable .dim-jh-quotaWhenCol, .dim-jh-quotaTable .dim-jh-quotaWhen { width: 82px; }
.dim-jh-quotaTable td.dim-jh-quotaWhen { color: var(--dsw-alias-label-tertiary, #8f959e); font-variant-numeric: tabular-nums; }
/* 状态点:绿=成功、红=失败(参考实现同款;错误消息在 title 里)。 */
.dim-jh-quotaDot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-state-success-primary, #2ea043); }
.dim-jh-quotaDot[data-tone="error"] { background: var(--dsw-alias-state-error-primary, #d93025); }
/* 模型列:等宽字 + 省略号(模型 id 是最该被扫到的标识);上游做成 tag。 */
.dim-jh-quotaModel { display: block; max-width: 100%; overflow: hidden; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--dsw-alias-label-primary, #1f2329); text-overflow: ellipsis; white-space: nowrap; }
.dim-jh-quotaMeta { display: flex; align-items: center; justify-content: center; gap: 6px; min-width: 0; overflow: hidden; margin-top: 2px; }
.dim-jh-quotaTag { padding: 1px 6px; border-radius: 5px; background: var(--dsw-alias-bg-layer-2, #f4f5f7); font-size: 11px; color: var(--dsw-alias-label-tertiary, #8f959e); white-space: nowrap; }
/* TOKEN 列:⚠️ 必须**允许折行**(参考实现同款)—— nowrap 会让
   「↓12.3k ↑4.5k ⚡1.2k 🧠89」把表格撑出横向滚动。 */
.dim-jh-quotaTable td.dim-jh-quotaTokens { font-size: 11.5px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary, #555); white-space: normal; overflow: visible; }
/* 延迟列:三行(首字 / 总耗时 / 输出速率),标签左、数值右(参考实现同款)。 */
.dim-jh-quotaTable td.dim-jh-quotaLoad { font-variant-numeric: tabular-nums; white-space: normal; overflow: visible; }
.dim-jh-quotaLoadRow { display: flex; justify-content: space-between; gap: 5px; max-width: 112px; margin: 0 auto; font-size: 11.5px; line-height: 1.5; }
.dim-jh-quotaLoadRow > span { white-space: nowrap; }
.dim-jh-quotaLoadRow > span:first-child { flex: none; }
.dim-jh-quotaLoadRow > span:last-child { min-width: 0; overflow: hidden; text-align: right; text-overflow: ellipsis; }
.dim-jh-quotaLoadKey { color: var(--dsw-alias-label-tertiary, #8f959e); }
/* 失败行:错误消息随行横跨数据列。⚠️ 必须允许折行 —— 错误文案(429 / 11140)
   很长,继承 td 的 nowrap + hidden 会把表格撑出横向滚动(参考实现的原坑)。 */
.dim-jh-quotaTable tr[data-error="true"] td { color: var(--dsw-alias-state-error-primary, #d93025); }
.dim-jh-quotaTable td.dim-jh-quotaError { font-size: 11.5px; line-height: 1.5; white-space: normal; overflow: visible; text-overflow: clip; word-break: break-word; }

/*
 * ── ZCode 登录渠道弹窗（Jet Hub 设置页；dim-jh-zcDialog / dim-jh-zcSelect） ──
 *
 * 这套样式**只服务 Jet Hub 设置页**的「添加账号 → 登录渠道」弹窗
 * （BigModel 国内 / z.ai 国际，见 jet-hub.js 的 zcodeProvider 下拉）。
 *
 * ⚠⚠️ 随 Gitee issue IKJLHQ 一并移除的还有一整套「官方「模型卡片 → 编辑」内的
 * ZCode 账号区」样式（.dim-jh-zcSection / zcSummary / zcAccount / zcMeta / zcBtn
 * / zcEmpty / zcNotice / zcLink，以及 [data-jet-hub-hidden]）。那套 UI 靠占用
 * settings.models.provider-card 槽的 llm-pi-ai key 实现，而该 key 与第三方
 * pi-ai 扩展**物理互斥**（机制见 index.js 文件头的长注释）—— ZCode 账号管理
 * 现在只在 Jet Hub 页。**别把那套样式加回来。**
 *
 * 颜色一律走 --dsw-alias-* 令牌；变量取不到时用 CSS 系统色（Canvas / CanvasText）
 * 兜底，跟随系统深浅色。
 * ⚠ 本文件整体是 JS 模板字符串，注释里**不能出现反引号**（会提前终止字符串）。
 */
/* 登录渠道选择（BigModel 国内 / z.ai 国际） */
.dim-jh-zcProvider { display: inline-flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-secondary, GrayText); font-size: 12px; line-height: 18px; }
/* ⚠ background/color 的变量**必须带 fallback**（真实报障 2026-10-03：下拉里两项
   全是白的，只有 hover 才看见内容）。
   两个原因叠加：
   ① 原写法 background 设为全透明（0 0）+ color 用了无 fallback 的变量
      —— 变量在弹窗 scope 里取不到时 color 整条失效，退回继承。
   ② ⚠ Windows/Electron 下 **option 的背景不继承 select 的 background**，
      由系统主题决定；文字却**继承** color。
   ⇒ 浅色系统上就是「白底 + 失效/白字」⇒ 看不见。
   修法：① 变量都带 fallback，且 fallback 用 **CSS 系统色**（Canvas/CanvasText），
   它跟随系统深浅色；② 给 option 单独声明背景与文字色。
   ⚠⚠ 本注释里**绝不能出现反引号**（STYLES 是模板字符串，见 AGENTS.md）。 */
.dim-jh-zcSelect { box-sizing: border-box; height: 28px; padding: 0 8px; border: .5px solid var(--dsw-alias-border-l3, #dee0e3); border-radius: 14px; background: var(--dsw-alias-bg-layer-3, Canvas); color: var(--dsw-alias-label-primary, CanvasText); font-size: 12px; line-height: 18px; cursor: pointer; }
/* ⚠ 必须单独声明：option 的背景不继承 select（见上）。缺这条就是「下拉项全白」。 */
.dim-jh-zcSelect option { color: var(--dsw-alias-label-primary, CanvasText); background-color: var(--dsw-alias-bg-layer-3, Canvas); }
.dim-jh-zcSelect:disabled { opacity: .4; cursor: default; }
.dim-jh-zcSelect:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-alias-border-l3, #dee0e3); }
.dim-jh-zcDialogMask { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, .45); }
.dim-jh-zcDialog { box-sizing: border-box; width: min(420px, calc(100vw - 32px)); padding: 18px 20px; border-radius: 10px; background: var(--dsw-alias-bg-layer-3, Canvas); box-shadow: 0 8px 32px rgba(0, 0, 0, .28); }
/* ⚠ 背景**必须**用 bg-layer-3（真实报障 2026-10-03：深色主题下弹窗是白的）。
   原先写的是 --dsw-alias-surface —— 那是**猜的变量名，DSH 里并不存在**，
   于是 fallback 里的浅色生效 ⇒ 深色主题下白底 + 浅色字，几乎看不见。
   本文件通篇用 bg-layer-1/2/3；fallback 用 CSS 系统色 Canvas（跟随系统深浅），
   这样变量取不到时也不会退回浅色。 */
.dim-jh-zcDialogTitle { margin: 0 0 6px; font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary, CanvasText); }
.dim-jh-zcDialogHint { margin: 0 0 12px; font-size: 12px; line-height: 17px; color: var(--dsw-alias-label-tertiary, GrayText); }
.dim-jh-zcDialog .dim-jh-zcProvider { display: flex; align-items: center; gap: 8px; margin: 0 0 16px; font-size: 13px; }
.dim-jh-zcDialogActions { display: flex; justify-content: flex-end; gap: 8px; }

/* ── 用量徽标（会话输入区，模型选择器旁） ────────────────────────────────
   折叠态是一枚紧凑按钮，浮层用 position:absolute + bottom:calc(100% + 8px)
   向上展开（贴着输入区上沿，不遮挡输入框）。
   ⚠ 输入区（RlGAzG_root / dock / trailing / standardControls）没有
   overflow:hidden（只有文本域 .RlGAzG_scroll 是 overflow-y:auto），故浮层
   不会被裁剪 —— 若将来上游给这些容器加上裁剪，这里要改成固定定位 + 锚点换算。

   浮层尺寸口径（用户 2026-10-02：「小巧、美观，但信息不能缺失」→「不够小巧和精致」
   →「额度那块文字居中 + 浅色模式下按钮和线条太不明显」三轮迭代后定稿）：
   - 宽 **280px**、正文字号 10–11px、节间距 7px、进度条 3px；
   - **每个订阅窗口只占一行**：名称 / 进度条 / 百分比 / 重置倒计时；
   - 订阅额度那块用 grid **整块水平居中**（justify-content: center），列仍对齐；
   - 按钮与分隔线一律用**主题描边**（--dsw-alias-border-l2，全不透明）——
     试过「去线条」，浅色模式下按钮和分区线会看不见，用户明确反馈后撤回；
   - 阴影双层（近处极淡 + 远处扩散），比单层大阴影更精致。
   信息项一项未减（渠道名、更新时间与缓存标记、偏好三态、窗口百分比与倒计时、
   套餐名称与到期与账号数、逐账号余额与分桶、停用/失败计数、两个签到按钮）。 */
/* ⚠️ 徽标宽度会**挤压右侧的模型选择器**（真机报障 2026-10-02）。
 *
 * ## 症状
 *
 * 徽标与模型选择器同在 composer 一行（徽标 order:100 在模型选择器左侧），
 * 而本元素是 flex: none —— 不参与收缩。原先 max-width: 280px 会把
 * 「图标 + 模型名 + ▾」的模型选择器压到只剩几十 px，**图标被挤没**，
 * 用户看到「只有放大到很大才能看到那个图标」。
 *
 * ## 为什么会暴露
 *
 * 早期徽标永不显示（store.current 恒为 null 的缺陷期），模型选择器独占
 * 整行所以一直正常；徽标修好后开始占位，才暴露出这个抢占。
 *
 * ## 两级收敛（用户定：1+2）
 *
 * ## 宽度：**内容自适应**，216px 只是上限（不是目标宽度）
 *
 * 胶囊本身是**内容自适应**的：宽度由实际文字撑开，短内容就短
 * （Cline • 5积分 仅 93px），不会有固定留白。下面的 max-width 只在
 * 内容**过长**时兜底，防止挤压右侧的模型选择器。
 *
 * ⚠️ 2026-10-03 上限从 150px 提到 **216px**（用户报障「供应商名字显示不完整」
 * 之后又提了一次）。两次报障、同一条链路的两个不同成因：
 * 1. **数字被截**（第一次）：整句塞进一个 overflow:hidden 的 span，省略号从右往左
 *    吃掉了余额。修法是**结构**（拆成可独立收缩的 span，见 badge-model.js 的
 *    readingOf 与 usage-badge.js 的三段式渲染）；
 * 2. **渠道名被截**（第二次）：结构修好后，186px 仍不够长渠道名 + 长余额，
 *    于是省略号落到**名字**上（用户截图：CodeArts (华为…）。216px 解决它。
 *
 * **216 是量出来的，不是拍的**：实测 13 个渠道展示名 × 10 种现实读数
 * （含 123456.78积分 / 9499.84积分 / 94.54MToken / 0积分）共 130 组，
 * 需要的最宽度是 **209.34px**（WorkBuddy (国际版) • 123456.78积分），
 * 216px 全部装得下且留 6.7px 余量（字体回退时字宽会变）。
 *
 * ⚠️ **上限不能再往上放**：实测把上限放到「无上限」时，极窄 composer（220px）
 * 下胶囊会**溢出容器 8.3px** —— 那正是 2026-10-02「模型选择器图标被挤没」
 * 的形态。内容自适应 + 合理上限，两者缺一不可。
 * 兜底退化顺序：超长时**渠道名**先出省略号，**余额一个字都不会少**
 * （.dim-jh-badgeReading 是 flex: none）。
 *
 * ⚠️ button 元素**本来就是 border-box**（UA 默认样式表），故下面的 box-sizing
 * 是**显式写出**（防止哪天元素换成 span/div 时语义悄悄变成内容盒），不是修复。
 * ⚠️⚠️ 本段注释里**不能出现反引号**（本文件整体是 JS 模板字符串，会提前终止）。
 * ② 容器再窄时（< 720px，媒体查询挂在**全局宽度**上：composer 宽度受
 *    侧栏影响，用容器查询无法表达「右侧还剩多少」）**只留状态点**，
 *    文字与 chevron 全部隐藏 —— 此时代理器优先级让给模型选择器。 */
/* ⚠️ flex: 0 1 auto（而非 none）：胶囊自身也要能收缩。它是 flex: none 时
   宽度只由 max-width 兜底，而 max-width 只在**内容超标**时生效 —— 容器更窄时
   它会连同右侧模型选择器一起溢出。允许收缩后，空间不足时胶囊与选择器一起让位，
   且胶囊内部退化是有序的（先名字出省略号，数字最后才动）。 */
.dim-jh-badge { position: relative; display: flex; align-items: center; flex: 0 1 auto; min-width: 0; }
/* ⚠️ box-sizing 是**显式写出**的，不是修复：button 的 UA 默认样式表本就是
   border-box（实测 offsetWidth 与 max-width 相等）。写上它只为在元素类型被改
   （span/div 默认是 content-box）时语义不悄悄漂移 —— 那种情况下 max-width 会从
   「占位宽度」变成「内容宽度」，胶囊会突然变宽 19px 而这行代码看着毫无变化。 */
.dim-jh-badgeBtn { box-sizing: border-box; display: flex; align-items: center; gap: 5px; max-width: 216px; min-width: 0; padding: 2px 9px; border: .5px solid var(--dsw-alias-border-l2); border-radius: 999px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11px; line-height: 1.5; cursor: pointer; white-space: nowrap; font-variant-numeric: tabular-nums; transition: background .15s ease, color .15s ease, border-color .15s ease; }
.dim-jh-badgeBtn:hover { background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); }
.dim-jh-badgeBtn[aria-expanded="true"] { background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); border-color: color-mix(in srgb, #1677ff 45%, var(--dsw-alias-border-l2)); }
/* 聚合「待首次请求」占位胶囊（用户报障 2026-10-08：「也没胶囊了？」）。
   ⚠️ 刻意与 .dim-jh-badgeBtn **外观一致但不共用类名**：那个类名带 cursor:pointer
   与 :hover 反馈，而这里没有任何可点的东西（无历史 ⇒ 没有余额可展开）。
   给一个点了没反应的按钮比没有按钮更糟。
   ⚠️ 宽度口径与 .dim-jh-badgeBtn 同步（gap 5px / padding 2px 9px / 字号 11px）：
   两者会在同一位置交替出现（首次请求成功后换成真胶囊），尺寸不一致会看到跳动。 */
.dim-jh-badgePending { display: inline-flex; align-items: center; gap: 5px; max-width: 216px; min-width: 0; padding: 2px 9px; border: .5px solid var(--dsw-alias-border-l2); border-radius: 999px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 1.5; white-space: nowrap; }
.dim-jh-badgePending > span:last-child { overflow: hidden; text-overflow: ellipsis; }
/* 三段式文本容器：渠道名 + 分隔符 + 读数。
   ⚠️ 必须是 flex 容器，两个文本子项才能各自独立收缩（这正是「数字不被截」的前提）。 */
.dim-jh-badgeText { display: flex; align-items: center; min-width: 0; }
/* ⚠️ 让位顺序：中段说明(999) → 渠道名(99) → 读数(none，**不参与收缩**)。
   收缩量按 flex-shrink × flex-basis 加权分配，999 与 99 相差一个数量级，
   故「包名先走、渠道名其次」，读数一个字都不会少。
   flex-grow 一律为 0：胶囊是内容自适应宽度，任何 grow 都只会让它在宽容器里虚胖。
   min-width:0 是省略号生效的前提（flex 子项默认 min-width:auto，会撑破 max-width）。 */
.dim-jh-badgeName { flex: 0 99 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 分隔符「•」：定宽不收缩，两侧间距由 margin 给。
   ⚠️ 这里的 3px **不能**换成前后空格：flex 容器把 span 之间只含空白的文本节点
   渲染成**零宽**（实测 gap=0，节点还在但看不见），空格会静默消失。
   带空格的那份写法（BADGE_SEP = ' • '）只用于 title / aria-label 那句整文。 */
.dim-jh-badgeSep { flex: none; margin: 0 3px; }
/* 中段说明（只有套餐模式有值，如包名 Free Plan Subscription）。
   ⚠️ 收缩权重**最大**（999）：它比渠道名更该让位 —— 包名多为样板字、且长，
   而用户认得出自己选的渠道。
   ⚠️ 它被压到 0 宽时（内容过长）该节点仍在，会留下一个「悬空的分隔符」；
   这在胶囊这一行是可接受的（完整文案在 title 与弹窗里），故不额外做条件渲染。 */
.dim-jh-badgeDetail { flex: 0 999 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* ⚠️⚠️ 读数必须 flex: none（**完全不收缩**），不能写 flex: 0 1 auto。
   这是第二处、也是更隐蔽的一处「数字被截」成因，**靠截图才发现**：

   收缩量按 flex-shrink × flex-basis 加权分配，读数那一份虽小却**不为零** ——
   实测读数被分到 0.77px 的收缩（getBoundingClientRect 宽 78.23 / 内容宽 79）。
   而 text-overflow: ellipsis 的触发条件是 scrollWidth > clientWidth，
   **亚像素级的收缩就足以命中** ⇒ 最后一个字被换成「…」，
   视觉上和「整段被截」一样严重。

   ⚠️ 更坑的是**量不出来**：clientWidth 取整，53.97 报成 54，
   于是 scrollWidth > clientWidth 判为 false —— 我用它写的「数字是否完整」
   断言一路全绿，而截图里明明白白写着「347.87积…」。
   教训：判断省略号要看**截图**或用小数宽度（getBoundingClientRect），
   不能用取整后的 clientWidth。

   ⚠️ 类名刻意**不叫 .dim-jh-badgeValue**：那个名字已被弹窗读数占用，且那条规则
   （font-weight:600）排在样式表更后面 —— 同名会让胶囊数字被静默加粗。

   ⇒ 读数恒定完整；全部收缩由 .dim-jh-badgeDetail(999) 与 .dim-jh-badgeName(99)
   承担，两者最坏缩到 0 也放得下（读数最宽约 97px + 分隔符与内边距 ≈ 131px
   < 186px 上限）。 */
.dim-jh-badgeReading { flex: none; min-width: 0; white-space: nowrap; }
/* 「这个读数不完整」的标记（合计少算了账号时才出现），排在读数**之后**。
   ⚠️ 必须与读数同级 flex: none：它是**补语**，被省略号吃掉就等于没标 —— 而它要
   提醒的恰恰是「别把这个数字当真」，看不见比不标更糟。
   ⚠️ 用 warn 而不是 error：账号读不到多半是临时的（凭据过期 / 网络抖动），
   error 是留给「整个渠道都不可用」的（那会走 empty 模式）。
   字号小一档并压紧行高，让它读起来像角标而不是读数的一部分。 */
.dim-jh-badgeWarn { flex: none; font-size: 10px; line-height: 1; color: var(--dsw-alias-state-warn-primary); cursor: help; }

/* ② 窄屏收敛：只留状态点，文字与 chevron 让位给模型选择器。
 * 阈值 720px 是实测桌面版在 100% 缩放下「徽标 216px + 模型选择器 ≥ 240px」的临界值。
 * ⚠️⚠️ 本段的**位置**是功能性的，不要为了排版把它挪到 .dim-jh-badgeText 之前：
 * 它与 ".dim-jh-badgeText { display: flex }" 特异性相同（都是单个类），
 * 靠**源顺序**决定胜负 —— 一旦被排到前面，窄屏下 display:none 会被
 * 后面的 display:flex 覆盖，文字重新出现并挤压模型选择器（静默回归）。 */
@media (max-width: 720px) { .dim-jh-badgeText, .dim-jh-badgeBtn > svg, .dim-jh-badgeBtn > .dim-jh-badgeChevron { display: none; } .dim-jh-badgeBtn { max-width: none; padding: 2px 6px; } }
.dim-jh-badgeDot { width: 5px; height: 5px; flex: none; border-radius: 999px; background: var(--dsw-alias-state-success-primary); }
.dim-jh-badgeDot[data-tone="warn"] { background: var(--dsw-alias-state-warn-primary); }
.dim-jh-badgeDot[data-tone="error"] { background: var(--dsw-alias-state-error-primary); }
.dim-jh-badgeDot[data-tone="muted"] { background: var(--dsw-alias-label-tertiary); }
.dim-jh-badgePop { position: absolute; bottom: calc(100% + 8px); right: 0; z-index: 40; width: 280px; max-width: min(280px, 86vw); max-height: 58vh; overflow-y: auto; display: flex; flex-direction: column; padding: 9px 10px 10px; border: .5px solid var(--dsw-alias-border-l2); border-radius: 11px; background: var(--dsw-alias-bg-layer-1); box-shadow: 0 1px 2px rgba(0, 0, 0, .06), 0 8px 24px rgba(0, 0, 0, .14); text-align: left; white-space: normal; }
/* 窄屏时徽标只留状态点，弹窗也随之收窄（否则它会盖住模型选择器）。
 * 宽度写 min() 而非媒体查询覆盖：弹窗是 absolute，媒体查询命中时按钮虽已
 * 收窄，但弹窗仍按 280px 渲染会显得与触发点不匹配。 */
@media (max-width: 720px) { .dim-jh-badgePop { width: 220px; max-width: min(220px, 76vw); } }
.dim-jh-badgeHead { display: flex; align-items: center; gap: 5px; padding-bottom: 7px; }
.dim-jh-badgeTitle { flex: none; max-width: 118px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dim-jh-badgeAt { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
/* 刷新：默认**无边框无底色**（降低视觉重量），hover 才浮起；文字说明放 title/aria-label
   ⚠️ 2026-10-02 用户反馈「浅色模式下按钮和线条不太明显」：这里从「完全透明」
   改回**主题描边 + layer-2 底**（浅色下 layer-2 与弹窗底色太接近，靠描边才立得住）。 */
.dim-jh-badgeRefresh { flex: none; width: 20px; height: 20px; display: grid; place-items: center; border: .5px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; line-height: 1; cursor: pointer; transition: color .15s ease, background .15s ease, border-color .15s ease; }
.dim-jh-badgeRefresh:hover:not(:disabled) { border-color: color-mix(in srgb, #1677ff 45%, var(--dsw-alias-border-l2)); background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-brand-primary); }
.dim-jh-badgeRefresh:disabled { opacity: .5; cursor: default; }
/* 自动签到状态灯：与刷新键**同尺寸同描边**（浅色下靠描边才立得住），紧挨它左侧。
   ⚠️ 状态**不只用颜色**表达：灯本身有形态差异（关=空心环 / 开=实心点 /
   今天已跑=实心点带外环 / 进行中=省略号），且 title 与 aria-label 都带完整文字说明，
   故色觉障碍与读屏都能分辨「开还是关、今天跑没跑」。 */
.dim-jh-badgeAuto { flex: none; width: 20px; height: 20px; display: grid; place-items: center; border: .5px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-tertiary); font: inherit; font-size: 12px; line-height: 1; cursor: pointer; transition: color .15s ease, background .15s ease, border-color .15s ease; }
.dim-jh-badgeAuto:hover { border-color: color-mix(in srgb, #1677ff 45%, var(--dsw-alias-border-l2)); background: var(--dsw-alias-bg-layer-3); }
.dim-jh-badgeAutoDot { width: 7px; height: 7px; box-sizing: border-box; border-radius: 999px; background: transparent; border: 1.5px solid currentColor; }
.dim-jh-badgeAuto[data-state="on"],
.dim-jh-badgeAuto[data-state="done"] { color: var(--dsw-alias-state-success-primary); }
.dim-jh-badgeAuto[data-state="on"] .dim-jh-badgeAutoDot,
.dim-jh-badgeAuto[data-state="done"] .dim-jh-badgeAutoDot { background: currentColor; border: 0; }
.dim-jh-badgeAuto[data-state="done"] .dim-jh-badgeAutoDot { box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-success-primary) 28%, transparent); }
.dim-jh-badgeAuto[data-running="true"] { color: var(--dsw-alias-brand-primary); }
/* ⚠️ 这里曾有一枚「自动签到 已关闭 / 今天已完成」的小胶囊（右对齐在签到按钮上方）。
   用户 2026-10-02 反馈「新加的这个感觉有点不是太好看」，改为在「全部渠道签到」
   按钮文案后加「（自动）」后缀（只在开关打开时加）⇒ 相关样式整段删除。
   状态本身的说明仍由右上角状态灯的 title 承载。 */
/* **常驻**的自动签到状态文字（用户 2026-10-02：自动签到下也要显示各渠道状态，
   但**不要自动消失**，改为手动关闭 ⇒ 小按钮在文字**上方**）。
   ⚠️ 与 .dim-jh-badgeNotice（手动签到结果，8s/20s 自动消失）是两种语义，
   样式刻意区分：这里用中性底 + 细描边（「状态」），那里用带色调的提示块（「回执」）。 */
.dim-jh-badgeAutoStatus { margin-top: 5px; padding: 5px 6px 6px; border: .5px solid var(--dsw-alias-border-l2); border-radius: 7px; background: var(--dsw-alias-bg-layer-2); }
.dim-jh-badgeAutoCloseRow { display: flex; justify-content: flex-end; margin-bottom: 2px; }
.dim-jh-badgeAutoClose { width: 14px; height: 14px; display: grid; place-items: center; border: .5px solid var(--dsw-alias-border-l2); border-radius: 4px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-tertiary); font: inherit; font-size: 10px; line-height: 1; cursor: pointer; transition: color .15s ease, background .15s ease, border-color .15s ease; }
.dim-jh-badgeAutoClose:hover { border-color: color-mix(in srgb, #1677ff 45%, var(--dsw-alias-border-l2)); background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-brand-primary); }
.dim-jh-badgeAutoStatusHead { font-size: 10.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.dim-jh-badgeAutoChannels { display: flex; flex-wrap: wrap; gap: 2px 5px; margin-top: 3px; font-size: 10px; line-height: 1.6; color: var(--dsw-alias-label-tertiary); }
/* 分隔符跟在条目**后面**（不是用 ::before 加在下一个前面）：十余个渠道在 280px 里必然
   换行，::before 的写法会让换行处那一行**以孤立的点开头**（预览里实测到了）；
   ::after 则表现为行尾的「·」，与行内文本的分隔习惯一致。
   ⚠️ 刻意不写死渠道数：原文写「9 个」，加 minimaxintl 后已是 10 个（2026-10-16 审计）。 */
.dim-jh-badgeAutoChannel:not(:last-child)::after { content: " ·"; opacity: .6; }
/* 偏好：分段控件（未选中透明、选中浮起），比三个独立胶囊更紧凑整齐 */
.dim-jh-badgePref { display: flex; gap: 2px; padding: 2px; border: .5px solid var(--dsw-alias-border-l2); border-radius: 7px; background: var(--dsw-alias-bg-layer-2); }
.dim-jh-badgePrefBtn { flex: 1; min-width: 0; padding: 2px; border: 0; border-radius: 5px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 10px; line-height: 1.5; white-space: nowrap; cursor: pointer; transition: background .15s ease, color .15s ease; }
.dim-jh-badgePrefBtn:hover { color: var(--dsw-alias-label-primary); }
/* 选中项自带描边：浅色下只靠白色底与底色区分太弱 */
.dim-jh-badgePrefBtn[aria-pressed="true"] { border: .5px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, var(--dsw-alias-border-l2)); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-brand-primary); font-weight: 600; box-shadow: 0 1px 2px rgba(0, 0, 0, .06); }
/* 分区：细分隔线分组，间距 5px（比 4px 多 1px 呼吸：账号备注是 10px 灰字，
   紧贴下一个账号名会读成同一块；再大就不「小巧」了）
   ⚠️ 分隔线用**全不透明**的 border-l2：此前用 color-mix 降到 75%，浅色下几乎看不见。 */
.dim-jh-badgeSection { display: flex; flex-direction: column; gap: 5px; margin-top: 7px; padding-top: 7px; border-top: .5px solid var(--dsw-alias-border-l2); }
.dim-jh-badgeSectionTitle { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; font-size: 10px; font-weight: 600; letter-spacing: .02em; color: var(--dsw-alias-label-tertiary); }
.dim-jh-badgeSectionSum { font-weight: 600; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
.dim-jh-badgeRow { display: flex; flex-direction: column; gap: 1px; }
/* 一行放下「名字 …… 数值」（名字可省略号，数值不换行） */
.dim-jh-badgeRowHead { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; font-size: 11px; color: var(--dsw-alias-label-primary); }
.dim-jh-badgeRowName { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dim-jh-badgeRowNote { font-size: 10px; line-height: 14px; color: var(--dsw-alias-label-tertiary); }
/* 分桶说明的**逐段带色**（用户 2026-10-12：永久绿 / 长期黄 / 临期红 + 倒计时）。
   ⚠️ 颜色语义与 credit-expiry.js 的 expirySplitParts 一一对应，改一处要改两处：
     permanent（服务端没给到期时间，真·永久）→ ok 绿
     longTerm（有到期时间但还早）              → warn 黄
     expiring（窗口内，再不用就作废）          → error 红
   ⚠️ 用 tone 变量而不是硬编码色值：深浅色主题各自有定义（与 .dim-jh-badgeDot 同源）。 */
.dim-jh-badgeNotePart { font-variant-numeric: tabular-nums; }
.dim-jh-badgeNotePart[data-tone="ok"] { color: var(--dsw-alias-state-success-primary, #15803d); }
.dim-jh-badgeNotePart[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary, #b45309); }
.dim-jh-badgeNotePart[data-tone="error"] { color: var(--dsw-alias-state-error-primary, #d93025); }
.dim-jh-badgeNotePart[data-tone="muted"] { color: var(--dsw-alias-label-tertiary); }
.dim-jh-badgeNoteSep { color: var(--dsw-alias-label-tertiary); }
/* 窗口：**一行**放下 名称 / 进度条 / 百分比 / 重置倒计时。
   ⚠️ 用户 2026-10-02 明确口径（附截图）：「像两边对齐，但进度条要一样长，文字部分
   左右分别对齐」⇒ 用**共享列宽的 grid**（不是整块居中、也不是每行各自 flex）：
   - 列 1 max-content：标签统一按最宽那个对齐，**靠左**，于是三行进度条起点也一致；
   - 列 2 minmax(60px, 1fr)：进度条吃掉剩余宽度 ⇒ 三行**等长**且自适应；
   - 列 3 max-content：百分比紧跟在条后；
   - 列 4 固定 100px + text-align: right：倒计时**贴右边缘**，各行对齐。
   （早先试过「整块居中 + 固定 64px 条」——被否掉：那样两侧不对齐。） */
.dim-jh-badgeWins { display: grid; grid-template-columns: max-content minmax(60px, 1fr) max-content 100px; align-items: center; gap: 4px 6px; }
.dim-jh-badgeWin { display: contents; }
.dim-jh-badgeWinLabel { font-size: 10.5px; color: var(--dsw-alias-label-secondary); text-align: left; white-space: nowrap; }
.dim-jh-badgeWin .dim-jh-quotaBar { height: 3px; }
.dim-jh-badgeWinReset { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; color: var(--dsw-alias-label-tertiary); text-align: right; }
.dim-jh-badgeValue { flex: none; font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
.dim-jh-badgeValue[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary); font-weight: 500; }
.dim-jh-badgeNote { font-size: 10px; line-height: 14px; color: var(--dsw-alias-label-tertiary); }
/* 签到：两个按钮并排、等分（本渠道按钮在不支持签到时不渲染，另一个占满整行）
   ⚠️ 保留 .5px 主题描边：浅色下 layer-2 底与弹窗底色几乎同色，无描边就看不出是按钮。 */
.dim-jh-badgeClaim { gap: 5px; }
.dim-jh-badgeClaimRow { display: flex; gap: 5px; }
.dim-jh-badgeAction { flex: 1; min-width: 0; padding: 3px 7px; border: .5px solid var(--dsw-alias-border-l2); border-radius: 7px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; font-size: 10.5px; line-height: 1.5; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; transition: background .15s ease, color .15s ease, border-color .15s ease; }
.dim-jh-badgeAction:hover:not(:disabled) { border-color: color-mix(in srgb, #1677ff 45%, var(--dsw-alias-border-l2)); background: color-mix(in srgb, #1677ff 10%, var(--dsw-alias-bg-layer-2)); color: var(--dsw-alias-brand-primary); }
.dim-jh-badgeAction:disabled { opacity: .55; cursor: default; }
.dim-jh-badgeNotice { font-size: 10px; line-height: 14px; color: var(--dsw-alias-label-secondary); }
.dim-jh-badgeNotice[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary); }
.dim-jh-badgeFail { font-size: 10px; line-height: 14px; color: var(--dsw-alias-state-error-primary); }
.dim-jh-badgeFoot { font-size: 10px; line-height: 14px; color: var(--dsw-alias-label-tertiary); }
/* 「展开其余 N 个账号」/「收起」：纯文字按钮，左对齐、不占满宽。
   ⚠️ 刻意**不复用** .dim-jh-badgeAction：那条规则是 flex:1 的实心按钮（用于签到），
   放在明细列表下面会抢走视觉焦点 —— 用户要的是「明细可以收起来」，不是一个主操作。
   align-self: flex-start 是因为父容器 .dim-jh-badgePop 是 flex 列（默认 stretch）。 */
.dim-jh-badgeMore { align-self: flex-start; margin-top: 3px; padding: 1px 0; border: 0; background: none; font: inherit; font-size: 10px; line-height: 1.6; color: var(--dsw-alias-link); cursor: pointer; }
.dim-jh-badgeMore:hover { color: var(--dsw-alias-brand-primary); text-decoration: underline; }

/* ── 聚合 provider 的面板（AggregatePanel）──
   ⚠️ 本文件是模板字符串 ⇒ 注释里**禁止反引号**（会提前闭合）。
   ⚠️ 带属性选择器的规则必须放在**基础规则之后**（model-filter.spec.ts 的 ruleOf()
      按源码顺序取第一条匹配规则，写在前面会让它误取到新块、跳过基础规则）。 */
.dim-jh-aggPanel { flex: 1 1 auto; min-height: 0; padding: 16px 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
.dim-jh-aggIntro { display: flex; flex-direction: column; gap: 4px; }
.dim-jh-aggTitle { margin: 0; font-size: 16px; font-weight: 600; color: var(--dsw-alias-label-primary, #1a1a1a); }
.dim-jh-aggIntroLine { margin: 0; font-size: 12px; line-height: 1.7; color: var(--dsw-alias-label-secondary); }
.dim-jh-aggIntroWarn { margin: 0; font-size: 12px; line-height: 1.7; color: var(--dsw-alias-label-tertiary); }
/* ⚠️⚠️ 工具行必须**允许换行**（真实缺陷，用户 2026-10-16 验收截图）：
   原本是 display: flex 且默认 nowrap ⇒ 面板一窄，「排序：按临期」/「拒绝非临期」
   这些多字按钮被压到只剩几个字符宽，**文字竖排**逐字折行（截图里正是那样）。
   ⇒ flex-wrap: wrap 让它们换行，而不是被压扁。
   ⚠️ 本文件是模板字符串：注释里**绝不能出现反引号**（会提前闭合模板，报错却指向
   注释那一行，看起来像 CSS 写错了 —— AGENTS.md 有专条记录，我这次又踩了一次）。 */
.dim-jh-aggToolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
/* ⚠️ 计数**独占一行**（用户 2026-10-16：「43 个聚合模型应该显示在按钮下面」）。
   两道措施：
   ① HTML 里它排在全部按钮**之后**（见 jet-hub.js 的工具行注释）；
   ② 这里给 flex-basis: 100% —— 强制换行到下一行，而不是「面板够宽时又跑到按钮右侧」。
      用户要的是**位置**（在按钮下面），不是「窄的时候才换行」。
   order: 1 是纵深防御：即使将来有人把它的 HTML 顺序挪回前面，它仍排在按钮之后。 */
.dim-jh-aggCount { flex-basis: 100%; order: 1; font-size: 12px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
/* ⚠️⚠️ 工具栏的按钮**不再有自己的样式类**（2026-10-16，用户第二次验收）。
   原先这里是自造的 .dim-jh-aggRefresh / .dim-jh-aggBtn（圆角 6px、无背景色、
   primary 只是描边变蓝），与全站标准按钮 .dim-jh-btn（圆角 8px、有底色、
   hover 变蓝、primary = 实心蓝底白字）**形态不一致** ⇒ 用户看到的是
   「拒绝非临期和切换排序为什么还是没有按按钮样式（图2）显示」。
   ⇒ 聚合工具栏与「保存顺序」现已统一用 .dim-jh-btn（那里自带 nowrap 与 :disabled），
     本处两个自造类**已删除**（零使用者的死样式是本仓库红线）。
   ⚠️ 唯一保留的自定义：工具行本身的 .dim-jh-aggToolbar（flex-wrap）与计数样式。 */
.dim-jh-aggNotice { padding: 6px 10px; border-radius: 6px; font-size: 12px; color: var(--dsw-alias-label-error, #c0392b); background: var(--dsw-alias-bg-error, rgba(192, 57, 43, 0.08)); }
.dim-jh-aggEmpty { padding: 12px; font-size: 12px; line-height: 1.7; color: var(--dsw-alias-label-secondary); }
/* ⚠️ 原先这里还有 .dim-jh-aggGroup / .dim-jh-aggGroupTitle（厂商分组标题），
   已按用户 2026-10-07 的要求删除 —— 渠道维度信息在**展开后的子列表**里逐条显示，
   分组标题冗余（且其中的「(2)/(5)」是**模型个数**，容易被误读成渠道个数）。
   ⚠️ 本文件的样式整体是一个模板字符串 —— 注释里**不能出现反引号**（会提前终止，
   有专门用例守着：usage-badge-client.spec.ts / zcode-channel-dialog.spec.ts）。 */
.dim-jh-aggModel { border: 1px solid var(--dsw-alias-border-secondary); border-radius: 8px; overflow: hidden; }
/* 模型平铺后的行间距：原先由 .dim-jh-aggGroup 的 gap: 4px 提供，分组去掉后
   改由相邻兄弟选择器承担（与 .dim-jh-railGroup + .dim-jh-railGroup 同一模式）。 */
.dim-jh-aggModel + .dim-jh-aggModel { margin-top: 4px; }
.dim-jh-aggModelHead { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 10px; border: 0; background: none; font: inherit; font-size: 13px; text-align: left; color: var(--dsw-alias-label-primary); cursor: pointer; }
.dim-jh-aggModelHead:hover { background: var(--dsw-alias-bg-secondary, rgba(0, 0, 0, 0.03)); }
.dim-jh-aggModelName { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 「候选全部未参与轮换」提示（规格 §5.2 要求显式提示，避免用户以为模型坏了）。
   ⚠️ 用 warning 色与说明文字区分开（它是**需要注意**的状态）。
   ⚠️⚠️ 2026-10-16（用户验收：「占太宽了把模型名字都挤没了」）三道防线：
   - 文案已缩到 ≤5 个汉字（解释性文字移进 title）；
   - white-space: nowrap 让帽子**不换行**（换行会变两行高、且吃掉模型名宽度）；
   - max-width: 40% + 省略号，帽子不得无限撑开。
   模型名那一格是 flex: 1 / min-width: 0，故剩余宽度全归它（超长才省略号）。 */
.dim-jh-aggAllRejected { flex: none; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 1px 6px; border-radius: 4px; font-size: 11px; color: var(--dsw-alias-state-warn-primary, #b45309); background: var(--dsw-alias-bg-warn, rgba(180, 83, 9, 0.10)); }
.dim-jh-aggChevron { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.dim-jh-aggCandidates { display: flex; flex-direction: column; border-top: 1px solid var(--dsw-alias-border-secondary); }
.dim-jh-aggCandidate { display: flex; align-items: center; gap: 8px; padding: 5px 10px 5px 20px; font-size: 12px; }
.dim-jh-aggCandidate + .dim-jh-aggCandidate { border-top: 1px solid var(--dsw-alias-border-tertiary, rgba(0, 0, 0, 0.04)); }
.dim-jh-aggCandidateRejected { opacity: 0.55; }
/* 候选行里的供应商图标（2026-10-26）。
   ⚠️ 基类 30px 是给左栏 48px 按钮的；这一行 padding 只有 5px、字号 12px，
   照搬会把行高从 28px 撑到 40px，14 个模型的候选列表当场变长一倍。
   ⚠️ 这里**不需要**额外的淡出规则：未参与的候选整行走 .dim-jh-aggCandidateRejected
   的 opacity，图标作为子节点自然一起淡（与模型列表那处不同 —— 那边只淡了文字格）。 */
.dim-jh-aggCandidate > .dim-jh-providerIcon { flex: none; width: 18px; height: 18px; border-radius: 5px; box-shadow: none; }
.dim-jh-aggCandidate > .dim-jh-providerIcon img { width: 13px; height: 13px; }
.dim-jh-aggCandidateLabel { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary); }
/* 「按临期排序」后显示在候选行右侧的到期提示（相对时间，如「3 天」）。
   ⚠️ flex: none 让它不参与压缩（候选名那一格已经 flex:1 吃掉剩余宽度）。 */
.dim-jh-aggCandidateExpiry { flex: none; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.dim-jh-aggToggle { flex: none; padding: 2px 8px; border: 1px solid var(--dsw-alias-border-secondary); border-radius: 5px; background: none; font: inherit; font-size: 11px; color: var(--dsw-alias-link); cursor: pointer; }
.dim-jh-aggToggleOff { color: var(--dsw-alias-label-tertiary); text-decoration: line-through; }
/* ⚠️⚠️ 下面三组样式已**删除**（用户 2026-10-16 验收要求，别再写回来）：
   - .dim-jh-aggSegmented / .dim-jh-aggSeg / .dim-jh-aggSegOn：两段式排序 toggle
     ⇒ 改成**单个切换按钮**（照「锁定永久积分」的形态，激活态用 data-kind="primary"）。
     两段在窄面板下各占一列，会把工具行挤成**竖排文字**（同一个验收截图里的现象）。
   - .dim-jh-aggMove / .dim-jh-aggMove:disabled：上移/下移按钮
     ⇒ 用户明确要求「我们不应该有上下箭头就是应该鼠标拖动」。
     ⚠️ 拖动本身在此前是**坏的**（onDragStart 漏了 dataTransfer.setData ⇒
     浏览器不触发拖拽），所以那时只有箭头能用 —— 修好拖动后才删箭头。
   - .dim-jh-aggModelMeta：模型头的「N 个渠道 · 按渠道名/按临期」
     ⇒ 当前排序模式由顶部按钮表达，模型头不再重复（用户要求「可以不用显示」）。
   拖动相关样式保留：手柄与落点高亮仍是拖拽的**可发现性**信号。
   ⚠️ 本文件是模板字符串：注释里**绝不能出现反引号**（AGENTS.md 专条记录）。 */
/* 拖动手柄（只有「按手工」模式下的参与候选才有）。
   ⚠️ cursor: grab 是主要的可发现性信号（整行可拖时用户不知道能拖）。 */
.dim-jh-aggDragHandle { flex: none; cursor: grab; color: var(--dsw-alias-label-tertiary); font-size: 12px; user-select: none; }
.dim-jh-aggDragOver { outline: 1px dashed var(--dsw-alias-border-secondary); outline-offset: -1px; }
/* 未参与轮换的候选段（手工模式）：与参与段视觉分开，但仍留在同一个模型块里
   —— 用户要能一眼看到「还有哪些没打开」。 */
.dim-jh-aggInactiveSection { display: flex; flex-direction: column; border-top: 1px dashed var(--dsw-alias-border-secondary); }
.dim-jh-aggInactiveTitle { padding: 5px 10px 2px 20px; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.dim-jh-aggOrderActions { display: flex; justify-content: flex-end; gap: 6px; padding: 6px 10px; border-top: 1px solid var(--dsw-alias-border-secondary); }
/* ⚠️ 原先这里还有 .dim-jh-aggBtn（「保存顺序」按钮），已删除 —— 改用全站标准
   .dim-jh-btn（理由见上面工具栏那段注释）。零使用者的死样式是本仓库红线。 */
.dim-jh-aggFooter { display: flex; flex-direction: column; gap: 2px; padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-secondary); }
.dim-jh-aggFooter p { margin: 0; font-size: 11px; line-height: 1.7; color: var(--dsw-alias-label-tertiary); }

/* ── Accio：**没有**专属样式 ──
   ⚠️ 2026-10-13 删除了原先的「专属积分区」整段（dim-jh-accioPanel /
   accioHead / accioAccount* / accioCountdown / accioBuckets* 共 12 条）。
   原因：用户报障「accio 的显示和别的 provider 没统一，例如 loomy 的」——
   accio 原先另起一个独立区块，现改为与 loomy 同形（积分行直接进账号卡片，
   三类桶由 formatNamedPoolLine 逐池列出、倒计时作为同一行内的附注）。
   ⇒ 那 12 条样式已零引用，留着就是死代码（且会让人以为还有那个面板）。
   ⚠️ 图标底色 .dim-jh-providerIcon.accio 在文件上方，**仍在用**，别一起删。
   ⚠️ 本文件整体是模板字符串：注释里**绝不能出现反引号**（会提前闭合，
   esbuild 的报错会指向注释行、看起来像 CSS 写错）。本条注释就曾踩过。 */

/* ── 窄屏（手机 / 远程访问，max-width 720px）──
   POC（2026-10-17）：本插件此前**只有弹窗内部**有 3 处 media 查询，主布局
   .dim-jh-layout 是写死的左右两栏且 .dim-jh-rail 固定 228px —— 手机宽度约
   400px 时右面板只剩约 76px 可用，于是面板被压成一条窄缝、操作按钮被裁断、
   中文提示逐字竖排。
   修法：窄屏下改为**上下两段** —— 左栏降级为顶部横向可滑动的标签条，
   右面板获得整宽。**只新增本块，不改任何既有规则**（故 228px 那条断言不受影响）。
   ⚠️ **范围限定**（2026-10-20 审计订正）：本块只解决**本插件 settings 面板
   自身**的两栏布局问题。装了「把 DSH Web 包成手机 App」的外壳插件（如
   dsh-mobile）时，外壳接管的是**页面级**布局（替换宿主 root 槽位），本插件
   面板会以 drawer / surface 的形态呈现 —— 那种场景下的整体观感不由本块决定。
   故原描述里「解决手机端界面割裂」这个全局宣称已收窄。
   ⚠️ 本文件是模板字符串，本注释内不得出现反引号。 */
@media (max-width: 720px) {
  .dim-jh-layout { flex-direction: column; }
  .dim-jh-rail {
    width: auto; flex: none;
    display: flex; flex-direction: row; align-items: stretch;
    gap: 8px; padding: 8px 10px;
    overflow-x: auto; overflow-y: hidden;
    border-right: 0;
    border-bottom: 1px solid var(--dsw-alias-border-default, #e5e5e5);
  }
  /* 分组外壳在横向条里不再需要：display: contents 让 provider 按钮
     直接参与父级 flex，避免每个分组各占一整行。 */
  .dim-jh-railGroup { display: contents; }
  .dim-jh-railGroupTitle { display: none; }
  .dim-jh-providerRow { flex: none; }
  .dim-jh-provider { width: auto; min-height: 40px; padding: 6px 10px; }
  .dim-jh-panel { padding: 14px 12px; }
}

/* ── 窄屏：用量浮层（聊天输入区那枚徽标展开的面板）──
   POC（2026-10-17，报障「对话框的这里 ui 也需要适配」，附窄屏截图）。
   ⚠️ 2026-10-20 审计整改：本块的**根因描述与 z-index 论证都被推翻重写**，
   下面每一段都标了「已订正」。原描述保留在末尾的「历史」段里供追溯。

   ## 已订正 ①：真正的失效机制不是「左边缘被裁」
   原描述说窄屏下浮层左边缘越出视口 89px。按宿主**真实** composer 布局复刻
   PRE-PR 形态实测：徽标在 .uV2eYG_trailing 里（该行有 margin-left: auto）
   ⇒ 徽标靠**右**（VW=492 时 L=334 R=468），浮层向左展开 220px 得
   popL=248 ⇒ **完全没有越界**。原描述里 badge=134~151（靠左）在宿主布局中
   不成立。⇒ 本块的真实收益是「浮层改为视口锚定、不再跟着徽标跑，且更宽」，
   不是「修裁切」。

   ## 已订正 ②：真正需要 CSS 兜底的是**旧内核的 containing block 偏差**
   宿主 composer 工具行 .uV2eYG_row 带 container-type: inline-size，而徽标
   是它的后代。实测两引擎行为不同：
     - Chromium 154：inline-size containment 只含 inline 轴，**不**创建 fixed
       的 containing block ⇒ fixed 仍按视口锚定（符合规范）；
     - Edge 122：把它当 layout containment ⇒ fixed 改为**相对该祖先**定位
       ⇒ left/right/bottom 全变成「相对 composer 行」的坐标，浮层跟着 composer
       跑、宽度被压缩（实测 popLeft 24→124、width 476→344）。
   ⇒ 只靠 CSS 无法在旧内核上做视口锚定，故窄屏浮层改由 usage-badge.js
   **portal 到 document.body**（body 之上无 containment 祖先，两引擎都按视口
   锚定）。本块仍保留全部承重声明作**兜底**：内联样式一旦被改坏，这里还能挡住。

   ## 已订正 ③：bottom 必须用宿主的 composer 高度变量，不能硬编码
   宿主用 ResizeObserver 把真实 composer 高度写进 --dsh-composer-height
   （dsh-client-ui-conversation 的 ConversationContent），其 CSS fallback 是
   **152px**（宿主三处都写 var(--dsh-composer-height,152px)）。
   原实现硬编码 88px —— 实测 composer=152px 时浮层**压住输入区 64px**，并
   **盖住「用量」徽标按钮**（命中测试点到的不是按钮，是浮层内的 DIV）
   ⇒ 用户点不到。改用变量后 gap=0、徽标可点（两引擎、多档 composer 高度均实测）。
   ⚠️ 该变量能被浮层继承：CSS 变量沿 **DOM 祖先链**继承，与定位方式无关；
   portal 到 body 后 body 仍在 scroller 的**兄弟**位置？—— 不是，body 是共同祖先，
   故变量照样继承得到（已实测 popover 侧 getComputedStyle 读到 152px/220px）。

   ## 已订正 ④：z-index 的区间是 (1101, 3000)，不是 (250, 1000)
   原论证的下限 250 只考虑了**外部外壳**（dsh-mobile），漏了**宿主自己**：
     - 宿主 79 处 z-index 里有 **6 处 1100**（chat 的 bRhRbq_panel、
       conversation 的 JObwrW_panel【composer 里的 ContextMeter，与徽标同一行】、
       model-selection 的 _7KE1Ra_menu【与徽标同一行的模型选择菜单】、
       plugin-manager、schedule ×2）；
     - 另有 **3 处全屏 overlay**：attachment 1000、settings-general 1000、
       settings-account 1001（还有 onboarding 900）。
   浮层若取 300，上述任一出现就把浮层整块盖住。
   原上限 1000 的锚点 .dim-jh-loginOverlay 是**死规则**：全仓 className 用法
   0 命中、git 历史从未渲染过（只剩一条 CSS + 注释）；且它与浮层**不在同一
   stacking context**（分属 settings 页树与 composer 树，两树中间的
   .dim-jh-page/.dim-jh-layout/.dim-jh-rail/.dim-jh-panel 全无 z-index）
   ⇒ z-index 本就不可比。
   ⇒ 改为按**真正同族**的 .dim-jh-modalOverlay(3000) 定上限，按宿主最高
   overlay(1001) 与 ContextMeter(1100) 定下限 ⇒ 取 **1200**（(1101, 3000) 内）。
   另注：dsh-mobile 的 [data-shell-overlay] 恰好是 z-index:300（带 !important），
   原取值与它**完全相等** ⇒ 同层级时后出现的 DOM 胜出，不可预测；1200 也消除了这点。

   ⚠️ 本注释内**不得出现反引号**：本文件整体是模板字符串，反引号会提前闭合它
   （AGENTS.md 红线；本文件的 usage-badge-client.spec.ts 有专条用例逐块扫描注释）。

   ## 历史（已推翻，勿据此改回）
   原描述：根因是「VW=492 badge=134~151 pop=-89~151 L_OVER=true」；取 300 的
   理由是「下限 > 250 压过 dsh-mobile details、上限 < 1000 因为
   .dim-jh-loginOverlay 是 1000」；bottom 硬编码 88px。上述三处均已订正。 */
@media (max-width: 720px) {
  .dim-jh-badgePop {
    position: fixed !important;
    left: 8px !important;
    right: 8px !important;
    top: auto !important;
    bottom: calc(env(safe-area-inset-bottom, 0px) + var(--dsh-composer-height, 152px)) !important;
    width: auto !important;
    max-width: none !important;
    /* ⚠️ 100dvh 而不是 100vh：移动端地址栏收放会让 100vh 与真实可视高度脱节。
       外加 max(120px, ...) 下限 —— 原写法在 vh<=140 时算出 0 或负值，实测
       vh=120 时 max-height 被压成 0px（浮层完全不可见却仍占位）、
       vh=60 时整块飞出屏幕上方。 */
    max-height: max(120px, calc(100dvh - 160px)) !important;
    z-index: 1200 !important;
  }
}


/* ══════════════════════════════════════════════════════════════════════
   dsh-launcher 移动端适配（新增层，本文件唯一一段本地样式扩展）
   ──────────────────────────────────────────────────────────────────────
   背景：本插件的配置界面在 Android WebView 窄屏（360 CSS px）下按桌面尺度
   排布会出问题。适配层用真机 DOM 度量逐轮驱动，非静态推断。

   实测环境：Sharp 803SH / Android 11 / 1080x2280 / density 480 => DPR 3
            => CSS 视口 360 x 686～760（验收要求的 360-420 区间下限，最严苛）

   桌面原状与窄屏故障：
     1) .dim-jh-layout 是 flex 两栏 + .dim-jh-rail 固定 228px，360px 下右侧
        只剩约 130px，内容被挤到溢出。
     2) .dim-jh-accountActions 是 flex-wrap: nowrap，行内 5 个按钮必然横向溢出。
     3) .dim-jh-btn 高约 26px、.dim-jh-iconBtn 宽 26px，低于触控可用下限。
     4) .dim-jh-header / .dim-jh-panel 的 padding 按桌面给（24px），窄屏浪费。
     5) 无任何安全区处理，刘海与底部手势条会盖住页头/底部操作。

   真机度量驱动发现的两个隐藏坑（仅看代码看不出来）：
     A) flex 子项默认 min-width: auto —— .dim-jh-rail 虽是 overflow-x: auto 的
        横向条，却不肯收缩，把 .dim-jh-layout 与 .dim-jh-page 整体撑宽
        （实测 page scrollWidth=393 vs clientWidth=320，溢出 73px）。
        同理 .dim-jh-brand（flex 列 + brandDesc 的 nowrap）撑破 .dim-jh-header。
        ⇒ 必须给这些 flex 子项显式 min-width: 0。
     B) 只给 .dim-jh-page 加 padding 时计算值仍为 0px（被既有布局吃掉），
        ⇒ 用选择器双写 .dim-jh-page.dim-jh-page 提升特异性。

   ⚠️ 本文件整体是一个 JS 模板字符串 —— 本段注释里**不能出现反引号**，
      否则会提前终止字符串（源码上方已记过这次构建失败的成因）。
   ⚠️ 本段整体放在样式表**末尾**：靠后的规则在同等特异性下覆盖前面的写法。
   ══════════════════════════════════════════════════════════════════════ */


/* ② 中等窄屏（<=720）：收紧桌面尺度的留白，并抬触控目标到 40px */
@media (max-width: 720px) {
  .dim-jh-header { padding-top: 12px; padding-bottom: 12px; gap: 8px; }
  .dim-jh-panel { padding: 14px; }
  .dim-jh-brandName { font-size: 16px; }
  .dim-jh-brandDesc { font-size: 12px; }
  .dim-jh-btn { min-height: 40px; padding-top: 8px; padding-bottom: 8px; }
  .dim-jh-iconBtn { min-width: 40px; min-height: 40px; }
}

/* ③ 手机竖屏（<=560）：两栏改上下堆叠 —— 本适配的核心一条 */
@media (max-width: 560px) {
  .dim-jh-page { max-width: 100%; width: 100%; overflow-x: hidden; }
  .dim-jh-layout { flex-direction: column; overflow: visible; min-width: 0; max-width: 100%; width: 100%; }

  /* 左侧导航成横向可滚 tab 条：固定高度、横向可滑、不换行 */
  .dim-jh-rail {
    width: 100%;
    max-width: 100%;
    min-width: 0;
    box-sizing: border-box;
    flex: none;
    display: flex;
    flex-direction: row;
    flex-wrap: nowrap;
    align-items: stretch;
    gap: 6px;
    padding: 6px 8px;
    overflow-x: auto;
    overflow-y: hidden;
    border-right: 0;
    border-bottom: 1px solid var(--dsw-alias-border-default, #e5e5e5);
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  .dim-jh-rail::-webkit-scrollbar { width: 0; height: 0; display: none; }

  /* ══ 供应商导航：横向可滑条带（三层结构都要改，缺一层就退化成竖列）══
     结构：.dim-jh-rail > .dim-jh-railGroup > .dim-jh-providerRow > button.dim-jh-provider
     上游三层全是 grid（各自单列）⇒ 只把 rail 改成 flex row 是不够的，
     railGroup 与 providerRow 仍是 grid 单列 ⇒ 实际渲染成竖排（上一版就是这么翻的车）。
     ⚠️ 每一层都必须显式参与横向 flex，且**不许被压缩**（flex: 0 0 auto），
        否则 flex 会按默认 flex-shrink:1 把它们压扁 ⇒ 按钮互相压盖。 */
  .dim-jh-railGroup {
    display: flex;
    flex-direction: row;
    flex-wrap: nowrap;
    gap: 6px;
    flex: 0 0 auto;
    min-width: 0;
  }
  .dim-jh-railGroup + .dim-jh-railGroup { margin-top: 0; }
  /* 分组小标题是纵向列表的分隔，横向条带里没有位置 */
  .dim-jh-railGroupTitle { display: none; }

  .dim-jh-rail .dim-jh-providerRow {
    display: block;
    flex: 0 0 auto;
    /* 宽度**由内容决定**：不设 max-width，标签完整显示不截断（用户要求「内容完整」）。
       min-width 只是下限，保证短标签的按钮也够大、点得中。
       最长的标签是「WorkBuddy (国际版)」这类，实测需要约 180px 才能完整放下。 */
    min-width: 124px;
  }
  .dim-jh-rail .dim-jh-provider {
    width: 100%;
    min-width: 0;
    min-height: 44px;
    grid-template-columns: 24px minmax(0, 1fr);
    gap: 6px;
    padding: 6px 10px;
    white-space: nowrap;
    box-sizing: border-box;
  }
  .dim-jh-providerIcon { width: 24px; height: 24px; }
  /* 标签不截断：给足宽度后让它自然显示，不加省略号（用户要求「内容完整」） */
  .dim-jh-providerLabel { min-width: 0; }
  .dim-jh-providerLabel strong { overflow: visible; text-overflow: clip; white-space: nowrap; }

  /* 面板占满整宽，杜绝溢出 */
  .dim-jh-panel {
    min-width: 0;
    width: 100%;
    max-width: 100%;
    box-sizing: border-box;
    padding: 12px;
    overflow-x: hidden;
  }

  /* 页头：brand 允许收缩（否则 nowrap 的副标题撑破容器），按钮组可换行 */
  .dim-jh-header {
    min-width: 0;
    max-width: 100%;
    box-sizing: border-box;
    flex-wrap: wrap;
    padding-top: 10px;
    padding-bottom: 10px;
  }
  .dim-jh-brand { min-width: 0; flex: 1 1 auto; overflow: hidden; }
  .dim-jh-brandName { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dim-jh-brandDesc { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
  .dim-jh-headerActions {
    /* 用户要求：这几个按键做成一条横向可滑的栏，而不是折行平铺。
       关键在 flex-basis 100% —— 父级 .dim-jh-header 是 flex-wrap: wrap，
       若这里用 flex:1 1 auto，它会与 brand 争同一行、并可能分到
       「刚好装下全部按钮」的宽度，于是 overflow-x 永不触发、也滑不动。
       占满整行后才是真正的满宽条带：行内按钮 nowrap 且不收缩，
       超出部分交给 overflow-x: auto，手指左右滑即可触达全部按钮。
       （真机探针实测：w=272 scrollW=391 clientW=272 scrollable=true） */
    flex: 1 1 100%;
    min-width: 0;
    max-width: 100%;
    box-sizing: border-box;
    flex-wrap: nowrap;
    justify-content: flex-start;
    gap: 8px;
    overflow-x: auto;
    overflow-y: hidden;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
    padding-bottom: 2px;
  }
  .dim-jh-headerActions::-webkit-scrollbar { width: 0; height: 0; display: none; }
  /* 按钮本身不收缩、不折行：宽度由内容决定，靠横滑触达 */
  .dim-jh-headerActions > .dim-jh-btn { flex: 0 0 auto; white-space: nowrap; }

  /* 账号卡：操作按钮换行并均分，杜绝横向溢出（原为 flex-wrap: nowrap） */
  .dim-jh-accountCard { min-width: 0; max-width: 100%; box-sizing: border-box; padding: 12px; }
  .dim-jh-accountActions { flex-wrap: wrap; justify-content: stretch; gap: 8px; }
  .dim-jh-accountActions > .dim-jh-btn { flex: 1 1 auto; min-width: 88px; justify-content: center; text-align: center; }
  .dim-jh-metaRow { grid-template-columns: 46px minmax(0, 1fr); }
  .dim-jh-accountName { font-size: 13px; }

  /* 弹层/模态：不超出视口 */
  .dim-jh-modal { max-width: calc(100vw - 16px); max-height: calc(100vh - 16px); box-sizing: border-box; }
  .dim-jh-panelHead { margin-bottom: 12px; }

  /* 横排内容兜底：长串（额度/限流说明）不撑破容器 */
  .dim-jh-creditPackages, .dim-jh-rateLimits { overflow-wrap: anywhere; }

}
/* ── 插件详情页（plugins.bundle.config）的自有设置卡片 ──

   最外层必须自成 column 且 gap 为 0：宿主 detailSection 给直接子元素
   12px 间隔（PluginManagerPage.module.css 的 .detailSection），官方插件卡
   （终端 / 网页搜索）都包了一层内层 column，容器只看到一个子元素。
   间距改由每块自己的 padding 提供。

   下列几何与字号全部照抄官方设置行与官方插件卡实测值，不要凭感觉改。 */
.dim-jh-cardStack { display: flex; flex-direction: column; gap: 0; }
.dim-jh-cardRow { display: flex; align-items: center; gap: 8px; padding: 16px 0; }
.dim-jh-cardRowText { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; padding-right: 48px; }
.dim-jh-cardTitle { font-size: 13px; font-weight: 500; line-height: 19.5px; color: var(--dsw-alias-label-primary); }
.dim-jh-cardDesc { font-size: 12px; font-weight: 400; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
/* 下拉触发按钮：几何与官方设置页选择器一致（高 36 / 圆角 md / 13px 500）。 */
.dim-jh-cardSelector { display: inline-flex; align-items: center; gap: 12px; height: 36px; padding: 0 14px; border: none; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-module-platform); font: inherit; font-size: 13px; font-weight: 500; line-height: 19.5px; color: var(--dsw-alias-label-primary); cursor: pointer; }
.dim-jh-cardSelector:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
/* 提交中压暗整个控件，而不是只改文字色：官方对带背景控件就是这么做的
   （Switch 用 opacity 0.5，SegmentedControl 用 0.4）。 */
.dim-jh-cardSelector:disabled { cursor: default; opacity: 0.5; }
.dim-jh-cardChevron { flex: none; }
/* 焦点环：跟随本文件既有约定（outline:none + box-shadow），与 .dim-jh-switch /
   .dim-jh-zcSelect 一致。官方设置页的选择器**没有** outline 规则，故这里也不加，
   否则同一张插件页上本卡片会比其他控件多一圈描边。 */
.dim-jh-cardSelector:focus-visible { outline: none; box-shadow: 0 0 0 2px color-mix(in srgb, #1677ff 30%, transparent); }


`;
var PLUGIN_ID = "dsh-codearts-auth";
var STYLE_TAG_ID = PLUGIN_ID + "/jet-hub.css";
var STYLE_SELECTOR = "style[data-plugin-css=" + JSON.stringify(STYLE_TAG_ID) + "]";
var REFS_KEY = "jetHubRefs";
function styleElement() {
  return document.head.querySelector(STYLE_SELECTOR);
}
function mountStyles() {
  const existing = styleElement();
  if (existing !== null) return existing;
  const style = document.createElement("style");
  style.dataset.plugin = PLUGIN_ID;
  style.dataset.pluginCss = STYLE_TAG_ID;
  style.textContent = STYLES;
  document.head.appendChild(style);
  return style;
}
function refsOf(style) {
  const n = Number(style.dataset[REFS_KEY]);
  return Number.isFinite(n) ? n : 0;
}
function installJetHubStyles() {
  const style = mountStyles();
  style.dataset[REFS_KEY] = String(refsOf(style) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (style.parentNode === null) return;
    const left = refsOf(style) - 1;
    if (left > 0) {
      style.dataset[REFS_KEY] = String(left);
      return;
    }
    style.remove();
  };
}
function ensureJetHubStyles() {
  if (styleElement() !== null) return false;
  mountStyles();
  console.warn("[jet-hub] 样式表缺失（被卸载或热更新摘除），已重新注入");
  return true;
}

// plugin-src/client/jet-hub.js
var React3 = __toESM(require("react"), 1);

// src/provider-registry.ts
var PROVIDER_REGISTRY = Object.freeze([
  {
    id: "codearts",
    label: "CodeArts (华为云)",
    displayName: "CodeArts (华为云)",
    logoClass: "codearts",
    credits: { balance: true, dailyCheckin: true },
    /**
     * 三档分档覆盖**两个来源**（2026-10-20）：
     *
     * - **基础积分包**（`usageBasicPackageCredit`）随套餐周期到期，响应顶层
     *   给了 `end_date`（纯日期，如 `2026-10-27`）⇒ 有确切时刻，已写进
     *   `packages[].deductionEndTime`，可正常分档。
     * - **赠送积分包**（签到/活动，逐笔「发放日 +30 天」）与**按需包**没有
     *   逐包到期字段，但上游在该分类 metric 上给了
     *   `package_credit_expiring_amount`（「其中 N 分即将到期」的标量）
     *   ⇒ 已解析到 `packages[].expiringRemaining`，**拆开**进两个桶：
     *   临期 += `expiringRemaining`，永久 += 余下部分。
     *
     * 于是三档合计恒等于 `credits.total`，不再出现「永久 25000」旁边
     * 又写「另有 2000 即将到期」这种对不上的数字（用户 2026-10-20 报障）。
     *
     * ⚠️ 拆出来的那部分**没有倒计时** —— 上游不给逐笔日期，绝不编造。
     * ⚠️ 赠送包整体仍是**会到期**的性质，只是其中一段时间窗口内的部分被
     *   标成「即将到期」；余下部分归入永久桶是**保守方向**（宁可少用）。
     */
    usesExpiryWindow: true,
    /**
     * ⚠️ 不开 `permanentLock`：CodeArts 的积分**没有「永久」这一档**。
     *
     * 依据（官方计费文档 + 实测）：
     * - 基础积分包随套餐周期作废（体验版虽自动免费续期，但基础包额度按周期重置）；
     * - 赠送积分包逐笔「发放日 +30 天」；
     * - 按需包按消费实时结算。
     *
     * 三类的共同点是**都会到期**，没有「永不作废」的池。开永久锁会让用户
     * 误以为「锁住就不会作废」，而实际只是把这批号从选号里摘出去 ——
     * 语义错位，故不登记。
     */
    /**
     * ⚠️ **必须与 `usesExpiryWindow` 同时登记**（2026-10-20 合并审计发现，
     * 与 minimax 两站同因）：`provider-registry.spec.ts` 有一条从**能力事实
     * 派生**的守卫「`usesExpiryWindow` 的家必须有 `creditPackages`（同一份数据）」
     * —— 两者读的是同一批 `packages[]`。只开前者会让账号卡片**不展示逐包列表**，
     * 用户看得到「永久 / 长期 / 临期」三档合计，却看不到是**哪几笔**构成的。
     *
     * ⚠️ 本家补上是有实据的：`codearts-credits.ts` 已把上游的
     * `package_credit_expiring_amount` 聚合标量**拆到逐包**
     * （`packages[].expiringRemaining`），基础包还带 `deductionEndTime`
     * （取自套餐周期 `end_date`）—— 「N/M 个资源包有效」这句因此有真实内容。
     */
    creditPackages: true,
    settingsNamespace: "llm-codearts",
    channel: true
  },
  {
    id: "buddy",
    label: "CodeBuddy (腾讯)",
    displayName: "CodeBuddy (腾讯)",
    logoClass: "buddy",
    credits: { balance: true, dailyCheckin: true },
    creditPackages: true,
    permanentLock: true,
    usesExpiryWindow: true,
    settingsNamespace: "llm-buddy",
    channel: true
  },
  {
    id: "workbuddy",
    label: "WorkBuddy (国际版)",
    displayName: "WorkBuddy (国际版)",
    logoClass: "workbuddy",
    // ⚠️ 国际版后端**没有**签到接口（内核里只有 `get-dosage-notify` 用量通知）。
    credits: { balance: true, dailyCheckin: false },
    creditPackages: true,
    permanentLock: true,
    usesExpiryWindow: true,
    settingsNamespace: "llm-workbuddy",
    channel: true
  },
  {
    id: "lobsterai",
    label: "LobsterAI (有道)",
    displayName: "LobsterAI (有道)",
    logoClass: "lobsterai",
    credits: { balance: true, dailyCheckin: true },
    creditPackages: true,
    permanentLock: true,
    usesExpiryWindow: true,
    settingsNamespace: "llm-lobsterai",
    channel: true
  },
  {
    id: "qoder",
    label: "Qoder",
    displayName: "Qoder",
    logoClass: "qoder",
    credits: { balance: true, dailyCheckin: true },
    creditPackages: true,
    /**
     * ⚠️ **2026-10-20 补登记：三档分档（永久 / 长期 / 临期）与永久锁此前完全没生效。**
     *
     * 这两项此前缺失导致**两个静默故障**（与 minimax / astudio 那两次逐字同因）：
     * - 缺 `usesExpiryWindow` ⇒ `jet-hub-rpc.ts` 的判据
     *   `descriptorOf(req.provider)?.usesExpiryWindow === true` 为 false ⇒
     *   响应里没有 `windowDays` ⇒ 客户端 `splitCreditsByExpiry` 收 `undefined`
     *   ⇒ 面板上「永久 X · 长期 Y · 临期 Z」那整行**不渲染**；
     * - 缺 `permanentLock` ⇒ 客户端 `supportsPermanentLock()` 为 false ⇒
     *   「锁定永久积分」开关**整个不渲染**（不是灰掉，是不存在）。
     *
     * ⚠️⚠️ **但这两项对本家是「能力开关」，不是数据保证 —— 逐包到期拿不到。**
     *
     * 实测（2026-10-20，两个真实 qodercn 账号）
     * `GET /sash/api/v2/me/usage` 只下发三个额度块：
     * - `userQuota`（套餐额度，实测 `{total:0,used:0,remaining:0}`）；
     * - `addOnQuota`（用户截图里的「个人资源包 1,900」）—— **只给聚合标量**
     *   （`total` / `used` / `remaining`）加一个 `detailUrl` 网页链接，
     *   **没有任何日期字段**；
     * - `dedicatedResourcePackages` —— **唯一**带真实逐包到期（`expiresAt`
     *   字符串）的那一项，而本机账号实测为 `undefined`。
     *
     * ⇒ 当前账号形态下 `packages[]` 里**没有任何真实的逐包到期时刻**，
     *   `qoder-credits.ts` 的 `toPackage()` 因此**不写** `deductionEndTime`
     *   ⇒ `splitBuddyCreditsByExpiry` 只得到一个「永久（未知到期）」桶 ⇒
     *   **临期桶恒为 0**。这**不是缺陷**，是「上游不下发 ⇒ 我们不编造」的如实结果
     *   （本仓库红线）。只有上游真的给了 `dedicatedResourcePackages` 的账号
     *   才会出现临期档。
     *
     * ⚠️ 顺带澄清一个**反例**：顶层 `qoderUsage.expiresAt` 实测
     *   `253402214400000`（= `9999-12-31T00:00:00.000Z`）**不是**到期时刻 ——
     *   它是 Qoder 对 `userQuota`（套餐额度）下发的**永久哨兵**：官方客户端
     *   asar 的用量面板里只有 `userQuota.expiresAt` 走 `renewson`
     *   （文案「将于 {{date}} 刷新」，语义是**订阅刷新日**），而
     *   `addOnQuota` 那一格**只渲染 used/total/remaining、不给任何日期**。
     *   把它当真实到期写进 `deductionEndTime` 会把整个套餐额度伪造成
     *   「9999 年到期」的临期档，故 `qoder-credits.ts` 用
     *   `QODER_PERMANENT_EXPIRY_MS` 显式识别并**不写**。
     *   （活动的 `validity = {mode:'RELATIVE_DAYS', days:30}` 只描述
     *   「领取后 30 天有效」的**语义**，同样不是任何一笔已知时刻。）
     *
     * ⚠️ **`permanentLock` 因此锁的正是「未知到期」那一桶**：
     *   `credential-resolver.ts` 的 `allowPermanent` 拦掉永久桶的可消耗性。
     *   对「上游只给聚合标量」的账号，锁定后确实把该桶保了下来 ——
     *   语义如实，**不是假开关**（Qoder 的 `dedicatedResourcePackages` 一旦下发，
     *   其真实临期包与永久桶的分档同样成立）。
     *
     * ⚠️ 三处必须同改（本文件 + `provider-expiry.ts` 的 `createProviderExpiry()`
     * + `aggregate-expiry.ts` 的 `WIRED_EXPIRY_PROVIDERS`），由
     * `expiry-runtime-parity.spec.ts` 真跑 `apply()` 锁一致 ——
     * 这是该陷阱的**第 7 次复发**（cline → accio → officeace → autoclaw
     * → astudio → minimax → qoder），漏任何一处的症状都是**静默**的。
     */
    permanentLock: true,
    usesExpiryWindow: true,
    settingsNamespace: "llm-qoder",
    channel: true
  },
  {
    id: "qodercn",
    label: "Qoder (中国版)",
    displayName: "Qoder (中国版)",
    logoClass: "qodercn",
    credits: { balance: true, dailyCheckin: true },
    creditPackages: true,
    // ⚠️ 与上面的国际版**同因同日**补登记（2026-10-20）：两站共用全部
    //    `src/qoder*.ts` 实现（适配器 / 认证 / 积分），余额响应形状逐字段同形，
    //    差异只在 `src/qoder-product.ts` 的 `QODER_CN` 常量（域名 / client_id /
    //    模型表）。⇒ 分档与永久锁的理由、以及「逐包到期拿不到」那条限制，
    //    与国际版**逐字相同**（见上一条的长注释，不重复）。
    //    ⚠️ 唯一需要单独记一笔的差异：**本次真机取证用的正是中国版账号**
    //    （`openapi.qoder.com.cn`），而国际版 `openapi.qoder.sh` 在本机
    //    **网络不可达**（`fetch failed` ~10.7s）⇒ 国际版的实际响应形状
    //    **未在本次实测覆盖**。实现必须对「取不到」保守：
    //    `fetchQoderCreditBalance` 网络失败/非 2xx/形状非法一律返回 `null`
    //    ⇒ 聚合折算得 `UNUSABLE`（剔除该候选），**绝不**退化成「有余额」。
    //    ⚠️ 两家必须各占一项：`WIRED_EXPIRY_PROVIDERS` 是按 **provider id**
    //    的清单，漏掉 `qodercn` 会让中国版在聚合候选层被静默剔掉
    //    （与 minimax / minimaxintl 同因）。
    permanentLock: true,
    usesExpiryWindow: true,
    settingsNamespace: "llm-qodercn",
    channel: true
  },
  {
    id: "trae",
    label: "TRAE (字节)",
    displayName: "TRAE (字节)",
    logoClass: "trae",
    credits: { balance: true, dailyCheckin: true },
    creditPackages: true,
    permanentLock: true,
    usesExpiryWindow: true,
    settingsNamespace: "llm-trae",
    channel: true
  },
  {
    id: "cline",
    label: "Cline",
    displayName: "Cline",
    logoClass: "cline",
    // ⚠️ 无签到：对整个 sidecar 二进制做字符串扫描，`checkin` / `campaign` 等
    //    均无 Cline 业务端点命中。
    // `subscriptionQuota` 是**本表唯一**具备该项的渠道（5 小时 / 周 / 月窗口）。
    credits: { balance: true, dailyCheckin: false, subscriptionQuota: true },
    settingsNamespace: "llm-cline",
    channel: true
  },
  {
    id: "loomy",
    label: "Loomy (讯飞)",
    displayName: "Loomy (讯飞)",
    logoClass: "loomy",
    credits: { balance: true, dailyCheckin: true, onboardingTasks: true },
    // ⚠️ Loomy **不返回限流错误**：今日赠送额度用完后，服务端继续扣永久积分且
    //    照常返回（静默降级）⇒「重测 / 重置」对它毫无意义（重测还会白烧积分）。
    rateLimit: false,
    permanentLock: true,
    // ⚠️ 不在 usesExpiryWindow：它**没有窗口概念**，服务端直接给两个命名池。
    settingsNamespace: "llm-loomy",
    channel: true
  },
  {
    id: "raccoon",
    label: "Raccoon (商汤)",
    displayName: "Raccoon (商汤)",
    logoClass: "raccoon",
    // ⚠️ 不登记 `dailyCheckin`，且**这不是遗漏**：实测「每日 300 积分」是服务端
    //    按日自动发放的（账单 `biz_type: 'daily_grant'`），**没有可调用的签到端点**。
    //    登记它会让用户每次点击都必然失败。
    //    `onboardingTasks` 是 3000 分的**幂等一次性**桌面端登录奖励。
    credits: { balance: true, onboardingTasks: true },
    settingsNamespace: "llm-raccoon",
    channel: true
  },
  {
    id: "minimax",
    // ⚠️ 2026-10-15 加国际版（`minimaxintl`）后必须带括注，否则左栏会出现
    //    「MiniMax Code」+「MiniMax Code (国际版)」两条，用户看不出前者是国内站
    //    （与 `Qoder (中国版)` / `WorkBuddy (国际版)` 的既有命名风格一致）。
    label: "MiniMax Code (中国版)",
    displayName: "MiniMax Code (中国版)",
    logoClass: "minimax",
    credits: { balance: true, dailyCheckin: true },
    /**
     * ⚠️ **2026-10-20 补登记**（用户报障：「MiniMax Code 积分也有到期时间，
     * 也应当有相同功能」，并附 AStudio 面板截图作参照）。
     *
     * 这两项此前**空缺导致两个静默故障**：
     * - 缺 `usesExpiryWindow` ⇒ `jet-hub-rpc.ts` 的 `usesWindow` 为 false ⇒
     *   响应里没有 `windowDays` ⇒ 客户端 `splitCreditsByExpiry` 收 `null` ⇒
     *   面板上「永久 X · 长期 Y · 临期 Z」那整行**不渲染**。
     * - 缺 `permanentLock` ⇒ 客户端 `supportsPermanentLock()` 为 false ⇒
     *   「锁定永久积分」按钮**整个不渲染**（不是灰掉，是不存在）。
     *
     * ⚠️ 补登记的前提是**上游确实下发到期时间**：`/minimax-cloud/api/v1/credit/details`
     * 的每条 `details[]` 都带 `expire_at_ms`（毫秒时间戳，无需换算）。
     * 此前 `fetchMinimaxCreditBalance` 把 `packages` 硬编码成 `[]`，聚合侧据此
     * 把本家归为「查不到到期时间」—— **那是「我们没解析」，不是「上游不下发」**。
     * 该函数已于同日补齐解析。
     *
     * ⚠️ 三处必须同改（本文件 + `provider-expiry.ts` + `aggregate-expiry.ts` 的
     * `WIRED_EXPIRY_PROVIDERS`），由 `expiry-runtime-parity.spec.ts` 真跑
     * `apply()` 锁一致。
     */
    usesExpiryWindow: true,
    permanentLock: true,
    /**
     * ⚠️ **必须与 `usesExpiryWindow` 同时登记**（2026-10-20 合并审计发现）。
     *
     * `provider-registry.spec.ts` 有一条从**能力事实派生**的守卫：
     * 「`usesExpiryWindow` 的家必须有 `creditPackages`（同一份数据）」——
     * 两者读的是同一批 `packages[]`，只开前者会让账号卡片**不展示逐包列表**，
     * 用户看得到「永久 / 长期 / 临期」三档合计，却看不到是**哪几笔**构成的。
     *
     * ⚠️ 本次补上是有实据的：`minimax-credits.ts` 已把 `packages[]` 从硬编码
     * `[]` 改为**逐条 `details[]` 各成一包**（带 `deductionEndTime`），
     * 卡片上「2/2 个资源包有效」这句因此有了真实内容。
     */
    creditPackages: true,
    settingsNamespace: "llm-minimax",
    channel: true
  },
  {
    /**
     * MiniMax Code **国际版**（`minimaxintl`）。
     *
     * ⚠️ 与上面的国内站**共用全部** `src/minimax*.ts` 实现（适配器 / 认证服务 /
     *    OAuth / 积分 / 消息序列化），差异只在 `src/minimax-product.ts` 的
     *    `MINIMAX_INTL` 常量里（主机 / region / ref 前缀）。
     *
     * ⚠️ **`rateLimit` 刻意不写 false**：两站共用同一个 `MinimaxAdapter`，而它
     *    自 issue IKJW32 起会写 `modelRateLimits`（额度 24h / 限流 1h）⇒ 缺省
     *    `true` 是**正确**的，且必须同时进 `probeById` 与
     *    `WRITES_RATE_LIMIT_PROVIDERS`（否则标记写进去却永远清不掉）。
     *
     * ⚠️ **验证状态如实标注**（2026-10-16 合并审计修正 —— 原文写「三项未真机验证」
     *    并指向一个**并不存在**的「未实测清单」，与 `src/minimax-product.ts`
     *    文件头的「✅ 已真机验证」互相否定）：推理路径与签到/积分端点形状
     *    **已真机验证通过**（2026-10-15，真实国际站账号；见该文件头的实测表与
     *    `tests/e2e/minimaxintl-probe.e2e.spec.ts`）。**只有兜底模型表**未按国际站
     *    远端采集（与国内站共用同一份，仅远端失败时兜底）。
     */
    id: "minimaxintl",
    label: "MiniMax Code (国际版)",
    displayName: "MiniMax Code (国际版)",
    logoClass: "minimaxintl",
    credits: { balance: true, dailyCheckin: true },
    // ⚠️ 与中国版**同因同日**补登记（2026-10-20）：两站共用同一个
    //    `fetchMinimaxCreditBalanceDetailed`，后端解析补齐后两边都该亮分档与锁定。
    //    ⚠️ 国际站另有**地理分流**风险：`agent.minimax.io` 会 307 到中国站，
    //    而中国站不认国际站 token ⇒ 余额查询恒失败。故折算原语 `minimaxExpiry`
    //    必须透传 `xff`（见 `aggregate-expiry.ts` 该函数的注释与
    //    `src/index.ts` 的 `minimaxXff: () => pool.minimaxXff()`）——
    //    漏传的后果正是「面板能刷新、聚合候选却恒折算失败」。
    usesExpiryWindow: true,
    permanentLock: true,
    // ⚠️ 同国内站：`usesExpiryWindow` 必须与 `creditPackages` 同时登记
    //    （`provider-registry.spec.ts` 有从能力事实派生的守卫，只开前者会让
    //    账号卡片不展示逐包列表）。两站共用同一个 `MinimaxAdapter` 与同一份
    //    `fetchMinimaxCreditBalance`，`packages[]` 已由逐条 `details[]` 产出。
    creditPackages: true,
    settingsNamespace: "llm-minimaxintl",
    channel: true
  },
  {
    id: "zcode",
    label: "ZCode (智谱)",
    displayName: "ZCode (智谱)",
    logoClass: "zcode",
    // ⚠️ 量纲是 **token 而非积分** —— 能力矩阵回答的是「有没有这项能力」，
    //    不是「量纲是否一致」；量纲差异在面板与 RPC 层如实标注。
    credits: { balance: true, dailyCheckin: true },
    autoCheckinExcluded: true,
    settingsNamespace: "llm-zcode",
    channel: true
  },
  {
    id: "opencode",
    label: "OpenCode",
    displayName: "OpenCode",
    logoClass: "opencode",
    // ⚠️ `balance: true` 但语义**不是余额**而是「**通道可用性**」：Zen 没有公开的
    //    余额 API（15 个候选路径全 404），故徽标展示我们真正测得到的东西
    //    （每个通道当前是否可用、是否处于限额冷却），数据全来自本地、零网络请求。
    //    早期登记为 false 曾把**整个徽标挡死**（组件第一件事就是判这个布尔）。
    credits: { balance: true, dailyCheckin: false },
    // ⚠️ 无 settingsNamespace：它不在老契约的 namespace 清单里。
    channel: true
  },
  {
    id: "gemini",
    label: "Gemini Code Assist",
    displayName: "Gemini Code Assist",
    logoClass: "gemini",
    // ⚠️ 不登记 dailyCheckin：Cloud Code 免费线是**纯配额制**，
    //    没有可调用的签到/领取端点（签到是服务端按日自动发放的）。
    credits: { balance: true, dailyCheckin: false },
    // ⚠️ 与 loomy 同值但**理由不同**：它确实会回 429、适配器也确实写
    //    `modelRateLimits`，但限流是**服务端配额窗口制** —— 本地标记清掉、
    //    重测通过，配额本身一点没恢复，下一次请求立刻又是 429。
    //    于是这组按钮只剩「白烧配额」与「把受限账号放回池里再撞一次」两种副作用。
    rateLimit: false,
    accountTest: true,
    settingsNamespace: "llm-gemini",
    channel: true
  },
  {
    id: "officeace",
    label: "OfficeAce",
    displayName: "OfficeAce",
    logoClass: "officeace",
    // ⚠️ **有**积分余额：数据来自云侧 `GET /v1/subscription`（V11 签名直读，
    //    与果办界面右上角同源同口径，2026-10-12 扣减实锤），**不依赖 OfficeAce 客户端**。
    //
    // ⚠️ `dailyCheckin: false` 但**该渠道确实有签到** —— 这里是**故意**不登记 true：
    //    签到走的是云侧 `POST /v1/subscription/bonus/claim`，且果办客户端的实现是
    //    「订阅页一挂载就自动领、**UI 上没有按钮**」（源码 `SubscriptionStateProvider`
    //    用「年+月+日+时」去重，每小时最多一次）。
    //    故本渠道的签到在**拉余额时自动完成**（见 `officeace-auth.ts` 的
    //    `maybeClaimBonus`）—— 登记成 true 会让面板渲染一个手动签到按钮，
    //    而它背后的 `credits.claim` RPC 对本渠道没有意义（真正的领取是自动的）。
    //    ⚠️ 语义：该字段表达「是否存在**手动**签到入口」，不是「有没有签到收益」。
    credits: { balance: true, dailyCheckin: false },
    // ⚠️ 余额响应里每个积分包都带到期时间（订阅套餐包无固定到期 = 永久桶，
    //    签到 / 活动包有明确到期）⇒ 可按 `deductionEndTime` 分「永久 / 长期 / 临期」三档。
    creditPackages: true,
    // ⚠️⚠️ **2026-10-15 之前这是一个哑锁**（Gitee issue IKLTHB 第 ① 条）：
    //    登记成 true 让面板渲染出开关、并逐字承诺「这类积分用尽后将没有可用账号」，
    //    而全仓**只有** `credential-resolver.ts` 的 buddy / loomy 两个分支读过
    //    `permanentLocked()` ⇒ 开关写进 `permanent-locks.json` 后行为与关闭**完全一致**
    //    （用户照旧烧永久套餐包）。现已由 `officeace-lock.ts` 补齐执行路径
    //    （锁定 + 只剩不会近期作废的桶 ⇒ 抛错，**绝不回落池**），
    //    并由 `permanent-lock-execution.spec.ts` 守住「凡 permanentLock: true 的渠道
    //    都必须有一条真的会读锁定表的执行路径」。
    permanentLock: true,
    // ⚠️ 判据是「逐包到期时间是否距今天数 < 窗口」，与 buddy 系**同口径**
    //    （`splitOfficeAceCreditsByExpiry` 与 `splitBuddyCreditsByExpiry` 逐格同构）；
    //    窗口复用 `DSH_BUDDY_EXPIRING_WINDOW_DAYS`（默认 15 天），
    //    与 `credits.permanentLock` RPC 回传给面板的 `windowDays` **同源**
    //    （面板文案与实际筛号必须是同一个数）。
    usesExpiryWindow: true,
    // ⚠️ `rateLimit: false` 的**真实理由**（2026-10-13 合并审计实测订正）：
    //    本适配器**根本不写** `modelRateLimits`（`officeace-adapter.ts` 里
    //    `modelRateLimits` / `updateModelRateLimit` / `markLimited` **零命中**，
    //    `provider-runtime-wiring.spec.ts` 也把它登记为空数组）⇒
    //    账号永远没有标记可清 ⇒ 两个按钮点下去**零请求、零清除**（恒惰性）。
    //    ⚠️ 此前这里写的是「它确实会回 429、适配器也写 `modelRateLimits`，
    //    但限流由华为云 MaaS 侧按账号配额管理」——**那句失实**（前半个分句是错的），
    //    真实判据与 accio 同因（「根本没有这组按钮的作用对象」），
    //    与 loomy / gemini 的「会写但清不掉」**不是同一回事**。
    rateLimit: false,
    settingsNamespace: "llm-officeace",
    channel: true
  },
  {
    id: "accio",
    label: "Accio (阿里)",
    displayName: "Accio (阿里)",
    logoClass: "accio",
    // ⚠️ 如实登记：Accio **没有签到端点** —— 每日 200 积分由**登录**触发服务端
    //    发放（`DAILY_REWARD`，24h 有效、不累积），没有可调用的签到 API。
    //    故 `dailyCheckin` 显式写 false（省略与 false 行为一致，但显式写让
    //    「想过这件事」在代码里可见）。
    //    ⚠️ **面板里也没有「刷新每日额度」入口**（2026-10-13 修订）：早先这里写过
    //    「面板另有一个 accio 专属入口，本质是重新登录」，那条承诺**未兑现**。
    //    重新登录**既有**账号需要宿主侧新增 RPC —— 现有的 `account.create` 每次都用
    //    `${provider}-${shortId()}` 现造账号 id 与凭据 ref（`src/jet-hub-rpc.ts`），
    //    拿它当重登录用会多出一条幽灵账号、而原账号额度一点没刷新；账号的 `region`
    //    也没下发给客户端；`login.poll` 对已登录账号第一秒就返回 `done: true`。
    //    ⇒ **该入口尚未实现**，客户端只做诚实展示（三类积分桶 + 重置倒计时 +
    //    「删除该账号后重新登录」这条手动路径），不渲染任何点不动的控件。
    credits: { balance: true, dailyCheckin: false },
    // ⚠️⚠️ **`rateLimit` 已于 2026-10-18 由 `false` 改回 `true`**（issue IKM3ZV 修复）。
    //    判据是 registry 自己的落地问法：「这个按钮点下去，能不能让用户**少**受限
    //    一次？」—— 而**当时**答否，两条都不满足：
    //    ① 适配器不写 `modelRateLimits` ⇒ 账号永远没有标记可清；
    //    ② `src/index.ts` 的 `probeById` 没有它的条目 ⇒ 「重测」零请求、零清除。
    //    接上请求级换号 + 冷却（`accio-adapter.ts` 的 `markCurrentAccount`，
    //    额度至 UTC+8 当日 24:00 / 限流 1h）后 ① 已不成立，② 同步登记 ⇒ 本行翻转。
    //
    // ⚠️⚠️ **这三处必须同改**（本陷阱在本仓库已复发过多次）：
    //    本行 + `src/index.ts` 的 `probeById` + `tests/helpers/provider-sets.ts`
    //    的 `WRITES_RATE_LIMIT_PROVIDERS`。漏任一处 ⇒ 标记写进去却永远清不掉
    //    （用户点「重测」报「没有探测适配器」）。三者由 `provider-runtime-wiring.spec.ts`
    //    的 probe 域守卫**双向**比对锁死（漏一家 / 多一家都点名变红）。
    //
    // ⚠️ 与 loomy / gemini / officeace 各自的 `rateLimit: false` **理由不同**：
    //    那三家是「真会限流、但按钮管辖不到 / 根本没有作用对象」；accio 现在是
    //    「真的会写标记，且探测适配器已登记」⇒ 是**实打实可用**的入口。
    rateLimit: true,
    settingsNamespace: "llm-accio",
    channel: true
  },
  {
    id: "astudio",
    label: "AStudio (讯飞)",
    displayName: "AStudio",
    logoClass: "astudio",
    // AStudio 每日奖励签到对接 client-popups/pending（DAILY_REWARD_DIALOG）与
    // client-popups/complete 领取流程 ⇒ dailyCheckin 启用为 true。
    credits: { balance: true, dailyCheckin: true },
    // ⚠️ rateLimit: false —— 判据同 accio（registry 落地问法「点下去能不能让用户少受限一次？」）：
    //    astudio-adapter 不写 modelRateLimits，且刻意不进 src/index.ts 的 probeById
    //    （probeById 被守卫锁成「恰好是会写标记的家」）⇒ 两个按钮恒为惰性。
    //    将来接上请求级换号+冷却时必须同时改回 true 并进 probeById + WRITES_RATE_LIMIT_PROVIDERS。
    rateLimit: false,
    // ⚠️ **`creditPackages: true`**（2026-10-20 用户报障补）：本字段决定**账号名 hover
    //    是否列出资源包**（`plugin-src/client/credits-capabilities.js` 的
    //    `supportsCreditPackageList` 直接读它）。缺它 ⇒ 积分行只显示
    //    「1/4 个资源包有效」而 **hover 看不到每个包与到期时间**，与其它 provider 不一致
    //    （用户报障原文：「hover 应该能看到没过期的资源包」）。
    //    依据：`buildAstudioBalance`（`astudio-credits.ts`）**已经**把四个池逐包解析出了
    //    到期时间（`member` / `buy` / `activity` / `spark` 各自的 `*NextExpireTime`）
    //    ⇒ 数据本来就齐，此前只是没声明。
    creditPackages: true,
    // ⚠️ **2026-10-20 补登记：三档分档（永久/长期/临期）此前完全没生效**。
    //
    // `/points/balance` 实测**确实下发**到期时间：`activityNextExpireTime`
    // = `"2026-11-20T01:50:14"`（会员/购买两池同形，字段名 `*NextExpireTime`）。
    // 但漏登记本字段会让 `jet-hub-rpc.ts` 不回传 `windowDays`
    // （判据 `descriptorOf(req.provider)?.usesExpiryWindow === true`），
    // 客户端 `splitCreditsByExpiry` 拿到 `windowDays === undefined` ⇒
    // `normalizeWindowDays2` 返回 `null` ⇒ **整个分档返回 `null`**
    // ⇒ 胶囊只剩「合计」，永久绿/长期黄/临期红三行一个都不渲染。
    // ⚠️ 漏登记的症状是**静默的**（无报错、无日志），与 officeace / autoclaw
    //    当初同一根因；新增带到期时间的渠道时必须一并登记本字段。
    // ⚠️ PR !134 独立补登了同一字段（2026-10-21 用户报障「星火 25000 不显示」，
    //    注释称「四个池都带 `*NextExpireTime`」—— member / buy / activity / spark）。
    //    合并时保留 master 这份（依据 `/points/balance` 实测原文），并保留
    //    PR !134 带来的**客户端侧**修法（`packageExpiryMs` 归一 + 独立池摘出）——
    //    那两处才是「25000 不显示」的另一半根因，registry 登记只是另一半。
    usesExpiryWindow: true,
    // ⚠️ **2026-10-20 补登记：永久积分锁定**。
    //
    // 判据同 buddy 系（`permanentLock` ⇒ Jet Hub 账号卡片出现「锁定永久积分」开关，
    // 锁后 `credential-resolver.ts` 的 `allowPermanent` 变 false ⇒ 只有「窗口内到期」
    // 的积分包可消耗，长期/永久积分被保住）。astudio 的三个池**各自带到期时间**
    // ⇒ 与 buddy 系同形，该语义可如实成立（不是假开关）。
    // ⚠️ 与 `usesExpiryWindow` / `WIRED_EXPIRY_PROVIDERS` / `createProviderExpiry()`
    //    的 `astudioExpiry` 是**四件不同的事**，不能互相替代：
    //    · `usesExpiryWindow` ⇒ 面板三行分档
    //    · `permanentLock`     ⇒ 锁定开关 + 选号时的 `allowPermanent`
    //    · `WIRED_EXPIRY_PROVIDERS` ⇒ 聚合候选可见性
    //    · `astudioExpiry`     ⇒ 聚合时如何折算到期时刻
    permanentLock: true,
    settingsNamespace: "llm-astudio",
    channel: true
  },
  {
    id: "autoclaw",
    label: "AutoClaw (智谱)",
    displayName: "AutoClaw (智谱)",
    logoClass: "autoclaw",
    credits: { balance: true, dailyCheckin: true },
    // ⚠️⚠️ **2026-10-17 审计修正：本渠道「按批次分档」是尽力而为，不是保证**。
    //
    // 事实链（三条缺一，结论就反了）：
    // ① `autoclaw-credits.ts` 用**流水批次包**替换钱包包，逐包带 `deductionEndTime`
    //    （毫秒，与 officeace / buddy 同单位）—— 钱包接口本身没有任何到期字段；
    // ② ⚠️ **流水的 `amount` 是「历史发放额」，不是「该批次当前剩余额」** ——
    //    上游**没有**「该批次已消耗多少」这一腿（对照 `trae-credits.ts` 的
    //    `remaining = creditsLimit - used`：两腿都在才算得出剩余；本渠道只有发放那一腿）。
    //    ⇒ 用户**消耗过积分后**，未过期批次之和 ≠ `total_balance`；
    // ③ 因此下游以「批次和 == `total_balance`」为**守恒安全网**，不守恒即回退钱包包
    //    （总额与长期数仍正确，只是**没有**临期档）⇒ 临期档只在恰好守恒的那次轮询出现。
    //
    // ⇒ 本行是「把 `windowDays` 回传给客户端，使分档行在有批次包时能渲染」的
    //    **能力开关**，不是数据保证。
    // ⚠️ 与 `src/aggregate-expiry.ts` 的 `autoclawExpiry` 注释口径一致：
    //    聚合折算恒为 `NEVER`（钱包包无 `deductionEndTime`），两处不冲突。
    creditPackages: true,
    // ⚠️ 与 buddy / officeace 同口径（按到期时间分桶，窗口复用
    //    `DSH_BUDDY_EXPIRING_WINDOW_DAYS`）。**必须登记**：查表分派只认这个
    //    标记回传 `windowDays`，漏登记的症状是「胶囊只有合计、没有三档带色行」
    //    —— 与 officeace 当初（`officeace 必须回传 windowDays`）同一根因。
    // ⚠️ 「每日红 + 刷新倒计时」**不适用于本渠道**：那套语义
    //    （`DAILY_POOL_NAMES = ['每日赠送','每日积分']`，**精确相等**匹配，见
    //    `plugin-src/client/credit-expiry.js`）是 Loomy / Raccoon 那种
    //    **当日重置池**（未用完随重置作废）；AutoClaw 的每日签到积分是发放进余额、
    //    按批次各自到期 —— 隐藏池（服务端 `display:false`）已在解析器滤掉，
    //    流水批次的包名取服务端描述（实测「每日签到」**不等于**「每日积分」）
    //    ⇒ 两条路径都不再命中那份名单，「每日 0」红字消失。
    usesExpiryWindow: true,
    /**
     * ⚠️ **2026-10-21 补齐**（用户明确要求「补锁定开关」）。
     *
     * ## 为什么本家需要它
     *
     * `autoclaw-credits.ts` 的批次映射里有一条**代码分支**：`wallet_expires_at`
     * 缺失 / `<= 0` 的发放 ⇒ 进 `permanentByLabel` ⇒ **不带 `deductionEndTime`**
     * （= 永久桶）。⇒ 只要上游下发那种条目，就有永不作废的积分需要保护。
     * 补登记前：`supportsPermanentLock()` 为 false ⇒ 按钮**不渲染**、
     * `credits.permanentLock` RPC 直接 `bad-request` ⇒ 用户无从保护。
     *
     * ⚠️⚠️ **前提强度如实标注（2026-10-21 二轮审计）**：该分支**结构上可达、
     * 但零实测**。仓库内唯一一次流水字段完整性实测（`5fbe7ab`）结论是
     * 「**28/28 全带 `wallet_expires_at`**」，方向上**否定**该形态存在。
     * ⇒ 若上游恒带到期字段，本家的永久桶**恒为空**，这个开关**永不产生实际效果**
     *（但也不会出错 —— 它只是把已存在的分档能力接上，与仓库 11 家同构）。
     * **不得**据此声称「本家确实有永久桶」。
     *
     * ## ⚠️⚠️ 与 buddy 系的取舍**不同源**，别照抄那两行
     *
     * | | buddy 系 | AutoClaw |
     * |---|---|---|
     * | `rateLimit` | 省缺（true） | **false**（不写 `modelRateLimits`、不在 `probeById`） |
     * | 请求级换号 | 有 | **刻意没有** |
     * | 账户「每日红」语义 | 有 | **不适用**（每日签到积分是发放进余额、按批次到期） |
     *
     * ⇒ 本家的锁定只作用于「**按余额分档选号**」这一层，不涉及换号冷却
     *   （它本来就没有）。这正是 `balance: { kind: 'buddy' }` 能直接套用的原因：
     *   分档判据（`splitBuddyCreditsByExpiry`）只读通用的
     *   `packages[].{active, remaining, deductionEndTime}`，**与 provider 无关**。
     *
     * ## 四处同改（缺一即静默失效或假开关）
     *
     * 1. **本行**（`permanentLock`）——决定按钮是否渲染、RPC 是否放行；
     * 2. `src/index.ts` 的 `balance: { kind: 'buddy', selector, lockedError }` 接线
     *    ——**缺它按钮在、点了不拦**（假开关，比没有按钮更糟：`credential-resolver`
     *    的 `allowPermanent` 读不到，锁定对选号完全无影响）；
     * 3. `autoclawLockedError` 文案（本家池名与 buddy 的「服务端资源包」不同）；
     * 4. `tests/unit/autoclaw-lock-wiring.spec.ts` 的三层守卫。
     *
     * ⚠️ `autoclawintl` **同因同状态**（两站共用全部实现，只差 product 常量），
     *    两处必须同时登记 —— 漏国际站的症状是「只登国际站的用户没有锁定按钮」。
     */
    permanentLock: true,
    rateLimit: false,
    settingsNamespace: "llm-autoclaw",
    channel: true
  },
  {
    /**
     * **AutoClaw 国际版**（`autoglm-api.autoglm.ai`）。
     *
     * ⚠️⚠️ **为什么是独立 provider 而不是 autoclaw 的站点参数**
     *    （判据与 `minimaxintl` 完全同款，见 `src/minimax-product.ts` 文件头）：
     *
     * | 判据 | 国内 | 国际 |
     * |---|---|---|
     * | 账号体系 | 手机号 / `7c54a9ac…`（UUID） | 邮箱 / `2c99dc99…` |
     * | API 主机 | `autoglm-acceleration-api.zhipuai.cn` | `autoglm-api.autoglm.ai` |
     * | 登录方式 | 短信验证码 | **Z.ai OAuth** |
     *
     *    实测佐证（2026-10-20）：拿国内 token 打国际基址，
     *    `wallets` / `user-profile` 一律 `410000 用户未登录`、
     *    推理 `401 Invalid token` ⇒ 用户体系**物理隔离**。
     *
     * ⚠️ **实现零复制**：`AutoclawAuth` / `registerAutoclawLlm` / 积分与批次逻辑
     *    全部复用国内版那一套，只有 `AUTOCLAW_INTL` 配置不同
     *    （与 `minimaxintl` 同纪律：复制会让同类缺陷修两遍）。
     *
     * ⚠️ **当前登录尚未接入**：Z.ai OAuth 的 `state.nh` 来源未知
     *    （`client_id` 与 `state.dh = SHA256(deviceId)` 已逆向确认）。
     *    在打通之前本渠道只能手工注入 token 使用。
     */
    id: "autoclawintl",
    label: "AutoClaw (国际版)",
    displayName: "AutoClaw (国际版)",
    logoClass: "autoclaw",
    credits: { balance: true, dailyCheckin: true },
    /**
     * ⚠️ **必须与国内版同格**（2026-10-20 审计 P1 补）。
     *
     * 漏它的后果是**用户可见**的：国际版账号卡片 hover 看不到资源包明细
     * （与 astudio 2026-10-20 那次用户报障同型）。两家共用同一份
     * `autoclaw-credits.ts`，批次包同样带 `deductionEndTime` ⇒ 能力应当一致。
     *
     * ⚠️⚠️ 这个字段曾经**漏了却全绿**：`provider-registry.spec.ts` 把它写成
     *    **手写名单快照**，于是「漏项」被固化成了期望值 —— 补上它反而变红
     *    （审计实测：`expected [...(10)] to deeply equal [ Array(9) ]`）。
     *    ⇒ 同一次整改把那条断言改成**从能力事实派生**（见该 spec 的注释）。
     */
    creditPackages: true,
    // 分档 / 临期逻辑与国内同源（同一份 `autoclaw-credits.ts`）。
    usesExpiryWindow: true,
    // ⚠️ **与国内站同因同日补齐**（2026-10-21，用户要求「补锁定开关」）。
    //    两站共用全部实现，只差 product 常量 ⇒ 有没有永久桶、要不要锁**逐字相同**
    //    （见国内站那一段的长注释，不重复）。
    //    ⚠️ **两站必须各占一项**：`PERMANENT_LOCK_PROVIDERS` 按 provider id，
    //    漏 `autoclawintl` 会让**只登国际站**的用户没有锁定按钮（与 minimaxintl 同因）。
    permanentLock: true,
    rateLimit: false,
    settingsNamespace: "llm-autoclawintl",
    channel: true
  },
  {
    id: "modelscope",
    label: "ModelScope (魔搭)",
    displayName: "ModelScope (魔搭)",
    logoClass: "modelscope",
    // ⚠️⚠️ **2026-10-17 更正：本条已从 `false` 改为 `true`**（带真实 Key 实测）。
    //
    // 上面那段「12 条候选路径全 404 ⇒ 没有额度查询 API」的结论**是错的**，
    // 错在**前缀**：那批探测只试过 `/api/v1/*` 与 `/v1/*`，而真端点在
    // **`/openapi/v1/`** ——
    //
    //     GET https://www.modelscope.cn/openapi/v1/magicubes/balance
    //     Authorization: Bearer <ms-…>
    //     → {"success":true,"data":{"total_balance":281,"available_balance":281,
    //        "frozen_amount":0}}
    //
    // ⚠️ 用错前缀时它落在 SPA catch-all 上（SPA 对**任何**路径都回 200 HTML ——
    //    本仓库在 accio 记过同款「假 200」），两种表现都会让人误判成「不存在」。
    //
    // ⚠️⚠️ **「它是真余额」的判据是实测会随消耗下降**，不是字段名像余额：
    //    实测 281 → 发 2 次推理（旗舰档每次扣 2 魔粒）→ 277，**恰好 -4**。
    //    对照组 `/api/v1/quota/status`（API Key 也能读）实测发 3 次推理后
    //    **逐字节不变** ⇒ 那是**任务奖励**（点赞/分享/绑定云账号），不是余额。
    //
    // ⇒ 不需要网页登录态、不需要采集 cookie、不需要起浏览器（三种认证实测：
    //    API Key 200 / 网页 cookie 200 / 无凭据 401 `InvalidAuthentication`，
    //    即它**确实在校验凭据**，符合仓库「目录能读 ≠ 凭据有效」的纪律）。
    //
    // ⚠️ **与 opencode 的关键差异**（别把两者当同一格）：opencode 的「余额」是
    // 本地派生的**通道可用性**（零网络）；魔搭是**云侧真读数**，走 `credits` 域的
    // `fetchBalanceDetailed`（三种失败的用户动作不同，故不用笼统的 `fetchBalance`）。
    credits: { balance: true, dailyCheckin: false },
    // ⚠️ 无签到：额度是**每日自动刷新**（每账号 250 魔粒、UTC+8 零点重置，
    //    旗舰档每次扣 2），**没有「领取」动作、也没有签到 API**。
    //    宿主侧 credits.claimAll 仍要显式回一句可读错误（见 jet-hub-rpc.ts），
    //    否则自动签到会把它记成 **failed** 而不是 **inactive**。
    //
    // ⚠️⚠️ **登记 `rateLimit: false`（用户要求，2026-10-17）** —— 这**不是**能力缺失，
    //    是**产品取舍**，两者的区别必须留在注释里：
    //
    //    - 能力上：魔搭确实会回 429，本适配器**确实会写** `modelRateLimits`
    //      （`modelscope-adapter.ts` 的 `modelscopeRetryAfterMs`），接线层也注入了
    //      `markLimited`（`index.ts`）；
    //    - 取舍上：用户不要「重测 / 重置」两个按钮，故关掉入口。
    //
    //    ⚠️⚠️ **代价（必须如实记录）**：冷却标记**仍会写进池**，只是用户**没法用按钮
    //    清除它** ⇒ 遇到 429 后只能等它自然过期，或删掉该账号重加。
    //    ⚠️ 与 loomy / gemini / officeace / accio 的 `rateLimit: false` **不同源**：
    //    那几家是「拿不到探测材料」（点了必然报「没有探测适配器」），魔搭是
    //    「探测材料齐全但入口刻意关闭」。**别把它当成漏登记**。
    //    ⚠️ 前两行那条「不登记 rateLimit：魔搭确实会回 429…」的旧注释已被本条取代。
    rateLimit: false,
    // ⚠️ 不登记 accountTest / creditPackages / permanentLock / usesExpiryWindow
    //    —— 全部省略 = false，与能力实情一致。
    // ⚠️ 不登记 settingsNamespace：它不在老契约（≤0.1.6）的 namespace 清单里。
    channel: true
  },
  {
    id: "codely",
    label: "Codely (Unity)",
    displayName: "Codely (Unity)",
    logoClass: "codely",
    // ⚠️⚠️ **登录已接线、推理链路未接的过渡态（2026-10-19）**：「新建账号」走
    //    设备码轮询（`src/codely-auth.ts`，与 Qoder / Cline 同款两步式，凭据落
    //    `CODELY_ACCOUNT_*`），**聊天 / 模型目录 / 续期尚未接线**。协议已从官方
    //    VS Code 插件 4.3.0 逆向 + 无凭据实探：
    //    - 设备码登录三步（已实测 200）：
    //      `POST /auth/device/initiate` `{provider:'unity', client_name:'codely-vscode',
    //      auth_from:'vscode-codely'}` → `{auth_request_token, user_code,
    //      verification_uri(_complete), interval:2, expires_in:900}`；
    //      `GET /auth/device/poll?auth_request_token=…` → pending 形状
    //      `{status:'pending', error:'authorization_pending', interval:2}`，
    //      状态机 `pending|slow_down|authorized(+authorization_code)|completed|denied|expired`
    //      （官方插件源码逐分支）；`POST /auth/device/exchange` `{authorization_code}`
    //      → `{access_token, refresh_token}`（插件源码）。
    //    - 刷新：`POST /auth/refresh` `{refresh_token}`（插件源码；**刻意未实现**，
    //      理由见 codely-auth.ts 模块头「为什么暂不实现 refresh」）。
    //    - 鉴权头：`Authorization: Bearer` + `X-User-Agent: codely-vscode/<ver>`（插件源码）。
    //    - 聊天：`POST /v1/chat/completions`（存在性已由 401/405 实测确认，报文未验证）。
    //    - 余额/积分：`/api/user/usage/summary`、`/api/points/check-in`（端点存在，未验证）。
    //
    //    ## 剩余接线清单（缺一处即静默失效，AGENTS.md 有先例）
    //    ① 本条 `channel` 改 `true`；② 删掉 `rateLimit: false`（恢复默认 true）并按实测
    //    决定 `credits.balance`；③ `src/index.ts`：import + `new CodelyAuth` +
    //    `registerCodelyLlm` + auth 注册表数组 + `JetHubAuths`（jet-hub-rpc.ts）加 `codely`
    //    键 + `refreshAccountCredential`（用 `/auth/refresh`）+ 适配器（chat/catalog）；
    //    ④ `AGGREGATE_CHANNELS`（aggregate-adapter.ts）；⑤ `SELF_HEAL_REFRESHABLE_PROVIDERS`
    //    （jet-hub-rpc.ts）；⑥ 测试侧：jet-hub-rpc-auth-wiring.spec.ts 的 `AUTH_SERVICE`
    //    表与计数、zcode-wiring.spec.ts 的豁免数组、tests/helpers/rpc-refresh.ts 的
    //    `REFRESH_PROVIDERS`、provider-registry.spec.ts 的 channel 计数与 rateLimit 清单、
    //    credits-capabilities.spec.ts 的限流清单。
    //    ⚠️ `REF_PREFIX_TO_PROVIDER`（jet-hub-store.ts）的 `CODELY` 前缀**本条已提前登记**
    //    （恢复表守卫按全量 registry 派生，channel:false 也逃不掉）。
    //
    //    ## 接线进度（2026-10-20）
    //    ⓪ 推理 ✅：**驱动官方 CLI 子进程**（签名密钥未取得，让官方客户端自己
    //       签名 —— 详见 `codely-adapter.ts` / `codely-cli.ts` 模块头）；端到端
    //       实测 4.0s 拿到非空 chunk（`codely-basic` 回复 "hello there"）。
    //    ① `channel: true` ⏸ **暂缓**（本行，2026-10-20）；✅ `rateLimit` 已于同日
    //       恢复缺省 true（换号 + 探测接线完成，见 `channel: false` 下方的说明）。
    //    ② `/auth/refresh` **端点已实测**（200、`refresh_token` 不轮换），实现待补。
    //    ③④⑤⑥ 见上方清单。
    //
    /**
     * ✅ `channel: true`（2026-10-22 A6 翻正）。
     *
     * ## 为什么原来是 `false`，现在为什么能翻
     *
     * 原注释写的是「推理已通但 `channel: true` 会点燃 9 个 spec / 11 条派生登记，先补齐再翻」。
     * ⚠️⚠️ 但那是**流程理由，不是产品理由** —— 2026-10-22 对抗审计指出：
     * `channel` 在**生产代码里零个读取点**（全仓普查，唯一消费者是 tests/），
     * 而 `false` 造成两个**用户可见**缺口：
     * - 它的模型**永不进聚合目录与轮换候选**（`AGGREGATE_CHANNELS` 缺它）；
     * - `credits-balance-self-heal.spec.ts` 用 `d.channel && d.credits.balance` 派生期望集合
     *   ⇒ codely 被**自动豁免**，那条专为「漏登记」而建的守卫对它**永不会红**。
     *
     * ⇒ 本次同步补齐全部派生登记（接线已完成：推理 / 目录 / 余额 / 签到 / 续期）：
     * `SELF_HEAL_REFRESHABLE_PROVIDERS`、`JetHubAuths.codely`、`AGGREGATE_CHANNELS`、
     * `WIRED_EXPIRY_PROVIDERS` + `createProviderExpiry()`、`modelAdapters`、以及四张 spec 的计数。
     *
     * ⚠️ **聚合轮换还差一块真实的东西**：Codely 的余额端点**不下发任何到期时间**
     * （`/api/user/usage/summary` 只有 `remaining_points` / `is_exhausted`；抽象成
     * `CreditPackage` 时 `expiredTime` 是**空串**—— 见 `codely-credits.ts`）。
     * 而聚合候选表的第一判据就是「临期档」。⇒ 本次**不把它加进**
     * `WIRED_EXPIRY_PROVIDERS`，理由是**上游没有这个数据**（不是「没接」），
     * 并在 `expiry-runtime-parity.spec.ts` 的豁免表逐字登记。
     * ⚠️ 上游一旦开始下发到期时间，只需补一个折算原语 + 两处登记。
     */
    channel: true,
    // ✅ `rateLimit` 缺省 true：请求级换号 + 冷却已接（`codely-adapter.ts` 的
    //    `updateModelRateLimit` 写点：402/预算耗尽 → UTC+8 次日 0 点、429 → 1h），
    //    `probeById.codely` 探测适配器同步挂上 ⇒「重测 / 重置」有真实作用对象。
    // ✅ `credits.balance: true`（2026-10-19 真凭据实测）：余额端点
    //    `GET /api/user/usage/summary` → `{remaining_points:"2400", is_exhausted:false, details:[…]}`
    //    —— ⚠️ 数字是**字符串**。原语在 `src/codely-credits.ts`。
    // ✅ `dailyCheckin: true`（2026-10-20 真凭据实测接通）：两步端点
    //    `POST /api/points/check-in/init`（查状态）→ `POST /api/points/check-in`（执行）；
    //    幂等判据是 `init` 的 `can_check_in`。原语 `claimCodelyDailyCheckIn`。
    credits: { balance: true, dailyCheckin: true }
  },
  {
    id: "aggregate",
    label: "聚合 (跨渠道)",
    displayName: "聚合 (跨渠道)",
    logoClass: "aggregate",
    // ⚠️ 如实登记为 false：它**没有自己的账号与余额** —— 复用各渠道的账号，
    //    积分与限流由各渠道自己管理。
    // ⚠️ 这不影响用量徽标：徽标对聚合的处理是「重定向到实际选中的渠道」，
    //    重定向发生在 `supportsCreditBalance` 门控**之前**。
    credits: { balance: false, dailyCheckin: false },
    channel: false
  }
]);
function descriptorOf(id) {
  return PROVIDER_REGISTRY.find((d) => d.id === id);
}
function creditCapabilitiesOf() {
  const out = {};
  for (const d of PROVIDER_REGISTRY) {
    out[d.id] = Object.freeze({
      balance: d.credits.balance,
      // ⚠️ `dailyCheckin` 也是**可省略**字段（见 `CreditsCapability` 的注释：
      //    raccoon 刻意不登记它），故按本函数「缺失即缺失」的规则一并条件拷贝
      //    —— 这样「raccoon 没有签到端点」这件事在派生表里也是**可见的缺失**，
      //    而不是一个与 `false` 无法区分的 `undefined`。
      //    判据侧一律 `=== true`（`supportsDailyCheckin`），故行为不变。
      ...d.credits.dailyCheckin === void 0 ? {} : { dailyCheckin: d.credits.dailyCheckin },
      ...d.credits.onboardingTasks === void 0 ? {} : { onboardingTasks: d.credits.onboardingTasks },
      ...d.credits.subscriptionQuota === void 0 ? {} : { subscriptionQuota: d.credits.subscriptionQuota }
    });
  }
  return out;
}

// plugin-src/client/credits-capabilities.js
var CREDITS_CAPABILITIES = Object.freeze(creditCapabilitiesOf());
var RATE_LIMIT_CAPABILITIES = Object.freeze(
  Object.fromEntries(
    PROVIDER_REGISTRY.filter((d) => d.rateLimit === false).map((d) => [d.id, Object.freeze({ rateLimit: false })])
  )
);
function supportsRateLimit(provider) {
  return RATE_LIMIT_CAPABILITIES[provider]?.rateLimit !== false;
}
var ACCOUNT_TEST_CAPABILITIES = Object.freeze(
  Object.fromEntries(
    PROVIDER_REGISTRY.filter((d) => d.accountTest === true).map((d) => [d.id, Object.freeze({ test: true })])
  )
);
function supportsAccountTest(provider) {
  return ACCOUNT_TEST_CAPABILITIES[provider]?.test === true;
}
var PERMANENT_LOCK_EXPIRING_WINDOW_DAYS = 15;
function supportsPermanentLock(provider) {
  return descriptorOf(provider)?.permanentLock === true;
}
function supportsCreditPackageList(provider) {
  return descriptorOf(provider)?.creditPackages === true;
}
function permanentLockCopy(provider, windowDays) {
  if (descriptorOf(provider)?.usesExpiryWindow === true) {
    const days = normalizeWindowDays(windowDays);
    return Object.freeze({
      days,
      lockTitle: `锁定永久积分后只消耗「${days} 天内到期」的积分包（那部分再不用就作废）。这类积分用尽后将没有可用账号。点此锁定。`,
      lockedTitle: `当前已锁定永久积分：只消耗「${days} 天内到期」的积分包。这类积分用尽后将没有可用账号。点此解锁。`,
      lockedNotice: `已锁定永久积分：只消耗 ${days} 天内到期的积分包。这类积分用尽后将无可用账号。`,
      unlockedNotice: `已解锁永久积分：${days} 天内到期的积分用尽后，会继续使用更晚到期的积分。`
    });
  }
  return Object.freeze({
    days: null,
    lockTitle: "锁定永久积分后只消耗每日赠送额度（今日额度用尽即无可用账号），可保住永久积分。点此锁定。",
    lockedTitle: "当前已锁定永久积分：只消耗每日赠送额度。今日额度用尽后将没有可用账号。点此解锁。",
    lockedNotice: "已锁定永久积分：只消耗每日赠送额度。今日额度用尽后将无可用账号。",
    unlockedNotice: "已解锁永久积分：今日额度用尽后会继续使用永久积分。"
  });
}
function normalizeWindowDays(value) {
  if (value === void 0 || value === null || value === "") {
    return PERMANENT_LOCK_EXPIRING_WINDOW_DAYS;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : PERMANENT_LOCK_EXPIRING_WINDOW_DAYS;
}
function supportsCreditBalance(provider) {
  return CREDITS_CAPABILITIES[provider]?.balance === true;
}
function supportsDailyCheckin(provider) {
  return CREDITS_CAPABILITIES[provider]?.dailyCheckin === true;
}
function checkinProviders() {
  return Object.keys(CREDITS_CAPABILITIES).filter(supportsDailyCheckin);
}
function supportsOnboardingTasks(provider) {
  return CREDITS_CAPABILITIES[provider]?.onboardingTasks === true;
}
function supportsSubscriptionQuota(provider) {
  return CREDITS_CAPABILITIES[provider]?.subscriptionQuota === true;
}

// plugin-src/client/account-order.js
function orderAfterDrop(ids, sourceId, targetId, position = "before") {
  const from = ids.indexOf(sourceId);
  const to = ids.indexOf(targetId);
  if (from === -1 || to === -1 || from === to) return null;
  const next = [...ids];
  next.splice(from, 1);
  const targetIndex = next.indexOf(targetId);
  next.splice(position === "after" ? targetIndex + 1 : targetIndex, 0, sourceId);
  return next;
}
function dropPositionFromPointer(clientY, rect) {
  if (!rect || !rect.height) return "before";
  return clientY > rect.top + rect.height / 2 ? "after" : "before";
}

// plugin-src/client/opencode-proxy-modal.js
var React = __toESM(require("react"), 1);
var LOCAL_PORT_PRESETS = [
  { port: 7897, label: "7897", url: "http://127.0.0.1:7897", hint: "Clash / mihomo 混合端口" },
  { port: 7890, label: "7890", url: "http://127.0.0.1:7890", hint: "Clash 旧版 HTTP 端口" },
  { port: 1080, label: "1080", url: "socks5://127.0.0.1:1080", hint: "SOCKS5" },
  { port: 10808, label: "10808", url: "socks5://127.0.0.1:10808", hint: "SOCKS5（v2rayN 等）" }
];
function guessMode(url) {
  if (!url) return "local";
  if (url.startsWith("socks5")) return "socks5";
  if (url.includes("127.0.0.1") || url.includes("localhost")) return "local";
  return "http";
}
var MODES = [
  { id: "local", label: "本地代理端口", hint: "本机已跑着 Clash / v2rayN 之类，直接填它的端口" },
  { id: "http", label: "HTTP(S)", hint: "形如 http://user:pass@host:port" },
  { id: "socks5", label: "SOCKS5", hint: "形如 socks5://user:pass@host:port" }
];
function OpencodeProxyModal({ ctx, accountId, current, onClose }) {
  const [mode, setMode] = React.useState(guessMode(current));
  const [url, setUrl] = React.useState(current || "");
  const [busy, setBusy] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [error, setError] = React.useState("");
  const [result, setResult] = React.useState(null);
  const close = () => {
    if (onClose) onClose();
  };
  const save = async (value) => {
    setBusy(true);
    setError("");
    try {
      await ctx.rpc({ method: "opencode.setProxy", payload: { accountId, proxy: value } });
      close();
    } catch (err) {
      setError(err && err.message ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setTesting(true);
    setError("");
    setResult(null);
    try {
      const r = await ctx.rpc({ method: "opencode.testProxy", payload: { proxy: url } });
      setResult(r);
    } catch (err) {
      setError(err && err.message ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };
  const activeHint = (MODES.find((m) => m.id === mode) || {}).hint || "";
  return React.createElement(
    "div",
    {
      className: "dim-jh-modalOverlay",
      onClick: (e) => {
        if (e.target === e.currentTarget) close();
      }
    },
    React.createElement(
      "div",
      {
        className: "dim-jh-modal",
        role: "dialog",
        "aria-modal": "true",
        style: { maxWidth: "520px" }
      },
      React.createElement(
        "div",
        { className: "dim-jh-modalHead" },
        React.createElement("div", { className: "dim-jh-modalTitle" }, "设置出口代理"),
        React.createElement(
          "span",
          { className: "dim-jh-modalSubtitle" },
          current ? "当前：已配置" : "当前：直连（本机出口）"
        )
      ),
      // ⚠️ 这段提示是本功能的存在理由，必须说清「多账号 ≠ 多配额」。
      React.createElement(
        "p",
        { className: "dim-jh-modalHint" },
        "OpenCode 的免费通道按出口 IP 限流。不设代理时，本账号与其它未设代理的账号（以及匿名通道）共用同一个出口，也就是共用同一份额度；设置代理后该账号走独立出口。"
      ),
      // ⚠️ 内容必须放进 modalBody（flex:1; min-height:0; overflow-y:auto），
      // 否则弹窗较高时内容会被裁掉（见 jet-hub.js 既有 modal 的注释）。
      React.createElement(
        "div",
        { className: "dim-jh-modalBody" },
        React.createElement(
          "div",
          { className: "dim-jh-fieldRow" },
          MODES.map((m) => React.createElement(
            "label",
            { key: m.id, className: "dim-jh-radio" },
            React.createElement("input", {
              type: "radio",
              name: "opencode-proxy-mode",
              checked: mode === m.id,
              onChange: () => {
                setMode(m.id);
                setError("");
                setResult(null);
              }
            }),
            m.label
          ))
        ),
        React.createElement("p", { className: "dim-jh-hint" }, activeHint),
        mode === "local" && React.createElement(
          "div",
          { className: "dim-jh-presetRow" },
          LOCAL_PORT_PRESETS.map((p) => React.createElement("button", {
            key: p.port,
            type: "button",
            className: "dim-jh-btn",
            title: p.hint,
            onClick: () => {
              setUrl(p.url);
              setError("");
              setResult(null);
            }
          }, p.label))
        ),
        React.createElement("input", {
          className: "dim-jh-input",
          placeholder: mode === "socks5" ? "socks5://user:pass@host:port" : "http://user:pass@host:port",
          value: url,
          // ⚠️ 含认证信息时用 password 类型：代理口令不该裸显在屏幕上。
          type: url.includes("@") ? "password" : "text",
          onChange: (e) => {
            setUrl(e.target.value);
            setResult(null);
          }
        }),
        result && React.createElement(
          "p",
          { className: "dim-jh-hint" },
          `出口 IP ${result.exitIp}（${result.country || "未知地区"}）· ${result.latencyMs}ms`
        ),
        error && React.createElement("p", { className: "dim-jh-error" }, error)
      ),
      React.createElement(
        "div",
        { className: "dim-jh-modalActions" },
        React.createElement("button", {
          type: "button",
          className: "dim-jh-btn",
          disabled: testing || busy || url.trim().length === 0,
          onClick: test
        }, testing ? "测试中…" : "测试连接"),
        // 只有已配置过才显示「清除」：没配过就没有可清除的东西。
        current ? React.createElement("button", {
          type: "button",
          className: "dim-jh-btn",
          disabled: busy,
          onClick: () => save("")
        }, "清除代理") : null,
        React.createElement("button", {
          type: "button",
          className: "dim-jh-btn dim-jh-btnPrimary",
          disabled: busy || url.trim().length === 0,
          onClick: () => save(url)
        }, "保存"),
        React.createElement("button", { type: "button", className: "dim-jh-btn", onClick: close }, "取消")
      )
    )
  );
}
function GeminiProxyModal({ ctx, accountId, current, onClose }) {
  const [mode, setMode] = React.useState(guessMode(current));
  const [url, setUrl] = React.useState(current || "");
  const [busy, setBusy] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [error, setError] = React.useState("");
  const [result, setResult] = React.useState(null);
  const close = () => {
    if (onClose) onClose();
  };
  const save = async (value) => {
    setBusy(true);
    setError("");
    try {
      await ctx.rpc({ method: "gemini.setProxy", payload: { accountId, proxy: value } });
      close();
    } catch (err) {
      setError(err && err.message ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setTesting(true);
    setError("");
    setResult(null);
    try {
      const r = await ctx.rpc({ method: "gemini.testProxy", payload: { proxy: url } });
      setResult(r);
    } catch (err) {
      setError(err && err.message ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };
  const activeHint = (MODES.find((m) => m.id === mode) || {}).hint || "";
  return React.createElement(
    "div",
    {
      className: "dim-jh-modalOverlay",
      onClick: (e) => {
        if (e.target === e.currentTarget) close();
      }
    },
    React.createElement(
      "div",
      {
        className: "dim-jh-modal",
        role: "dialog",
        "aria-modal": "true",
        style: { maxWidth: "520px" }
      },
      React.createElement(
        "div",
        { className: "dim-jh-modalHead" },
        React.createElement("div", { className: "dim-jh-modalTitle" }, "设置 Gemini 出口代理"),
        React.createElement(
          "span",
          { className: "dim-jh-modalSubtitle" },
          current ? "当前：已配置" : "当前：直连（本机出口）"
        )
      ),
      // ⚠️ 这段提示是本功能的存在理由，且必须**诚实**：不说清「系统代理不生效」，
      // 用户会以为自己开着 Clash 系统代理就万事大吉（浏览器能用 ≠ 插件能用）。
      React.createElement(
        "p",
        { className: "dim-jh-modalHint" },
        "Google 的登录与接口都在墙外。浏览器能打开授权页，是因为浏览器读系统代理；插件进程不读，所以「浏览器授权成功、面板里账号却一直不出现」是同一个原因。设置这里的代理后，该账号的登录、续期、积分与对话都会走它。"
      ),
      React.createElement(
        "div",
        { className: "dim-jh-modalBody" },
        React.createElement(
          "div",
          { className: "dim-jh-fieldRow" },
          MODES.map((m) => React.createElement(
            "label",
            { key: m.id, className: "dim-jh-radio" },
            React.createElement("input", {
              type: "radio",
              name: "gemini-proxy-mode",
              checked: mode === m.id,
              onChange: () => {
                setMode(m.id);
                setError("");
                setResult(null);
              }
            }),
            m.label
          ))
        ),
        React.createElement("p", { className: "dim-jh-hint" }, activeHint),
        mode === "local" && React.createElement(
          "div",
          { className: "dim-jh-presetRow" },
          LOCAL_PORT_PRESETS.map((p) => React.createElement("button", {
            key: p.port,
            type: "button",
            className: "dim-jh-btn",
            title: p.hint,
            onClick: () => {
              setUrl(p.url);
              setError("");
              setResult(null);
            }
          }, p.label))
        ),
        React.createElement("input", {
          className: "dim-jh-input",
          placeholder: mode === "socks5" ? "socks5://user:pass@host:port" : "http://user:pass@host:port",
          value: url,
          // ⚠️ 含认证信息时用 password 类型：代理口令不该裸显在屏幕上。
          type: url.includes("@") ? "password" : "text",
          onChange: (e) => {
            setUrl(e.target.value);
            setResult(null);
          }
        }),
        // ⚠️ **不说「出口 IP」**：这里测的是「能不能连上 Google」，
        // 回显 HTTP 状态码（400 也是通的，见宿主侧注释）。
        result && React.createElement(
          "p",
          { className: "dim-jh-hint" },
          `已连通 Google（HTTP ${result.status}）· ${result.latencyMs}ms`
        ),
        error && React.createElement("p", { className: "dim-jh-error" }, error)
      ),
      React.createElement(
        "div",
        { className: "dim-jh-modalActions" },
        React.createElement("button", {
          type: "button",
          className: "dim-jh-btn",
          disabled: testing || busy || url.trim().length === 0,
          onClick: test
        }, testing ? "测试中…" : "测试连接"),
        // 只有已配置过才显示「清除」：没配过就没有可清除的东西。
        current ? React.createElement("button", {
          type: "button",
          className: "dim-jh-btn",
          disabled: busy,
          onClick: () => save("")
        }, "清除代理") : null,
        React.createElement("button", {
          type: "button",
          className: "dim-jh-btn dim-jh-btnPrimary",
          disabled: busy || url.trim().length === 0,
          onClick: () => save(url)
        }, "保存"),
        React.createElement("button", { type: "button", className: "dim-jh-btn", onClick: close }, "取消")
      )
    )
  );
}
function QoderProxyModal({ ctx, accountId, current, provider, onClose }) {
  const isCn = provider === "qodercn";
  const [mode, setMode] = React.useState(guessMode(current));
  const [url, setUrl] = React.useState(current || "");
  const [busy, setBusy] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [error, setError] = React.useState("");
  const [result, setResult] = React.useState(null);
  const close = () => {
    if (onClose) onClose();
  };
  const save = async (value) => {
    setBusy(true);
    setError("");
    try {
      await ctx.rpc({ method: "qoder.setProxy", payload: { accountId, proxy: value } });
      close();
    } catch (err) {
      setError(err && err.message ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setTesting(true);
    setError("");
    setResult(null);
    try {
      const r = await ctx.rpc({
        method: "qoder.testProxy",
        // ⚠️ 必须把 provider 带上去：两站主机不同，探测错站点的结果是假阴性。
        payload: { proxy: url, provider: isCn ? "qodercn" : "qoder" }
      });
      setResult(r);
    } catch (err) {
      setError(err && err.message ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };
  const activeHint = (MODES.find((m) => m.id === mode) || {}).hint || "";
  return React.createElement(
    "div",
    {
      className: "dim-jh-modalOverlay",
      onClick: (e) => {
        if (e.target === e.currentTarget) close();
      }
    },
    React.createElement(
      "div",
      {
        className: "dim-jh-modal",
        role: "dialog",
        "aria-modal": "true",
        style: { maxWidth: "520px" }
      },
      React.createElement(
        "div",
        { className: "dim-jh-modalHead" },
        React.createElement(
          "div",
          { className: "dim-jh-modalTitle" },
          isCn ? "设置 Qoder（中国版）出口代理" : "设置 Qoder 出口代理"
        ),
        React.createElement(
          "span",
          { className: "dim-jh-modalSubtitle" },
          current ? "当前：已配置" : "当前：直连（本机出口）"
        )
      ),
      // ⚠️ 提示必须**分站诚实**：国际版在中国大陆基本连不上，中国版不设代理
      // 反而更快。写成一句通用话术会让中国版用户白配一条代理（多一跳、更慢），
      // 也会让国际版用户以为「不设置也能凑合」。
      React.createElement(
        "p",
        { className: "dim-jh-modalHint" },
        isCn ? "中国版（openapi.qoder.com.cn）通常直连就通，不设代理反而少一跳。只有在直连被限速或需要固定出口时才需要配这里。" : "Qoder 国际版（openapi.qoder.sh）在中国大陆被阻断：TCP 能连、TLS 握手被丢，表现为「转十秒然后 fetch failed」。插件进程不读系统代理，所以浏览器能用 ≠ 这里能用。设置代理后，该账号的登录、续期、积分与对话都会走它；也可以改用中国版账号（直连即可）。"
      ),
      React.createElement(
        "div",
        { className: "dim-jh-modalBody" },
        React.createElement(
          "div",
          { className: "dim-jh-fieldRow" },
          MODES.map((m) => React.createElement(
            "label",
            { key: m.id, className: "dim-jh-radio" },
            React.createElement("input", {
              type: "radio",
              name: "qoder-proxy-mode",
              checked: mode === m.id,
              onChange: () => {
                setMode(m.id);
                setError("");
                setResult(null);
              }
            }),
            m.label
          ))
        ),
        React.createElement("p", { className: "dim-jh-hint" }, activeHint),
        mode === "local" && React.createElement(
          "div",
          { className: "dim-jh-presetRow" },
          LOCAL_PORT_PRESETS.map((p) => React.createElement("button", {
            key: p.port,
            type: "button",
            className: "dim-jh-btn",
            title: p.hint,
            onClick: () => {
              setUrl(p.url);
              setError("");
              setResult(null);
            }
          }, p.label))
        ),
        React.createElement("input", {
          className: "dim-jh-input",
          placeholder: mode === "socks5" ? "socks5://user:pass@host:port" : "http://user:pass@host:port",
          value: url,
          // ⚠️ 含认证信息时用 password 类型：代理口令不该裸显在屏幕上。
          type: url.includes("@") ? "password" : "text",
          onChange: (e) => {
            setUrl(e.target.value);
            setResult(null);
          }
        }),
        // ⚠️ **不说「出口 IP」**：这里测的是「能不能连上该站的余额端点」，
        // 回显 HTTP 状态码（401 也是通的 —— 没带 Token 而已，见宿主侧注释）。
        result && React.createElement(
          "p",
          { className: "dim-jh-hint" },
          `已连通 ${result.host || (isCn ? "openapi.qoder.com.cn" : "openapi.qoder.sh")}（HTTP ${result.status}）· ${result.latencyMs}ms`
        ),
        error && React.createElement("p", { className: "dim-jh-error" }, error)
      ),
      React.createElement(
        "div",
        { className: "dim-jh-modalActions" },
        React.createElement("button", {
          type: "button",
          className: "dim-jh-btn",
          disabled: testing || busy || url.trim().length === 0,
          onClick: test
        }, testing ? "测试中…" : "测试连接"),
        // 只有已配置过才显示「清除」：没配过就没有可清除的东西。
        current ? React.createElement("button", {
          type: "button",
          className: "dim-jh-btn",
          disabled: busy,
          onClick: () => save("")
        }, "清除代理") : null,
        React.createElement("button", {
          type: "button",
          className: "dim-jh-btn dim-jh-btnPrimary",
          disabled: busy || url.trim().length === 0,
          onClick: () => save(url)
        }, "保存"),
        React.createElement("button", { type: "button", className: "dim-jh-btn", onClick: close }, "取消")
      )
    )
  );
}
function MinimaxIntlProxyModal({ ctx, accountId, current, onClose }) {
  const [mode, setMode] = React.useState(guessMode(current));
  const [url, setUrl] = React.useState(current || "");
  const [busy, setBusy] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [error, setError] = React.useState("");
  const [result, setResult] = React.useState(null);
  const close = () => {
    if (onClose) onClose();
  };
  const save = async (value) => {
    setBusy(true);
    setError("");
    try {
      await ctx.rpc({ method: "minimaxintl.setProxy", payload: { accountId, proxy: value } });
      close();
    } catch (err) {
      setError(err && err.message ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setTesting(true);
    setError("");
    setResult(null);
    try {
      const r = await ctx.rpc({ method: "minimaxintl.testProxy", payload: { proxy: url } });
      setResult(r);
    } catch (err) {
      setError(err && err.message ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };
  const activeHint = (MODES.find((m) => m.id === mode) || {}).hint || "";
  return React.createElement(
    "div",
    {
      className: "dim-jh-modalOverlay",
      onClick: (e) => {
        if (e.target === e.currentTarget) close();
      }
    },
    React.createElement(
      "div",
      {
        className: "dim-jh-modal",
        role: "dialog",
        "aria-modal": "true",
        style: { maxWidth: "520px" }
      },
      React.createElement(
        "div",
        { className: "dim-jh-modalHead" },
        React.createElement("div", { className: "dim-jh-modalTitle" }, "设置 MiniMax 国际站出口代理"),
        React.createElement(
          "span",
          { className: "dim-jh-modalSubtitle" },
          current ? "当前：已配置" : "当前：直连（本机出口）"
        )
      ),
      // ⚠️ 这段提示是本功能的存在理由，且必须**诚实**：本家的失败不是「连不上」
      // 而是「连上了却被转到中国站」，与另两家的措辞不同，别照抄。
      React.createElement(
        "p",
        { className: "dim-jh-modalHint" },
        "国际站（agent.minimax.io）按出口 IP 所在国家分流：中国大陆来源会被转到中国站，而中国站不认国际站账号 ⇒ 报出与「凭据失效」一模一样的错误，凭据本身却是好的。设置这里的代理后，该账号的登录、续期、积分与对话都会走它。"
      ),
      // ⚠️ 必须说清与 XFF 的关系：两者可叠加，但 XFF 是兜底而非替代。
      React.createElement(
        "p",
        { className: "dim-jh-hint" },
        "另有「MiniMax 国际站分流设置」（X-Forwarded-For）：它只是**声明**一个海外 IP，上游不认即失效；本设置是**真正**换出口，两者可叠加。"
      ),
      React.createElement(
        "div",
        { className: "dim-jh-modalBody" },
        React.createElement(
          "div",
          { className: "dim-jh-fieldRow" },
          MODES.map((m) => React.createElement(
            "label",
            { key: m.id, className: "dim-jh-radio" },
            React.createElement("input", {
              type: "radio",
              name: "minimaxintl-proxy-mode",
              checked: mode === m.id,
              onChange: () => {
                setMode(m.id);
                setError("");
                setResult(null);
              }
            }),
            m.label
          ))
        ),
        React.createElement("p", { className: "dim-jh-hint" }, activeHint),
        mode === "local" && React.createElement(
          "div",
          { className: "dim-jh-presetRow" },
          LOCAL_PORT_PRESETS.map((p) => React.createElement("button", {
            key: p.port,
            type: "button",
            className: "dim-jh-btn",
            title: p.hint,
            onClick: () => {
              setUrl(p.url);
              setError("");
              setResult(null);
            }
          }, p.label))
        ),
        React.createElement("input", {
          className: "dim-jh-input",
          placeholder: mode === "socks5" ? "socks5://user:pass@host:port" : "http://user:pass@host:port",
          value: url,
          // ⚠️ 含认证信息时用 password 类型：代理口令不该裸显在屏幕上。
          type: url.includes("@") ? "password" : "text",
          onChange: (e) => {
            setUrl(e.target.value);
            setResult(null);
          }
        }),
        result && React.createElement("p", {
          className: "dim-jh-hint",
          // ⚠️⚠️ **被分流时不能显示成正常的绿**：那是用户真正想问的答案。
          style: result.geoRouted ? { color: "var(--dim-warn, #d9a441)" } : void 0
        }, result.geoRouted ? `代理可用，但出口仍被判定为中国大陆（HTTP ${result.status}）· ${result.latencyMs}ms —— 换个海外出口的代理再试` : `出口已在海外，未被分流（HTTP ${result.status}）· ${result.latencyMs}ms`),
        error && React.createElement("p", { className: "dim-jh-error" }, error)
      ),
      React.createElement(
        "div",
        { className: "dim-jh-modalActions" },
        React.createElement("button", {
          type: "button",
          className: "dim-jh-btn",
          disabled: testing || busy || url.trim().length === 0,
          onClick: test
        }, testing ? "测试中…" : "测试连接"),
        // 只有已配置过才显示「清除」：没配过就没有可清除的东西。
        current ? React.createElement("button", {
          type: "button",
          className: "dim-jh-btn",
          disabled: busy,
          onClick: () => save("")
        }, "清除代理") : null,
        React.createElement("button", {
          type: "button",
          className: "dim-jh-btn dim-jh-btnPrimary",
          disabled: busy || url.trim().length === 0,
          onClick: () => save(url)
        }, "保存"),
        React.createElement("button", { type: "button", className: "dim-jh-btn", onClick: close }, "取消")
      )
    )
  );
}
function OpencodeKeyModal({ error, busy, inputRef, onSubmit, onSubmitAnonymous, onClose }) {
  const [mode, setMode] = React.useState("key");
  const submit = () => {
    if (mode === "anonymous") {
      onSubmitAnonymous();
      return;
    }
    const value = inputRef && inputRef.current ? inputRef.current.value : "";
    if (String(value).trim() === "") return;
    onSubmit(value);
  };
  return React.createElement(
    "div",
    {
      className: "dim-jh-modalOverlay",
      onClick: (e) => {
        if (e.target === e.currentTarget && !busy && onClose) onClose();
      }
    },
    React.createElement(
      "div",
      {
        className: "dim-jh-modal",
        role: "dialog",
        "aria-modal": "true",
        style: { maxWidth: "520px" }
      },
      React.createElement(
        "div",
        { className: "dim-jh-modalHead" },
        React.createElement("div", { className: "dim-jh-modalTitle" }, "添加 OpenCode 账号")
      ),
      // 两种身份：API key 账号 / 匿名通道（无需凭据）。
      React.createElement(
        "div",
        { className: "dim-jh-fieldRow" },
        [
          { id: "key", label: "API key 账号" },
          { id: "anonymous", label: "匿名通道" }
        ].map((m) => React.createElement(
          "label",
          { key: m.id, className: "dim-jh-radio" },
          React.createElement("input", {
            type: "radio",
            name: "opencode-add-mode",
            checked: mode === m.id,
            onChange: () => setMode(m.id)
          }),
          m.label
        ))
      ),
      mode === "key" ? React.createElement(
        React.Fragment,
        null,
        React.createElement(
          "p",
          { className: "dim-jh-modalHint" },
          // ⚠️ 前缀**两种都要提**：opencode 2026-10-22 起签发 `oc_sk_…`
          // （Gitee IKPLRU），旧号手里仍是 `sk-…`；只写一种会让另一种的人
          // 以为自己的 key 不对。生成地址也从旧的 `/auth` 更正到控制台账号页。
          "在 opencode.ai/console/account 生成 API key 后粘贴到下方（旧 key 形如 sk-…，新 key 形如 oc_sk_…）。可启用付费模型，并为每个账号单独设置出口代理。"
        ),
        // ⚠️ 内容必须在 modalBody 里（flex:1; min-height:0; overflow-y:auto），
        // 否则弹窗内容会被裁掉（见 jet-hub.js 既有 modal 的注释）。
        React.createElement(
          "div",
          { className: "dim-jh-modalBody" },
          React.createElement(
            "div",
            { className: "dim-jh-formRows" },
            React.createElement("input", {
              ref: inputRef,
              className: "dim-jh-input",
              // ⚠️ password 类型：API key 是凭据，不该在屏幕上裸显。
              type: "password",
              placeholder: "sk-… / oc_sk_…",
              autoFocus: true,
              // Enter 直接提交：粘贴 key 后最自然的动作就是回车。
              onKeyDown: (e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }
            })
          ),
          // ⚠️ 错误留在弹窗内：把整个账号列表切成错误态会让用户刚填的 key
          // 与错误信息一起消失，只能刷新重试。
          error ? React.createElement("p", { className: "dim-jh-error", role: "alert" }, "添加失败：" + error) : null
        )
      ) : React.createElement(
        "div",
        { className: "dim-jh-modalBody" },
        React.createElement(
          "p",
          { className: "dim-jh-modalHint" },
          "匿名通道无需任何凭据（上游认字面量 public），用于免费模型。可以添加多条，每条可单独设置出口代理。"
        ),
        // ⚠️⚠️ **诚实说明指纹不增加配额**：匿名通道按出口 IP 限额
        // （实测：换 key、换伪装头、换指纹全部无效）。要多份额度只能给
        // 不同匿名通道配**不同代理**；指纹分离的价值是防关联。
        // 不说清楚的话，用户加 5 条匿名通道却只看到一份额度，会以为坏了。
        React.createElement(
          "p",
          { className: "dim-jh-hint" },
          "注意：匿名通道的额度按「出口 IP」计算。多条匿名通道若共用同一个出口，额度不会增加；给它们分别配置不同代理，才会各自获得独立额度。"
        ),
        error ? React.createElement("p", { className: "dim-jh-error", role: "alert" }, "添加失败：" + error) : null
      ),
      React.createElement(
        "div",
        { className: "dim-jh-modalActions" },
        React.createElement("button", {
          type: "button",
          className: "dim-jh-btn dim-jh-btnPrimary",
          disabled: busy,
          onClick: submit
        }, busy ? "添加中…" : "添加"),
        React.createElement("button", {
          type: "button",
          className: "dim-jh-btn",
          disabled: busy,
          onClick: () => {
            if (onClose) onClose();
          }
        }, "取消")
      )
    )
  );
}

// plugin-src/client/modelscope-key-modal.js
var React2 = __toESM(require("react"), 1);
var TOKEN_URL = "https://modelscope.cn/my/myaccesstoken";
function ModelscopeKeyModal({ error, busy, inputRef, onSubmit, onClose }) {
  const submit = () => {
    const value = inputRef && inputRef.current ? inputRef.current.value : "";
    if (String(value).trim() === "") {
      if (onClose) onClose();
      return;
    }
    onSubmit(value);
  };
  return React2.createElement(
    "div",
    {
      className: "dim-jh-modalOverlay",
      onClick: (e) => {
        if (e.target === e.currentTarget && !busy && onClose) onClose();
      }
    },
    React2.createElement(
      "div",
      {
        className: "dim-jh-modal",
        role: "dialog",
        "aria-modal": "true",
        style: { maxWidth: "520px" }
      },
      React2.createElement(
        "div",
        { className: "dim-jh-modalHead" },
        React2.createElement("div", { className: "dim-jh-modalTitle" }, "添加 ModelScope 账号")
      ),
      // ⚠️ 内容必须放进 modalBody（flex:1; min-height:0; overflow-y:auto），
      // 否则弹窗较高时内容会被裁掉（见 jet-hub.js 既有 modal 的注释）。
      React2.createElement(
        "div",
        { className: "dim-jh-modalBody" },
        React2.createElement(
          "p",
          { className: "dim-jh-modalHint" },
          "在 " + TOKEN_URL + " 生成访问令牌（形如 ms-…）后粘贴到下方。"
        ),
        // ⚠️ 这一句是**用户会踩的坑**：魔搭控制台的令牌有「有效期」一栏，
        // 选短期会让账号过一阵就失效，而本插件**无法续期**（没有 refresh 端点）。
        React2.createElement(
          "p",
          { className: "dim-jh-hint" },
          "建议把令牌有效期设为「永久」—— 本插件无法自动续期，短期令牌过期后需要回到这里重新粘贴。"
        ),
        React2.createElement(
          "div",
          { className: "dim-jh-formRows" },
          React2.createElement("input", {
            ref: inputRef,
            className: "dim-jh-input",
            // ⚠️ password 类型：API Key 是凭据，不该在屏幕上裸显。
            type: "password",
            placeholder: "ms-…",
            autoFocus: true,
            // Enter 直接提交：粘贴 Key 后最自然的动作就是回车。
            onKeyDown: (e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }
          })
        ),
        // ⚠️ 错误留在弹窗内：把整个账号列表切成错误态会让用户刚填的 Key
        // 与错误信息一起消失，只能刷新重试。
        error ? React2.createElement("p", { className: "dim-jh-error", role: "alert" }, "添加失败：" + error) : null
      ),
      React2.createElement(
        "div",
        { className: "dim-jh-modalActions" },
        React2.createElement("button", {
          type: "button",
          className: "dim-jh-btn dim-jh-btnPrimary",
          disabled: busy,
          onClick: submit
        }, busy ? "添加中…" : "添加"),
        React2.createElement("button", {
          type: "button",
          className: "dim-jh-btn",
          disabled: busy,
          onClick: () => {
            if (onClose) onClose();
          }
        }, "取消")
      )
    )
  );
}
function ModelscopeKeyEditModal({ error, busy, currentMasked, inputRef, onSubmit, onClose }) {
  const submit = () => {
    const value = inputRef && inputRef.current ? inputRef.current.value : "";
    if (String(value).trim() === "") {
      if (onClose) onClose();
      return;
    }
    onSubmit(value);
  };
  return React2.createElement(
    "div",
    {
      className: "dim-jh-modalOverlay",
      onClick: (e) => {
        if (e.target === e.currentTarget && !busy && onClose) onClose();
      }
    },
    React2.createElement(
      "div",
      {
        className: "dim-jh-modal",
        role: "dialog",
        "aria-modal": "true",
        style: { maxWidth: "520px" }
      },
      React2.createElement(
        "div",
        { className: "dim-jh-modalHead" },
        React2.createElement("div", { className: "dim-jh-modalTitle" }, "编辑 API Key")
      ),
      React2.createElement(
        "div",
        { className: "dim-jh-modalBody" },
        React2.createElement(
          "p",
          { className: "dim-jh-modalHint" },
          "在 " + TOKEN_URL + " 生成访问令牌（形如 ms-…）后粘贴到下方。" + (currentMasked ? "当前：" + currentMasked : "当前：尚未设置")
        ),
        React2.createElement(
          "div",
          { className: "dim-jh-formRows" },
          React2.createElement("input", {
            ref: inputRef,
            className: "dim-jh-input",
            // ⚠️ password 类型：API Key 是凭据，不该在屏幕上裸显。
            type: "password",
            placeholder: "ms-…",
            autoFocus: true,
            disabled: !!busy,
            // Enter 直接提交：粘贴 Key 后最自然的动作就是回车。
            onKeyDown: (e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }
          })
        ),
        React2.createElement(
          "p",
          { className: "dim-jh-modalHint" },
          "注意：换一把 Key 会同时更换该账号的标识（它由 Key 尾段派生），昵称与停用状态会保留。同一把 Key 只对应一个账号。"
        ),
        // ⚠️ 错误留在弹窗内：把账号列表切成错误态会让用户刚填的 Key
        // 与错误信息一起消失，只能刷新重试。
        error ? React2.createElement("p", { className: "dim-jh-error", role: "alert" }, "保存失败：" + error) : null
      ),
      React2.createElement(
        "div",
        { className: "dim-jh-modalActions" },
        React2.createElement("button", {
          type: "button",
          className: "dim-jh-btn dim-jh-btnPrimary",
          disabled: !!busy,
          onClick: submit
        }, busy ? "保存中…" : "保存"),
        React2.createElement("button", {
          type: "button",
          className: "dim-jh-btn",
          disabled: !!busy,
          onClick: () => {
            if (onClose) onClose();
          }
        }, "取消")
      )
    )
  );
}

// plugin-src/client/notice-shape.js
function normalizeProbeNotice(next) {
  if (next === null || next === void 0) return null;
  if (typeof next === "string") {
    return { tone: "ok", text: next, details: [] };
  }
  if (typeof next !== "object" || Array.isArray(next)) return null;
  const record = (
    /** @type {Record<string, unknown>} */
    next
  );
  const text = typeof record.text === "string" ? record.text : "";
  if (text.length === 0) return null;
  const details = Array.isArray(record.details) ? record.details.filter((line) => typeof line === "string" && line.length > 0) : [];
  return {
    tone: typeof record.tone === "string" && record.tone.length > 0 ? record.tone : "ok",
    text,
    details
  };
}
function safeNoticeDetails(details) {
  return Array.isArray(details) ? details : [];
}

// plugin-src/client/credit-expiry.js
var DAY_MS = 24 * 60 * 60 * 1e3;
function normalizeWindowDays2(windowDays) {
  if (windowDays === void 0 || windowDays === null || windowDays === "") return null;
  const parsed = Number(windowDays);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
function daysUntilExpiry(pkg, now) {
  const end = pkg && typeof pkg.deductionEndTime === "number" ? pkg.deductionEndTime : null;
  if (end === null || !Number.isFinite(end) || end <= 0) return null;
  const at = typeof now === "number" && Number.isFinite(now) ? now : Date.now();
  return (end - at) / DAY_MS;
}
function splitCreditsByExpiry(packages, windowDays, now) {
  const days = normalizeWindowDays2(windowDays);
  if (days === null || !Array.isArray(packages)) return null;
  const windowMs = days * DAY_MS;
  const at = typeof now === "number" && Number.isFinite(now) ? now : Date.now();
  let expiring = 0;
  let longTerm = 0;
  let permanent = 0;
  let earliestExpiringAt = null;
  let earliestExpiringAmount = 0;
  let exclusivePoolRemaining = 0;
  for (const pkg of packages) {
    if (!pkg || pkg.active !== true) continue;
    const remaining = Number(pkg.remaining);
    if (!Number.isFinite(remaining) || remaining <= 0) continue;
    if (isExclusivePool(pkg)) {
      exclusivePoolRemaining += remaining;
      continue;
    }
    const end = packageExpiryMs(pkg);
    const known = end !== null;
    if (!known) {
      const expiringPart = Number(pkg.expiringRemaining);
      const hasExpiring = Number.isFinite(expiringPart) && expiringPart > 0;
      if (hasExpiring) {
        const capped = Math.min(expiringPart, remaining);
        expiring += capped;
        permanent += remaining - capped;
      } else {
        permanent += remaining;
      }
      continue;
    }
    if (end - at < windowMs) {
      expiring += remaining;
      if (end > at && (earliestExpiringAt === null || end < earliestExpiringAt)) {
        earliestExpiringAt = end;
        earliestExpiringAmount = remaining;
      } else if (end > at && end === earliestExpiringAt) {
        earliestExpiringAmount += remaining;
      }
    } else {
      longTerm += remaining;
    }
  }
  return { expiring, longTerm, permanent, earliestExpiringAt, earliestExpiringAmount, exclusivePoolRemaining };
}
function expiryBucketLabel(pkg, windowDays, now) {
  const days = normalizeWindowDays2(windowDays);
  const left = daysUntilExpiry(pkg, now);
  if (left === null) return "到期时间未知";
  if (days === null) return null;
  return left < days ? `${Math.ceil(left)} 天内到期` : `还有 ${Math.ceil(left)} 天`;
}
function formatExpirySplitLine(split, format) {
  if (!split) return null;
  const parts = [];
  const permanent = split.permanent > 0 ? format(split.permanent) : null;
  const longTerm = split.longTerm > 0 ? format(split.longTerm) : null;
  const expiring = split.expiring > 0 ? format(split.expiring) : null;
  if (permanent !== null) parts.push(`永久 ${permanent}`);
  if (longTerm !== null) parts.push(`长期 ${longTerm}`);
  if (expiring !== null) parts.push(`临期 ${expiring}`);
  return parts.length === 0 ? null : parts.join(" · ");
}
function expirySplitParts(split, format, now) {
  if (!split) return [];
  const parts = [];
  const permanent = split.permanent > 0 ? format(split.permanent) : null;
  const longTerm = split.longTerm > 0 ? format(split.longTerm) : null;
  const expiringAmount = split.expiring > 0 ? split.expiring : 0;
  const expiring = expiringAmount > 0 ? format(expiringAmount) : null;
  if (permanent !== null) parts.push({ key: "permanent", text: `永久 ${permanent}`, tone: "ok" });
  if (longTerm !== null) parts.push({ key: "longTerm", text: `长期 ${longTerm}`, tone: "warn" });
  if (expiring !== null) {
    const at = split.earliestExpiringAt;
    const countdown = typeof at === "number" && Number.isFinite(at) && at > 0 ? expiryCountdown(at, now) : "";
    const earliestAmount = Number.isFinite(split.earliestExpiringAmount) && split.earliestExpiringAmount > 0 ? split.earliestExpiringAmount : 0;
    const partial = earliestAmount > 0 && earliestAmount < expiringAmount;
    const countdownText = countdown.length === 0 ? "" : partial ? `其中 ${format(earliestAmount)} 于 ${countdown}后到期` : countdown;
    parts.push({
      key: "expiring",
      text: `临期 ${expiring}`,
      tone: "error",
      ...countdownText.length > 0 ? { countdown: countdownText } : {}
    });
  }
  return parts;
}
function expiryCountdown(expiresAtMs, now) {
  const at = Number(expiresAtMs);
  if (!Number.isFinite(at) || at <= 0) return "";
  const ref = typeof now === "number" && Number.isFinite(now) ? now : Date.now();
  if (at <= ref) return "";
  const minutes = Math.ceil((at - ref) / 6e4);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes % 1440 / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${mins} 分钟`;
  return `${mins} 分钟`;
}
var DAILY_POOL_NAMES = ["每日赠送", "每日积分"];
function findDailyPool(packages) {
  if (!Array.isArray(packages)) return null;
  return packages.find((pkg) => pkg && DAILY_POOL_NAMES.includes(pkg.name)) ?? null;
}
function formatPoolSplitLine(packages, format, longTermLabel = "长期") {
  const daily = findDailyPool(packages);
  if (daily === null) return null;
  const restSum = packages.reduce((sum, pkg) => {
    if (!pkg || pkg === daily) return sum;
    if (pkg.active !== true) return sum;
    const remaining = Number(pkg.remaining);
    return Number.isFinite(remaining) && remaining > 0 ? sum + remaining : sum;
  }, 0);
  const dailyValue = format(Number(daily.remaining) || 0);
  const restValue = format(restSum);
  if (dailyValue === null || restValue === null) return null;
  return `${longTermLabel} ${restValue} · 每日 ${dailyValue}`;
}
function formatNamedPoolLine(packages, format) {
  if (!Array.isArray(packages)) return null;
  const parts = [];
  for (const pkg of packages) {
    if (!pkg || pkg.active !== true) continue;
    const name2 = typeof pkg.name === "string" ? pkg.name.trim() : "";
    if (name2 === "") continue;
    const value = format(Number(pkg.remaining) || 0);
    if (value === null) return null;
    const short = name2.endsWith("积分") ? name2.slice(0, -2) : name2;
    parts.push(`${short} ${value}`);
  }
  return parts.length === 0 ? null : parts.join(" · ");
}
function isExclusivePool(pkg) {
  const name2 = pkg && typeof pkg.name === "string" ? pkg.name : "";
  return name2.includes("独立池");
}
function exclusivePoolRemainingOf(packages) {
  if (!Array.isArray(packages)) return 0;
  let sum = 0;
  for (const pkg of packages) {
    if (!pkg || pkg.active !== true) continue;
    if (!isExclusivePool(pkg)) continue;
    const remaining = Number(pkg.remaining);
    if (!Number.isFinite(remaining) || remaining <= 0) continue;
    sum += remaining;
  }
  return sum;
}
function packageExpiryMs(pkg) {
  const dedEnd = Number(pkg && pkg.deductionEndTime);
  if (Number.isFinite(dedEnd) && dedEnd > 0) return dedEnd;
  const exp = pkg && pkg.expiredTime ? String(pkg.expiredTime) : "";
  if (exp.length > 0) {
    const ms = Date.parse(exp.replace(" ", "T"));
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  return null;
}
function formatPackageExpiry(pkg, now) {
  const end = packageExpiryMs(pkg);
  if (end === null) return "长期";
  const at = Number.isFinite(now) ? now : Date.now();
  const date = new Date(end).toISOString().slice(0, 10);
  const days = Math.ceil((end - at) / DAY_MS);
  if (days <= 0) return `${date}（已过期）`;
  return `${date}（${days} 天后）`;
}
function formatPackageTooltip(packages, options = {}) {
  const { format, now = Date.now(), maxRows = 12 } = options;
  if (!Array.isArray(packages) || packages.length === 0) return null;
  const at = Number.isFinite(now) ? now : Date.now();
  const usable = packages.filter((pkg) => {
    if (!pkg || pkg.active === false) return false;
    const remaining = Number(pkg.remaining);
    if (!Number.isFinite(remaining) || remaining <= 0) return false;
    const end = packageExpiryMs(pkg);
    if (end !== null && end <= at) return false;
    return true;
  });
  if (usable.length === 0) return null;
  const sorted = [...usable].sort((a, b) => {
    const endA = packageExpiryMs(a);
    const endB = packageExpiryMs(b);
    const keyA = endA === null ? Infinity : endA;
    const keyB = endB === null ? Infinity : endB;
    if (keyA !== keyB) return keyA - keyB;
    return (Number(b && b.remaining) || 0) - (Number(a && a.remaining) || 0);
  });
  const lines = sorted.slice(0, maxRows).map((pkg) => {
    const name2 = pkg && pkg.name || "未命名";
    const remaining = format ? format(Number(pkg && pkg.remaining) || 0) : String(pkg && pkg.remaining);
    const total = format ? format(Number(pkg && pkg.total) || 0) : String(pkg && pkg.total);
    return `${name2}  ${remaining} / ${total}  ${formatPackageExpiry(pkg, at)}`;
  });
  const rest = sorted.slice(maxRows);
  if (rest.length > 0) {
    const sum = rest.reduce((acc, p) => acc + (Number(p && p.remaining) || 0), 0);
    lines.push(`…另有 ${rest.length} 个包${sum > 0 ? `，合计剩余 ${format ? format(sum) : sum}` : ""}`);
  }
  return lines.join("\n");
}

// plugin-src/client/account-model-link.js
function disablingLeavesNoEnabledAccount(accounts, accountId, provider) {
  const list = Array.isArray(accounts) ? accounts : [];
  const target = list.find((a) => a?.id === accountId);
  if (target === void 0 || target.enabled === false) return false;
  const stillEnabled = list.some(
    (a) => a?.provider === provider && a?.id !== accountId && a?.enabled !== false
  );
  return !stillEnabled;
}
function allModelsDisabled(models) {
  const list = Array.isArray(models) ? models : [];
  if (list.length === 0) return false;
  return list.every((m) => m?.disabled === true);
}

// plugin-src/client/new-account.js
var PROVIDERS_ASKING_OPTIONS = Object.freeze(["zcode", "accio", "astudio", "autoclaw", "autoclawintl"]);
function newAccountAsksChannel(provider) {
  return PROVIDERS_ASKING_OPTIONS.includes(provider);
}
function buildCreateAccountPayload(provider, zcodeProvider, accioRegion, astudioLoginMethod, autoclawMode) {
  if (provider !== "zcode" && provider !== "accio" && provider !== "astudio" && provider !== "autoclaw" && provider !== "autoclawintl") {
    return { provider };
  }
  if (provider === "zcode") return { provider, zcodeProvider };
  if (provider === "accio") return { provider, accioRegion };
  if (provider === "astudio") return { provider, astudioLoginMethod: astudioLoginMethod ?? "local" };
  return { provider, autoclawMode: autoclawMode ?? "local" };
}

// plugin-src/client/model-filter.js
var MODEL_STATUS_FILTERS = Object.freeze(["all", "enabled", "disabled"]);
function normalizeStatusFilter(status) {
  return MODEL_STATUS_FILTERS.includes(status) ? status : "all";
}
function matchesModelQuery(model, query) {
  const needle = typeof query === "string" ? query.trim().toLowerCase() : "";
  if (needle.length === 0) return true;
  const name2 = typeof model?.name === "string" ? model.name : "";
  const id = typeof model?.id === "string" ? model.id : "";
  return name2.toLowerCase().includes(needle) || id.toLowerCase().includes(needle);
}
function filterModels(models, options = {}) {
  const list = Array.isArray(models) ? models : [];
  const status = normalizeStatusFilter(options.status);
  const query = typeof options.query === "string" ? options.query : "";
  return list.filter((model) => {
    if (status === "enabled" && model?.disabled === true) return false;
    if (status === "disabled" && model?.disabled !== true) return false;
    return matchesModelQuery(model, query);
  });
}
function isFilterActive(options = {}) {
  const query = typeof options.query === "string" ? options.query.trim() : "";
  return query.length > 0 || normalizeStatusFilter(options.status) !== "all";
}

// src/openai-gateway/config.ts
var INVISIBLE = /[\p{Cf}\p{Cc}\p{Cs}\p{Mn}\p{Me}\p{Zs}\p{Zl}\p{Zp}]/gu;
function normalizeHostForCompare(host) {
  if (typeof host !== "string") return "";
  let value = host.normalize("NFKC").replace(INVISIBLE, "");
  const bracketed = /^\[([^\]]*)\](?::\d*)?$/.exec(value);
  if (bracketed !== null) {
    value = bracketed[1];
  } else if (/^[^:]+:\d*$/.test(value)) {
    value = value.slice(0, value.lastIndexOf(":"));
  }
  while (value.startsWith("[") && value.endsWith("]") && value.length > 2) {
    value = value.slice(1, -1);
  }
  if (value.includes(":")) {
    const zone = value.indexOf("%");
    if (zone > 0) value = value.slice(0, zone);
  }
  return value;
}
function stripHostBrackets(host) {
  let value = host.normalize("NFKC").replace(INVISIBLE, "");
  const bracketed = /^\[([^\]]*)\](?::\d*)?$/.exec(value);
  if (bracketed !== null) {
    value = bracketed[1];
  } else if (/^[^:]+:\d*$/.test(value)) {
    value = value.slice(0, value.lastIndexOf(":"));
  }
  while (value.startsWith("[") && value.endsWith("]") && value.length > 2) {
    value = value.slice(1, -1);
  }
  return value;
}
function formatGatewayHost(host) {
  const value = stripHostBrackets(host);
  const zone = value.includes(":") ? value.indexOf("%") : -1;
  const bare = zone > 0 ? value.slice(0, zone) : value;
  return bare.includes(":") ? `[${bare}]` : bare;
}
function gatewayHttpUrl(host, port, suffix = "") {
  return `http://${formatGatewayHost(host)}:${port}${suffix}`;
}
function expandIpv6(value) {
  const text = value.toLowerCase();
  if (!/^[0-9a-f:.]+$/.test(text)) return void 0;
  const halves = text.split("::");
  if (halves.length > 2) return void 0;
  const parse = (part) => {
    if (part === "") return [];
    const groups = part.split(":");
    const out = [];
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index];
      if (group.includes(".")) {
        if (index !== groups.length - 1) return void 0;
        const octets = group.split(".");
        if (octets.length !== 4) return void 0;
        const nums = octets.map((octet) => /^\d{1,3}$/.test(octet) ? Number(octet) : Number.NaN);
        if (nums.some((num) => !Number.isInteger(num) || num < 0 || num > 255)) return void 0;
        out.push(nums[0] << 8 | nums[1], nums[2] << 8 | nums[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(group)) return void 0;
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };
  const head = parse(halves[0]);
  if (head === void 0) return void 0;
  if (halves.length === 1) return head.length === 8 ? head : void 0;
  const tail = parse(halves[1]);
  if (tail === void 0) return void 0;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return void 0;
  return [...head, ...Array.from({ length: missing }, () => 0), ...tail];
}
function parseIpv4(value) {
  const text = value.endsWith(".") ? value.slice(0, -1) : value;
  const parts = text.split(".");
  if (parts.length === 0 || parts.length > 4) return void 0;
  const nums = [];
  for (const part of parts) {
    if (part === "") return void 0;
    let num;
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) {
      num = Number.parseInt(part.slice(2), 16);
    } else if (/^0[0-7]+$/.test(part)) {
      num = Number.parseInt(part.slice(1), 8);
    } else if (/^\d+$/.test(part)) {
      num = Number(part);
    } else {
      return void 0;
    }
    if (!Number.isSafeInteger(num) || num < 0) return void 0;
    nums.push(num);
  }
  const last = nums[nums.length - 1];
  const limit = 256 ** (4 - nums.length + 1);
  if (last >= limit) return void 0;
  for (const num of nums.slice(0, -1)) if (num > 255) return void 0;
  let result = 0;
  for (const num of nums.slice(0, -1)) result = result << 8 | num;
  return result * limit + last >>> 0;
}
function isWildcardHost(host) {
  const value = normalizeHostForCompare(host);
  if (value === "") return true;
  if (!value.includes(":")) return parseIpv4(value) === 0;
  const groups = expandIpv6(value);
  if (groups === void 0) return false;
  if (groups.every((group) => group === 0)) return true;
  const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 65535;
  return mapped && groups[6] === 0 && groups[7] === 0;
}
function isLoopbackHost(host) {
  const value = normalizeHostForCompare(host).toLowerCase();
  if (value === "") return true;
  if (value === "localhost" || value.endsWith(".localhost")) return true;
  if (!value.includes(":")) {
    const ipv4 = parseIpv4(value);
    if (ipv4 === void 0) return false;
    return ipv4 >>> 24 === 127;
  }
  const groups = expandIpv6(value);
  if (groups === void 0) return false;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true;
  const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 65535;
  return mapped && groups[6] >>> 8 === 127;
}

// plugin-src/client/openai-gateway-panel.js
async function copyToClipboard(value) {
  try {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}
function gatewayApiKeyHint(apiKey) {
  if (!apiKey) return "网关尚未生成过密钥：启用一次网关即会自动生成。";
  if (apiKey.fromEnv) return "密钥来自环境变量 DSH_OPENAI_GATEWAY_API_KEY（不在文件里）。";
  return apiKey.path ? `密钥文件：${apiKey.path}` : "密钥来自环境变量。";
}
function gatewayButtonLabel(status) {
  if (!status) return "网关";
  return status.running ? "网关 ●" : "网关";
}
function modelSupportsImage(model) {
  return Array.isArray(model?.input) && model.input.includes("image");
}
function modelCapabilityBadge(model) {
  return modelSupportsImage(model) ? "可发图片" : "";
}
function formatModelIdList(models) {
  if (!models || models.length === 0) return "";
  return models.map((model) => model.id).join("\n");
}
function gatewayProviderOf(entry2) {
  const provider = entry2?.provider;
  if (typeof provider === "string" && provider !== "") return provider;
  const id = typeof entry2?.id === "string" ? entry2.id : "";
  const slash = id.indexOf("/");
  return slash > 0 ? id.slice(0, slash) : "";
}
function gatewayModelKeyOf(entry2) {
  const inner = entry2?.model;
  if (typeof inner === "string" && inner !== "") return inner;
  const id = typeof entry2?.id === "string" ? entry2.id : "";
  const provider = gatewayProviderOf(entry2);
  if (provider !== "" && id.startsWith(provider + "/")) return id.slice(provider.length + 1);
  return id;
}
var GATEWAY_CARD_AUTOCOLLAPSE_AT = 24;
function groupGatewayEntries(entries, countFold) {
  const list = Array.isArray(entries) ? entries : [];
  const byProvider = /* @__PURE__ */ new Map();
  for (const entry2 of list) {
    const provider = gatewayProviderOf(entry2);
    let bucket = byProvider.get(provider);
    if (bucket === void 0) {
      bucket = [];
      byProvider.set(provider, bucket);
    }
    bucket.push(entry2);
  }
  return [...byProvider].map(([provider, bucket]) => ({
    provider,
    entries: bucket,
    counts: {
      total: bucket.length,
      fold: typeof countFold === "function" ? bucket.filter(countFold).length : 0
    }
  }));
}
function groupGatewayModels(models) {
  return groupGatewayEntries(models, (model) => modelSupportsImage(model));
}
function gatewayCardExpanded(card, options = {}) {
  const toggled = options.toggled;
  if (toggled === true || toggled === false) return toggled;
  if (options.searching === true) return true;
  return (card?.counts?.total ?? 0) <= GATEWAY_CARD_AUTOCOLLAPSE_AT;
}
function gatewayCardLabel(provider, labelOf) {
  if (provider === "") return "（未标注供应商）";
  if (typeof labelOf === "function") {
    const label = labelOf(provider);
    if (typeof label === "string" && label !== "") return label;
  }
  return provider;
}
function gatewayModelsHint(models, source) {
  if (!models || models.length === 0) {
    if (source === "none") {
      return "拿不到任何 provider 列表（不是登录问题）：通常是 DSH 侧模型服务未就绪，重启 DSH 或点「刷新」再试。";
    }
    return "还没有可用模型：登录至少一个供应商后点「刷新」。";
  }
  const providers = new Set(models.map((model) => gatewayProviderOf(model))).size;
  const base = `共开启 ${models.length} 个可用模型，来自 ${providers} 个供应商，ID 区分大小写。`;
  return source === "adapters" ? base + "（目录来自本插件已注册的适配器，可能不含 DSH 自带的模型）" : base;
}
function gatewayModelsEmptyHint(query) {
  const needle = typeof query === "string" ? query.trim() : "";
  if (needle.length === 0) return "当前没有可用模型。";
  return `没有匹配「${needle}」的模型。搜索会匹配模型 ID 与展示名（不区分大小写）。`;
}
function gatewayEffortRow(model) {
  const reasoning = model?.reasoning;
  const efforts = reasoning?.efforts;
  if (!Array.isArray(efforts) || efforts.length === 0) return null;
  return {
    id: model.id,
    // ⚠️ 带上权威供应商与内部模型名：对照表也要按供应商折成卡片，而行内只显示
    // **去掉前缀**的名字（与模型清单同一取舍，见 `gatewayModelKeyOf`）。
    // 复制出去的仍是完整 `id`（客户端配置要的是它）。
    provider: gatewayProviderOf(model),
    model: gatewayModelKeyOf(model),
    // 展示名留给搜索用（与模型清单的搜索共用 matchesModelQuery）。
    name: typeof model.name === "string" ? model.name : "",
    // 两个名字都给出来：`id` 是网关实际下发的 wire 值，`name` 是 DSH 界面上的叫法
    // （用户就是照它填错的，故两列都得能对上）。
    declared: efforts.map((effort) => `${effort.id}（${effort.name}）`).join(" · "),
    fill: Array.isArray(reasoning.openai_efforts) ? reasoning.openai_efforts.join(", ") : "",
    // 「真实 id 与应填的规范名不完全一致」= 客户端侧的显示名会与 DSH 界面不同，
    // 这类行才是用户真正会看错的，值得在 UI 上标出来。
    //
    // ⚠️ **`canonical === undefined`（上游给了个没登记的私有 id，如 `turbo`）也算**：
    // 那种档位**任何规范名都表达不出来**，`fill` 列会比 `declared` 列少一档。
    // 原判据只认「canonical 与 id 不同」，于是这种行恰恰**不标徽章** ——
    // 用户看到一档填不出来的东西，却没有任何解释。
    lossy: efforts.some((effort) => effort.canonical === void 0 || effort.canonical !== effort.id)
  };
}
function gatewayEffortRows(models) {
  if (!Array.isArray(models)) return [];
  return models.map(gatewayEffortRow).filter(Boolean);
}
function matchesEffortQuery(row, query) {
  if (matchesModelQuery(row, query)) return true;
  const needle = typeof query === "string" ? query.trim().toLowerCase() : "";
  if (needle.length === 0) return true;
  return `${row?.declared ?? ""} ${row?.fill ?? ""}`.toLowerCase().includes(needle);
}
function filterEffortRows(rows, query) {
  const list = Array.isArray(rows) ? rows : [];
  if (!isFilterActive({ query })) return list;
  return list.filter((row) => matchesEffortQuery(row, query));
}
function gatewayEffortsHintLines(models) {
  const rows = gatewayEffortRows(models);
  if (rows.length === 0) {
    return ["当前已开启的模型都没声明思考档位：网关不下发该参数，按模型默认走。"];
  }
  const lossy = rows.filter((row) => row.lossy).length;
  const enabled = Array.isArray(models) ? models.length : rows.length;
  return [
    `已开启的 ${enabled} 个模型里，有 ${rows.length} 个可选思考档位${lossy > 0 ? `（${lossy} 个不同名，标「需对照」）` : ""}。`,
    "「客户端该填」为 CC Switch 需配置的映射档位，未登记的档位名称将被拒绝。"
  ];
}
function gatewayEffortsEmptyHint(query) {
  const needle = typeof query === "string" ? query.trim() : "";
  if (needle.length === 0) return "当前没有模型声明思考档位。";
  return `没有匹配「${needle}」的模型。搜索会匹配模型 id / 展示名，也会匹配档位名（真实 id 与 DSH 界面上的叫法都算，例如 xhigh / Max / Extra）。`;
}
function gatewayEffortsText(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return list.map((row) => [
    row.id,
    `  真实档位：${row.declared}`,
    `  客户端该填：${row.fill}`
  ].join("\n")).join("\n\n");
}
function gatewayFailureReason(status) {
  const reason = status?.lastError?.reason;
  return typeof reason === "string" && reason.length > 0 ? reason : "";
}
function gatewayButtonTitle(status) {
  if (!status) return "本机 OpenAI 网关：读取状态中。";
  if (status.blockedByEnv) {
    return "本机 OpenAI 网关：已被环境变量 DSH_OPENAI_GATEWAY_ENABLED 停用，在这里改开关不会让它监听端口。";
  }
  if (status.running) return `本机 OpenAI 网关：运行中（${gatewayEndpoint(status)}）。`;
  if (status.enabled) {
    const reason = gatewayFailureReason(status);
    if (reason !== "") return `本机 OpenAI 网关：已选择开启，但启动失败（${reason}）。`;
    return "本机 OpenAI 网关：已选择开启，但当前未在监听（通常是端口被占用）。";
  }
  return "本机 OpenAI 网关：已关闭。";
}
function gatewayEndpoint(status) {
  const address = status?.address;
  if (!address) return "";
  return gatewayHttpUrl(address.host, address.port, "/v1");
}
function gatewayLoopbackOnly(status) {
  const host = status?.address?.host;
  if (typeof host !== "string" || host.trim() === "") return true;
  return isLoopbackHost(host);
}
function gatewayAddressUnknown(status) {
  if (status?.running !== true) return false;
  const address = status?.address;
  return address === null || address === void 0 || typeof address.host !== "string" || address.host.trim() === "";
}
function nonLoopbackNotice(status) {
  const address = status?.address;
  const host = typeof address?.host === "string" && address.host.trim() !== "" ? address.host : "非回环地址";
  return `监听地址是 ${host}（不再是本机回环）：只应在容器/端口映射或局域网共享场景使用，此时同一网络内的其它设备与宿主都能连到这个端口。仅本机使用时关掉「允许局域网访问」开关即可立即恢复；若地址来自 DSH_OPENAI_GATEWAY_HOST，把它改回 127.0.0.1 并重启。`;
}
function gatewayFootnote(status) {
  if (gatewayAddressUnknown(status)) {
    return "网关正在运行，但本次读不到它的监听地址 —— 无法确认它只绑了回环。若你打开了「允许局域网访问」，请按已开启对待（隔离只靠密钥）。";
  }
  if (status?.running && !gatewayLoopbackOnly(status)) {
    const host = typeof status.address?.host === "string" ? status.address.host : "非回环地址";
    return `网关绑定在 ${host}，同一网络内的其它设备与宿主都能连到该端口 —— 隔离只靠密钥，不要把它配置进任何浏览器端工具或扩展。仅本机使用时关掉「允许局域网访问」开关即可恢复；若地址来自 DSH_OPENAI_GATEWAY_HOST，把它改回 127.0.0.1 并重启。`;
  }
  return "网关只绑定 127.0.0.1，但这挡不住同机的其它用户或进程 —— 真正的隔离靠密钥，不要把它配置进任何浏览器端工具或扩展。";
}
function gatewayStatusLines(status) {
  if (!status) return ["正在读取网关状态…"];
  if (status.blockedByEnv) {
    return [
      "已被环境变量 DSH_OPENAI_GATEWAY_ENABLED 停用，网关不会监听端口。",
      "在下面的开关里做出的选择会被记住，但需要先取消该环境变量才会生效。"
    ];
  }
  if (status.running) {
    const endpoint = gatewayEndpoint(status);
    return [
      // ⚠️ 用户 2026-10-04 要求精简（原三句「网关正在运行 / 把外部客户端的… /
      // 地址：…」合并成下面这组短行）。**语义必须保住两条**：
      //   1. 推荐 CC Switch —— 它是本仓库对 Codex/Cline 那类客户端的既有推荐入口；
      //   2. **两种协议都要点名**：Responses API 是后加的，不说就没人知道它存在。
      // ⚠️ 措辞不得写成「可切换」：两个端点同时都在，没有互斥开关（用例会红）。
      "推荐使用 CC Switch 进行网关配置。",
      "协议支持：OpenAI Chat Completions 与 OpenAI Responses API。",
      // 地址单列一行（带端口），它是用户要抄走的东西。
      endpoint ? `API 请求地址：${endpoint}` : "",
      // ⚠️ 绑 0.0.0.0（局域网开关）时，抄走的字面量在任何设备上都连不上
      // （0.0.0.0 不是一台具体设备的地址）——必须当场说明要换成什么。
      // 判据复用宿主侧 isWildcardHost（与本文件其它 host 判据同源）。
      isWildcardHost(status.address?.host) ? "其它设备请把地址里的 0.0.0.0 换成本机的局域网 IP（ipconfig 可查）。" : "",
      // ⚠️ 暴露面变了必须**明说**（issue IKL7UN）。原先「只绑定 127.0.0.1」是
      // 常量文案，host 可配之后它就是错误陈述 —— 用户会以为「外面连不上是
      // 设计如此」而放弃排查。反之，回环部署下**不加这句**，避免把刚精简过的
      // 三行文案重新撑肿（精简是用户 2026-10-04 的明确要求）。
      gatewayLoopbackOnly(status) ? "" : nonLoopbackNotice(status)
    ].filter(Boolean);
  }
  if (status.enabled) {
    return [
      "已选择开启，但网关当前没有在监听。",
      // ⚠️ 有真实原因时**如实转述**（Issue #11 建议 ②）。原先这句「最常见的原因
      // 是端口被其它程序占用」是**猜的**：当真实原因是「配置/密钥初始化失败」或
      // 「插件没注册工厂」时，用户会照着它去查端口，永远查不出问题 —— 报障者正是
      // 因此把它误读成 API-key 问题。宿主侧现在回传 `lastError`。
      ...gatewayFailureReason(status) !== "" ? [`启动失败的原因：${gatewayFailureReason(status)}`] : ["最常见的原因是端口被其它程序占用 —— 换 DSH_OPENAI_GATEWAY_PORT 后重启即可。"]
    ];
  }
  return ["网关已关闭，不会监听任何端口。"];
}
function gatewaySwitchDisabled(status) {
  if (!status) return true;
  return status.blockedByEnv;
}
function gatewayAllowLanSwitchDisabled(status) {
  if (!status) return true;
  return status.hostFromEnv === true;
}
function gatewayAllowLanHint(status) {
  if (!status) return "";
  if (status.hostFromEnv) {
    return "已由环境变量 DSH_OPENAI_GATEWAY_HOST 显式指定监听地址，本开关此刻不生效；删除该环境变量并重启 DSH 后才能用这里的选择。";
  }
  if (status.allowLan && status.running) {
    return "已监听全部网卡（0.0.0.0）：同一局域网内的设备都能连到网关，隔离只靠 API Key——不要把它配置进任何浏览器端工具或扩展。";
  }
  if (status.allowLan) {
    return "已选择允许局域网访问（0.0.0.0），但网关当前没有在监听：打开网关总开关后才会真正绑定全部网卡。";
  }
  return "默认只绑定 127.0.0.1，仅本机能访问。打开后网关改绑 0.0.0.0，同一局域网内的设备可凭 API Key 连到网关。";
}
function gatewayAllowLanToggleNotice(status, nextAllowLan) {
  if (status?.hostFromEnv) {
    return "选择已保存，但 DSH_OPENAI_GATEWAY_HOST 已显式指定监听地址，本开关此刻不生效。";
  }
  if (!nextAllowLan) {
    if (status?.running) return `已恢复默认监听：${gatewayEndpoint(status)}`;
    return "已恢复只绑定 127.0.0.1（网关当前未在监听）。";
  }
  if (status?.running) {
    return "已改绑 0.0.0.0：其它设备用「这台电脑的局域网 IP:8326/v1」+ API Key 访问。";
  }
  if (gatewayFailureReason(status) !== "") {
    return `已保存选择，但网关换绑失败：${gatewayFailureReason(status)}`;
  }
  return "已选择允许局域网访问，但网关当前没有在监听（先打开网关总开关）。";
}
function gatewayToggleNotice(status, nextEnabled) {
  if (status?.blockedByEnv) {
    return "选择已保存，但 DSH_OPENAI_GATEWAY_ENABLED 仍在停用网关，取消它才会生效。";
  }
  if (!nextEnabled) return "网关已关闭，不再监听端口。";
  if (status?.running) return `网关已启动：${gatewayEndpoint(status)}`;
  if (gatewayFailureReason(status) !== "") {
    return `已选择开启，但网关启动失败：${gatewayFailureReason(status)}`;
  }
  return "已选择开启，但网关没有在监听，请检查端口是否被占用。";
}

// plugin-src/client/model-center.js
function providerModelSummary(models) {
  const list = Array.isArray(models) ? models : [];
  let disabled = 0;
  let dead = 0;
  for (const model of list) {
    if (model !== null && typeof model === "object" && model.disabled === true) disabled += 1;
    if (model !== null && typeof model === "object" && model.dead === true) dead += 1;
  }
  return { total: list.length, disabled, dead };
}
function centerBulkState(models) {
  const list = Array.isArray(models) ? models : [];
  let controllable = 0;
  let disabled = 0;
  for (const model of list) {
    if (model === null || typeof model !== "object") continue;
    if (model.dead === true) continue;
    controllable += 1;
    if (model.disabled === true) disabled += 1;
  }
  return {
    allDisabled: controllable > 0 && disabled >= controllable,
    noneDisabled: controllable > 0 && disabled === 0
  };
}
function providerMatchesQuery(provider, query) {
  const needle = typeof query === "string" ? query.trim().toLowerCase() : "";
  if (needle.length === 0) return false;
  const label = typeof provider?.label === "string" ? provider.label.toLowerCase() : "";
  const id = typeof provider?.id === "string" ? provider.id.toLowerCase() : "";
  return label.includes(needle) || id.includes(needle);
}
function centerSectionFor(provider, state, options = {}) {
  const phase = typeof state?.phase === "string" ? state.phase : "idle";
  const loaded = phase === "ready";
  const all = Array.isArray(state?.models) ? state.models : [];
  const filtering = isFilterActive(options);
  const nameHit = providerMatchesQuery(provider, options?.query);
  const models = loaded ? filterModels(all, { query: nameHit ? "" : options?.query, status: options?.status }) : [];
  const hit = !filtering || !loaded || nameHit ? true : models.length > 0;
  return {
    id: typeof provider?.id === "string" ? provider.id : "",
    label: typeof provider?.label === "string" ? provider.label : "",
    phase,
    loaded,
    error: typeof state?.error === "string" ? state.error : "",
    models,
    summary: providerModelSummary(all),
    filtering,
    nameHit,
    matched: models.length,
    hit
  };
}
function visibleCenterSections(providers, states, options = {}) {
  const list = Array.isArray(providers) ? providers : [];
  const map = states !== null && typeof states === "object" ? states : {};
  const out = [];
  for (const provider of list) {
    const id = typeof provider?.id === "string" ? provider.id : "";
    const section = centerSectionFor(provider, map[id], options);
    if (section.hit) out.push(section);
  }
  return out;
}
function centerTotals(providers, states) {
  const list = Array.isArray(providers) ? providers : [];
  const map = states !== null && typeof states === "object" ? states : {};
  let loaded = 0;
  let total = 0;
  let disabled = 0;
  for (const provider of list) {
    const id = typeof provider?.id === "string" ? provider.id : "";
    if (id.length === 0) continue;
    const state = map[id];
    if (state?.phase !== "ready") continue;
    loaded += 1;
    const summary = providerModelSummary(state.models);
    total += summary.total;
    disabled += summary.disabled;
  }
  return { loaded, total, disabled };
}
function centerPendingProviderIds(providers, states) {
  const list = Array.isArray(providers) ? providers : [];
  const map = states !== null && typeof states === "object" ? states : {};
  const out = [];
  for (const provider of list) {
    const id = typeof provider?.id === "string" ? provider.id : "";
    if (id.length === 0) continue;
    const phase = typeof map[id]?.phase === "string" ? map[id].phase : "idle";
    if (phase !== "ready") out.push(id);
  }
  return out;
}

// plugin-src/client/aggregate-panel-logic.js
function sortModelsForPanel(models) {
  if (!Array.isArray(models)) return [];
  return [...models].sort((a, b) => {
    const byCount = (b?.candidates?.length ?? 0) - (a?.candidates?.length ?? 0);
    if (byCount !== 0) return byCount;
    return String(a?.canonicalId ?? "").localeCompare(String(b?.canonicalId ?? ""));
  });
}
function candidateStateOf(canonicalId, candidate, rejections) {
  if (typeof candidate?.state === "string") return candidate.state;
  return isRejected(rejections, canonicalId, candidate?.provider, candidate?.realId) ? "rejected" : "allowed";
}
function rejectionsFromCatalog(models) {
  const out = {};
  if (!Array.isArray(models)) return out;
  for (const model of models) {
    const canonicalId = model?.canonicalId;
    if (typeof canonicalId !== "string" || canonicalId.length === 0) continue;
    if (!Array.isArray(model.candidates)) continue;
    for (const candidate of model.candidates) {
      if (candidate?.rejected !== true) continue;
      if (typeof candidate.state === "string") {
        if (candidate.state !== "rejected") continue;
      }
      const provider = candidate.provider;
      const realId = candidate.realId;
      if (typeof provider !== "string" || provider.length === 0) continue;
      if (typeof realId !== "string" || realId.length === 0) continue;
      if (!Object.hasOwn(out, canonicalId)) out[canonicalId] = {};
      if (!Object.hasOwn(out[canonicalId], provider)) out[canonicalId][provider] = {};
      out[canonicalId][provider][realId] = true;
    }
  }
  return out;
}
function sortCandidatesByExpiry(rows) {
  if (!Array.isArray(rows)) return [];
  const of = (row) => {
    const value = row?.expiry;
    if (value === -1) return Number.POSITIVE_INFINITY;
    return typeof value === "number" && Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
  };
  return [...rows].sort((a, b) => {
    const expiryA = of(a);
    const expiryB = of(b);
    if (expiryA !== expiryB) return expiryA - expiryB;
    return String(a?.provider ?? "").localeCompare(String(b?.provider ?? ""));
  });
}
function expiryLabel(expiry, nowMs = Date.now()) {
  if (typeof expiry !== "number" || Number.isNaN(expiry)) return "?";
  if (expiry === -1) return "查不到";
  if (!Number.isFinite(expiry)) return "长期";
  if (expiry <= 0) return "?";
  const diff = expiry - nowMs;
  if (diff <= 0) return "已过期";
  const minutes = Math.floor(diff / 6e4);
  if (minutes < 1) return "不到 1 分钟";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}
function candidateRowLabel(candidate) {
  const provider = typeof candidate?.provider === "string" ? candidate.provider : "?";
  const realId = typeof candidate?.realId === "string" ? candidate.realId : "?";
  const parts = [provider, realId];
  const price = candidate?.price;
  if (typeof price === "number" && Number.isFinite(price)) {
    parts.push(price === 0 ? "免费" : `x${price}`);
  }
  let label = parts.join(" · ");
  if (candidate?.viaPatch === true) label += " ⚠️补丁";
  return label;
}
function isRejected(rejections, canonicalId, provider, realId) {
  if (typeof rejections !== "object" || rejections === null || Array.isArray(rejections)) return false;
  const byProvider = rejections[canonicalId];
  if (typeof byProvider !== "object" || byProvider === null || Array.isArray(byProvider)) return false;
  const byRealId = byProvider[provider];
  if (typeof byRealId !== "object" || byRealId === null || Array.isArray(byRealId)) return false;
  return byRealId[realId] === true;
}
function toggleRejection(rejections, canonicalId, provider, realId, rejected) {
  const base = typeof rejections === "object" && rejections !== null && !Array.isArray(rejections) ? rejections : {};
  const next = { ...base };
  const perProvider = { ...next[canonicalId] ?? {} };
  const perRealId = { ...perProvider[provider] ?? {} };
  if (rejected === true) perRealId[realId] = true;
  else delete perRealId[realId];
  if (Object.keys(perRealId).length === 0) delete perProvider[provider];
  else perProvider[provider] = perRealId;
  if (Object.keys(perProvider).length === 0) delete next[canonicalId];
  else next[canonicalId] = perProvider;
  return next;
}
function candidateKeyOf(candidate) {
  const provider = typeof candidate?.provider === "string" ? candidate.provider : "";
  const realId = typeof candidate?.realId === "string" ? candidate.realId : "";
  return `${provider}\0${realId}`;
}
function candidateToggleAction(canonicalId, candidate, resolved) {
  const state = typeof resolved?.state === "string" ? resolved.state : candidate?.state;
  const payload = {
    canonicalId,
    provider: candidate?.provider,
    realId: candidate?.realId
  };
  if (state === "rejected") {
    return { rpc: "aggregate.setRejected", payload: { ...payload, rejected: false } };
  }
  if (state === "allowed") {
    return candidate?.expiryWired === false ? { rpc: "aggregate.setAllowed", payload: { ...payload, allowed: false } } : { rpc: "aggregate.setRejected", payload: { ...payload, rejected: true } };
  }
  return { rpc: "aggregate.setAllowed", payload: { ...payload, allowed: true } };
}
function describeCandidateState(candidate, resolved) {
  const state = typeof resolved?.state === "string" ? resolved.state : candidate?.state;
  if (state === "rejected") {
    return {
      label: "已拒绝",
      title: "你拒绝了这个渠道参与该模型的轮换。点击恢复参与。",
      pressed: false
    };
  }
  if (state === "default-rejected") {
    return {
      label: "无临期积分 · 未参与",
      title: "该渠道没有临期积分折算，默认不参与轮换。点击手工打开（打开后它会排在所有能算出临期的候选之后）。",
      pressed: false
    };
  }
  if (state === "allowed") {
    if (candidate?.expiryWired === false) {
      return {
        label: "参与（无临期信息）",
        title: "该渠道没有临期积分折算，但你已经手工打开它参与轮换。它没有临期值，故排在所有能算出临期的候选之后（手工模式下可拖动调整它在前面的位置）。",
        pressed: true
      };
    }
    return { label: "参与轮换", title: "该渠道参与这个模型的轮换。点击可拒绝。", pressed: true };
  }
  return {
    label: "状态未知",
    title: "宿主返回的候选状态无法识别（可能是版本不匹配）。点击将按「手工打开」处理。",
    pressed: false
  };
}
function rotationBlockerOf(model, rejections) {
  const candidates = model?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return "none";
  const canonicalId = model?.canonicalId;
  const states = candidates.map((candidate) => candidateStateOf(canonicalId, candidate, rejections));
  if (states.some((state) => state === "allowed")) return "none";
  const hasRejected = states.some((state) => state === "rejected");
  const hasDefault = states.some((state) => state === "default-rejected");
  if (hasRejected && hasDefault) return "mixed";
  if (hasDefault) return "all-default";
  if (hasRejected) return "all-rejected";
  return "none";
}
function rankCandidatesForPanel(candidates, rankMap, expiryOf) {
  if (!Array.isArray(candidates)) return [];
  const rankOf = (candidate) => {
    const index = rankMap?.get?.(candidateKeyOf(candidate));
    return typeof index === "number" ? index : Number.POSITIVE_INFINITY;
  };
  const expiryOfCandidate = (candidate) => {
    const value = expiryOf?.(candidate?.provider);
    if (value === -1) return Number.POSITIVE_INFINITY;
    return typeof value === "number" && !Number.isNaN(value) ? value : Number.POSITIVE_INFINITY;
  };
  return [...candidates].sort((a, b) => {
    const rankA = rankOf(a);
    const rankB = rankOf(b);
    if (rankA !== rankB) return rankA - rankB;
    const expiryA = expiryOfCandidate(a);
    const expiryB = expiryOfCandidate(b);
    if (expiryA !== expiryB) return expiryA - expiryB;
    const priceA = typeof a?.price === "number" ? a.price : Number.POSITIVE_INFINITY;
    const priceB = typeof b?.price === "number" ? b.price : Number.POSITIVE_INFINITY;
    return priceA - priceB;
  });
}
function rotationRosterOf(model, rankMap, expiryOf, rejections) {
  const all = Array.isArray(model?.candidates) ? model.candidates : [];
  const canonicalId = model?.canonicalId;
  const isParticipating = (candidate) => candidateStateOf(canonicalId, candidate, rejections) === "allowed";
  const participating = rankCandidatesForPanel(
    all.filter(isParticipating),
    rankMap,
    expiryOf
  );
  const inactive = all.filter((candidate) => !isParticipating(candidate));
  return { participating, inactive };
}
function moveCandidateTo(order, key, targetIndex) {
  const list = Array.isArray(order) ? order : [];
  const index = list.indexOf(key);
  if (index < 0) return [...list];
  const next = [...list];
  const target = Number.isFinite(targetIndex) ? targetIndex : index;
  const clamped = Math.max(0, Math.min(next.length - 1, target));
  if (clamped === index) return next;
  const [moved] = next.splice(index, 1);
  next.splice(clamped, 0, moved);
  return next;
}
function pendingOrderFromRoster(participating) {
  if (!Array.isArray(participating)) return [];
  return participating.map(candidateKeyOf);
}
function shouldReprobeExpiry(input) {
  const orderMode = input?.orderMode;
  if (orderMode !== "expiry") return false;
  if (input?.hidden === true) return false;
  return true;
}
function startExpiryReprobe(options) {
  const {
    orderMode,
    intervalMs,
    isHidden = () => false,
    probe,
    schedule = (fn, ms) => setInterval(fn, ms),
    cancel = (handle2) => clearInterval(handle2)
  } = options ?? {};
  if (orderMode !== "expiry") return () => {
  };
  if (typeof probe !== "function") return () => {
  };
  const handle = schedule(() => {
    if (!shouldReprobeExpiry({ orderMode, hidden: isHidden() === true })) return;
    probe();
  }, intervalMs);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    cancel(handle);
  };
}

// plugin-src/client/provider-toggle.js
function groupProviders(providers, statuses) {
  const list = Array.isArray(providers) ? providers : [];
  const map = statuses && typeof statuses === "object" ? statuses : {};
  const open = [];
  const closed = [];
  for (const provider of list) {
    const isClosed = map[provider?.id]?.closed === true;
    if (isClosed) closed.push(provider);
    else open.push(provider);
  }
  return { open, closed };
}
function providerSwitchState(status) {
  if (status === void 0 || status === null || typeof status !== "object") {
    return { checked: true, disabled: true, reason: "状态尚未读取" };
  }
  const total = typeof status.models?.total === "number" ? status.models.total : 0;
  if (status.closed === true) return { checked: false, disabled: false, reason: null };
  if (total <= 0) {
    return {
      checked: true,
      disabled: true,
      reason: "该供应商没有可关闭的模型"
    };
  }
  return { checked: true, disabled: false, reason: null };
}
function summarizeProviderToggle(enabled, res) {
  const models = typeof res?.models === "number" ? res.models : 0;
  const accounts = typeof res?.accounts === "number" ? res.accounts : 0;
  if (enabled) {
    const parts2 = [];
    parts2.push(models > 0 ? `已打开 ${models} 个模型` : "模型本就全部打开");
    parts2.push(accounts > 0 ? `已启用 ${accounts} 个账号` : "账号本就全部启用");
    return parts2.join("，");
  }
  const parts = [];
  parts.push(models > 0 ? `已关闭 ${models} 个模型` : "没有模型需要关闭");
  parts.push(accounts > 0 ? `已停用 ${accounts} 个账号` : "没有账号需要停用");
  return parts.join("，");
}
function sortOpenProvidersByOrder(openProviders, order, declaredOrder) {
  const list = Array.isArray(openProviders) ? openProviders : [];
  const seq = Array.isArray(order) ? order : [];
  if (seq.length === 0) return list;
  const rank = /* @__PURE__ */ new Map();
  for (let index = 0; index < seq.length; index++) {
    const id = seq[index];
    if (typeof id === "string" && id.length > 0 && !rank.has(id)) rank.set(id, index);
  }
  if (rank.size === 0) return list;
  const declared = Array.isArray(declaredOrder) ? declaredOrder : [];
  if (declared.length > 0) {
    const anchorOf = /* @__PURE__ */ new Map();
    for (let index = 0; index < declared.length; index++) {
      const id = declared[index];
      if (typeof id !== "string" || id.length === 0) continue;
      if (rank.has(id)) continue;
      let anchor = null;
      for (let back = index - 1; back >= 0; back--) {
        const prev = declared[back];
        if (rank.has(prev) || anchorOf.has(prev)) {
          anchor = prev;
          break;
        }
      }
      anchorOf.set(id, anchor);
    }
    if (anchorOf.size > 0) {
      const effective = new Map(rank);
      for (const [id, anchor] of anchorOf) {
        const declaredIndex = declared.indexOf(id);
        const anchorKey = anchor === null ? -1 : effective.get(anchor) ?? -1;
        effective.set(id, anchorKey + declaredIndex / (declared.length + 1));
      }
      return [...list].sort((a, b) => {
        const ra = effective.get(a?.id);
        const rb = effective.get(b?.id);
        if (ra !== void 0 && rb !== void 0) return ra - rb;
        if (ra !== void 0) return -1;
        if (rb !== void 0) return 1;
        return 0;
      });
    }
  }
  return [...list].sort((a, b) => {
    const ra = rank.get(a?.id);
    const rb = rank.get(b?.id);
    if (ra !== void 0 && rb !== void 0) return ra - rb;
    if (ra !== void 0) return -1;
    if (rb !== void 0) return 1;
    return 0;
  });
}
function nextProviderOrderAfterDrop(openIds, closedIds, sourceId, targetId, position, oldOrder) {
  const moved = orderAfterDrop(openIds, sourceId, targetId, position);
  if (moved === null) return null;
  if (!Array.isArray(closedIds) || closedIds.length === 0) return moved;
  if (!Array.isArray(oldOrder) || oldOrder.length === 0) return [...moved, ...closedIds];
  const openSet = new Set(openIds);
  const closedSet = new Set(closedIds);
  const predecessor = /* @__PURE__ */ new Map();
  let lastOpen = null;
  for (const id of oldOrder) {
    if (openSet.has(id)) {
      lastOpen = id;
      continue;
    }
    if (closedSet.has(id) && !predecessor.has(id)) predecessor.set(id, lastOpen);
  }
  const result = [...moved];
  const orphans = [];
  const groups = /* @__PURE__ */ new Map();
  for (const id of oldOrder) {
    if (!closedSet.has(id) || !predecessor.has(id)) continue;
    const pred = predecessor.get(id);
    if (pred === null) {
      orphans.push(id);
      continue;
    }
    if (!groups.has(pred)) groups.set(pred, []);
    groups.get(pred).push(id);
  }
  for (const [pred, ids] of groups) {
    const at = result.indexOf(pred);
    if (at === -1) {
      orphans.push(...ids);
      continue;
    }
    result.splice(at + 1, 0, ...ids);
  }
  for (const id of closedIds) if (!result.includes(id)) orphans.push(id);
  for (const id of orphans) result.push(id);
  return result;
}
function nextProviderOrderAfterGroupDrop(openIds, closedIds, sourceId, targetId, position, oldOrder) {
  const open = Array.isArray(openIds) ? openIds : [];
  const closed = Array.isArray(closedIds) ? closedIds : [];
  const sourceInOpen = open.includes(sourceId);
  const targetInOpen = open.includes(targetId);
  const sourceInClosed = closed.includes(sourceId);
  const targetInClosed = closed.includes(targetId);
  if (sourceInOpen && targetInOpen) {
    return nextProviderOrderAfterDrop(open, closed, sourceId, targetId, position, oldOrder);
  }
  if (sourceInClosed && targetInClosed) {
    const moved = orderAfterDrop(closed, sourceId, targetId, position);
    if (moved === null) return null;
    return [...open, ...moved];
  }
  return null;
}
function providerSwitchRows(providers, statuses, order) {
  const { open, closed } = groupProviders(providers, statuses);
  const orderedOpen = sortOpenProvidersByOrder(open, order);
  const orderedClosed = sortOpenProvidersByOrder(closed, order);
  const toRow = (provider) => {
    const id = provider?.id;
    const status = statuses && typeof statuses === "object" ? statuses[id] : void 0;
    const sw = providerSwitchState(status);
    return {
      id,
      label: provider?.label || id,
      checked: sw.checked,
      disabled: sw.disabled,
      reason: sw.reason,
      models: status?.models ?? null,
      accounts: status?.accounts ?? null
    };
  };
  return [...orderedOpen.map(toRow), ...orderedClosed.map(toRow)];
}
function providerToggleSummary(providers, statuses) {
  const list = Array.isArray(providers) ? providers : [];
  const { open, closed } = groupProviders(list, statuses);
  return {
    open: open.length,
    closed: closed.length,
    total: list.length,
    known: statuses !== null && statuses !== void 0 && typeof statuses === "object"
  };
}

// plugin-src/client/model-bulk.js
function bulkButtonState(models, busy) {
  if (busy || !models || models.length === 0) {
    return { openAllDisabled: true, closeAllDisabled: true };
  }
  const anyDisabled = models.some((m) => m.disabled);
  const anyEnabled = models.some((m) => !m.disabled);
  return { openAllDisabled: !anyDisabled, closeAllDisabled: !anyEnabled };
}

// plugin-src/client/model-groups.js
var BILLING_GROUPS = Object.freeze([
  Object.freeze({ key: "subscription", label: "订阅额度", hint: "Cline Pass 订阅模型（cline-pass/*）" }),
  Object.freeze({ key: "free", label: "免费额度", hint: "Cline 远端 free 集合（含 cline-free/* 与 stealth/*）" }),
  Object.freeze({ key: "cloud", label: "Cline Cloud", hint: "Cline Cloud 模型（cline-cloud/*）" }),
  Object.freeze({ key: "metered", label: "按量计费", hint: "其余模型：走账户余额按量结算" })
]);
var METERED_GROUP_KEY = "metered";
function billingGroupOf(model) {
  if (model?.isFree === true) return "free";
  const id = typeof model?.id === "string" ? model.id : "";
  if (id.startsWith("cline-pass/")) return "subscription";
  if (id.startsWith("cline-cloud/")) return "cloud";
  return METERED_GROUP_KEY;
}
function groupModelsForDisplay(models, options = {}) {
  const list = Array.isArray(models) ? models : [];
  const buckets = new Map(BILLING_GROUPS.map((group) => [group.key, []]));
  for (const model of list) {
    const key = billingGroupOf(model);
    const bucket = buckets.get(key);
    if (bucket === void 0) continue;
    bucket.push(model);
  }
  const groups = [];
  for (const definition of BILLING_GROUPS) {
    const total = buckets.get(definition.key) ?? [];
    if (total.length === 0) continue;
    const shown = filterModels(total, options);
    if (shown.length === 0) continue;
    groups.push({
      key: definition.key,
      label: definition.label,
      hint: definition.hint,
      models: shown,
      counts: {
        total: total.length,
        shown: shown.length,
        disabled: shown.filter((model) => model.disabled === true).length
      }
    });
  }
  return groups;
}
function groupExpanded(group, options = {}) {
  const toggled = options.toggled;
  if (toggled === true || toggled === false) return toggled;
  if (options.filterActive === true) return true;
  return group?.key !== METERED_GROUP_KEY;
}
function groupBulkStateFor(group, busy) {
  return bulkButtonState(group?.models ?? null, busy);
}

// plugin-src/client/tokens-per-second.js
var TOKENS_PER_SECOND_UNIT = "tok/s";
function formatTokensPerSecond(tps) {
  const value = typeof tps === "number" && Number.isFinite(tps) ? tps : 0;
  const clamped = Math.max(0, value);
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
}
function tokensPerSecond(outputTokens, decodeMs) {
  if (!(typeof decodeMs === "number" && Number.isFinite(decodeMs) && decodeMs > 0)) return null;
  const tokens = typeof outputTokens === "number" && Number.isFinite(outputTokens) ? outputTokens : 0;
  return Math.max(0, tokens) / (decodeMs / 1e3);
}
function formatRowTokensPerSecond(row) {
  if (row?.usageReported !== true) return "—";
  const total = Number(row?.totalMs ?? 0);
  const first = Number(row?.ttftMs ?? 0);
  if (!(first > 0)) return "—";
  const value = tokensPerSecond(Number(row?.outputTokens ?? 0), total - first);
  return value === null ? "—" : `${formatTokensPerSecond(value)} ${TOKENS_PER_SECOND_UNIT}`;
}

// plugin-src/client/token-ledger-panel.js
function formatTokenCount(value) {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  if (n >= 1e6) return trimZeros(n / 1e6) + "M";
  if (n >= 1e4) return trimZeros(n / 1e3) + "K";
  return n.toLocaleString("en-US");
}
function trimZeros(n) {
  return String(Math.round(n * 100) / 100);
}
function channelLabel(channel) {
  return channel === "gateway" ? "网关" : "直连";
}
function channelOrder(a, b) {
  return (a === "direct" ? 0 : 1) - (b === "direct" ? 0 : 1);
}
function tokenSummaryText(row) {
  if (!row || typeof row !== "object") return "—";
  return "总处理 " + formatTokenCount(totalTokensOf(row));
}
function totalTokensOf(row) {
  if (!row || typeof row !== "object") return 0;
  const total = Number(row.totalTokens);
  if (Number.isFinite(total) && total >= 0) return total;
  const count = (value) => {
    const n = Number(value ?? 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  return count(row.inputTokens) + count(row.cacheReadTokens) + count(row.outputTokens);
}
function tokenSummaryTooltip(row) {
  if (!row || typeof row !== "object") return "暂无 Token 用量";
  const lines = [
    tokenSummaryText(row),
    "↓ 输入 " + formatTokenCount(row.inputTokens ?? 0),
    "↑ 输出 " + formatTokenCount(row.outputTokens ?? 0)
  ];
  if ((row.cacheReadTokens ?? 0) > 0) lines.push("⚡ 缓存命中 " + formatTokenCount(row.cacheReadTokens));
  if ((row.cacheWriteTokens ?? 0) > 0) lines.push("✎ 缓存写入 " + formatTokenCount(row.cacheWriteTokens) + "（不重复计入总处理量）");
  if ((row.reasoningTokens ?? 0) > 0) lines.push("🧠 推理 " + formatTokenCount(row.reasoningTokens) + "（已包含在输出中）");
  lines.push("总处理量 = 输入 + 输出；缓存写入不重复计入");
  return lines.join("\n");
}
function entryTokenText(entry2) {
  if (entry2?.usageReported !== true) return "—";
  return tokenSummaryText(entry2);
}
function formatDuration(ms) {
  const n = typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0;
  if (n === 0) return "—";
  if (n < 1e3) return n + "ms";
  return trimZeros(n / 1e3) + "s";
}
function formatTtft(entry2) {
  const n = typeof entry2?.ttftMs === "number" && Number.isFinite(entry2.ttftMs) && entry2.ttftMs > 0 ? Math.round(entry2.ttftMs) : 0;
  if (n === 0) return "—";
  return formatDuration(n);
}
function formatTps(entry2) {
  const v = entry2?.tps;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return "—";
  return v + " tok/s";
}
function avgPerfText(row) {
  const ttft = typeof row?.avgTtftMs === "number" && row.avgTtftMs > 0 ? formatDuration(row.avgTtftMs) : null;
  const speed = typeof row?.p50Tps === "number" && row.p50Tps > 0 ? "P50 " + row.p50Tps : typeof row?.avgTps === "number" && row.avgTps > 0 ? "均值 " + row.avgTps : null;
  if (ttft === null && speed === null) return "—";
  return (ttft === null ? "" : "首字 " + ttft) + (speed === null ? "" : (ttft === null ? "" : " · ") + speed + " tok/s");
}
function avgPerfTooltip() {
  return "性能统计：首字时间取可测请求的算术平均；输出速率均值对离群样本敏感。完整样本的 P50/P90 使用对数直方图估算，桶宽约 9%。「首字」= 首个内容 chunk 到达前的耗时；「速率」= 全部输出 token ÷（首块之后 → 结束）的时长，要求解码时长 ≥ 100ms（过短视为不可测、不计入）。算术均值对离群样本敏感；旧版日账本没有分布数据，完成升级后新累计的完整日期才显示 P50/P90。";
}
function avgPerfDetailTooltip(row) {
  return avgPerfTooltip() + "\n均值 " + (row?.avgTps ?? "—") + " tok/s · P50 " + (row?.p50Tps ?? "—") + " tok/s · P90 " + (row?.p90Tps ?? "—") + " tok/s";
}
var HISTORY_RANGES = [
  { key: "today", label: "今日", days: 1 },
  { key: "7d", label: "近 7 天", days: 7 },
  { key: "30d", label: "近 30 天", days: 30 },
  { key: "all", label: "全部", days: 0 }
];
function rangeDaysOf(key) {
  const hit = HISTORY_RANGES.find((r) => r.key === key);
  return hit === void 0 ? 0 : hit.days;
}
function todayDayKey() {
  const shifted = new Date(Date.now() + 8 * 60 * 60 * 1e3);
  const pad = (x) => String(x).padStart(2, "0");
  return shifted.getUTCFullYear() + "-" + pad(shifted.getUTCMonth() + 1) + "-" + pad(shifted.getUTCDate());
}
function historyHeatmapCells(historyDays, days = 30, endDay = todayDayKey()) {
  const count = Math.max(1, Math.min(90, Math.trunc(Number(days) || 30)));
  const [year, month, date] = String(endDay).slice(0, 10).split("-").map(Number);
  const end = new Date(Date.UTC(year, month - 1, date));
  const today = todayDayKey();
  const totalsByDay = new Map((Array.isArray(historyDays) ? historyDays : []).filter((row) => typeof row?.day === "string").map((row) => [row.day, row]));
  const rows = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const d = new Date(end.getTime() - offset * 864e5);
    const day = d.toISOString().slice(0, 10);
    const row = totalsByDay.get(day);
    rows.push({
      day,
      isToday: day === today,
      requests: row?.totals?.requests ?? 0,
      tokens: totalTokensOf(row?.totals),
      level: 0
    });
  }
  const maxTokens = rows.reduce((max, row) => Math.max(max, row.tokens), 0);
  for (const row of rows) {
    if (row.tokens > 0 && maxTokens > 0) {
      row.level = Math.min(4, Math.max(1, Math.ceil(row.tokens / maxTokens * 4)));
    }
  }
  return rows;
}
function historyTitle(rangeKey) {
  const hit = HISTORY_RANGES.find((r) => r.key === rangeKey);
  return "历史用量 · " + (hit === void 0 ? "全部" : hit.label);
}
function formatEntryTime(ts) {
  const d = typeof ts === "number" && Number.isFinite(ts) ? new Date(ts) : null;
  if (d === null || Number.isNaN(d.getTime())) return "—";
  const pad = (x) => String(x).padStart(2, "0");
  return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
}
function ledgerSubtitle() {
  return "本机流水 · 明细重启清空 · 日累计已存盘";
}
function accountLabel(accountId) {
  return typeof accountId === "string" && accountId.length > 0 ? accountId : "未归属";
}
function channelCardTitle(channelRow) {
  const requests = channelRow?.totals?.requests ?? 0;
  return channelLabel(channelRow?.channel) + " · " + requests + " 次请求";
}
function hasAnyData(snapshot) {
  return (snapshot?.entries?.length ?? 0) > 0;
}

// plugin-src/client/backup-crypto.js
var KDF_ITERATIONS = 31e4;
var KEY_LENGTH_BITS = 256;
var SALT_BYTES = 16;
var IV_BYTES = 12;
function isEncryptedBackup(value) {
  return typeof value === "object" && value !== null && typeof value.kdf === "string" && typeof value.ciphertext === "string";
}
async function encryptBackup(payload, passphrase) {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt, KDF_ITERATIONS, ["encrypt"]);
  const plaintext = encoder.encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return {
    format: "dsh-codearts-auth/backup.encrypted",
    kdf: "PBKDF2",
    hash: "SHA-256",
    iterations: KDF_ITERATIONS,
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(ciphertext))
  };
}
async function decryptBackup(container, passphrase) {
  if (!isEncryptedBackup(container)) {
    throw new Error("不是加密备份文件");
  }
  const salt = fromBase64(container.salt);
  const iv = fromBase64(container.iv);
  const ciphertext = fromBase64(container.ciphertext);
  const iterations = Number.isSafeInteger(container.iterations) && container.iterations > 0 ? container.iterations : KDF_ITERATIONS;
  const key = await deriveKey(passphrase, salt, iterations, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext));
}
async function deriveKey(passphrase, salt, iterations, usages) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: KEY_LENGTH_BITS },
    false,
    usages
  );
}
function toBase64(bytes) {
  let binary = "";
  const chunk = 32768;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
function fromBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// plugin-src/client/credits-format.js
function formatCredits(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
function formatTokens(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const abs = Math.abs(value);
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
  return String(Math.round(value));
}
var QUOTA_UNIT = "%";
function formatQuota(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return `${Math.round(value)}%`;
}
function normalizeUnit(unit) {
  return unit === "token" ? "token" : "credit";
}
function formatUnits(value, unit) {
  if (unit === "token") return formatTokens(value);
  if (unit === QUOTA_UNIT) return formatQuota(value);
  return formatCredits(value);
}
function unitLabel(unit) {
  if (unit === "token") return "Token";
  if (unit === QUOTA_UNIT) return "额度";
  return "积分";
}
function formatClaimGains(totals) {
  if (totals === null || typeof totals !== "object") return null;
  const parts = [];
  for (const unit of ["token", "credit"]) {
    const value = Number(totals[unit]);
    if (!Number.isFinite(value) || value <= 0) continue;
    parts.push(`+${formatUnits(value, unit)}${unitLabel(unit)}`);
  }
  return parts.length === 0 ? null : parts.join(", ");
}
function formatQuotaLine(packages, unit) {
  if (unit !== QUOTA_UNIT || !Array.isArray(packages)) return null;
  const parts = [];
  for (const pkg of packages) {
    if (!pkg) continue;
    const value = formatQuota(pkg.remaining);
    if (value === null) continue;
    parts.push(`${pkg.name || "未命名"} ${value}`);
  }
  return parts.length === 0 ? null : parts.join(" · ");
}
function formatQuotaDetail(packages) {
  if (!Array.isArray(packages)) return null;
  const lines = [];
  for (const pkg of packages) {
    if (!pkg) continue;
    const value = formatQuota(pkg.remaining);
    if (value === null) continue;
    const reset = typeof pkg.cycleEndTime === "string" && pkg.cycleEndTime.length > 0 ? ` · 重置于 ${pkg.cycleEndTime}` : "";
    lines.push(`${pkg.name || "未命名"}：剩余 ${value}${reset}`);
  }
  return lines.length === 0 ? null : lines.join("\n");
}

// plugin-src/client/quota-format.js
var QUOTA_WINDOWS = Object.freeze([
  ["five_hour", "5 小时"],
  ["weekly", "本周"],
  ["monthly", "本月"]
]);
function quotaWindowsOf(windows) {
  const known = new Map(windows.map((win) => [String(win.type), win]));
  const ordered = QUOTA_WINDOWS.filter(([type]) => known.has(type)).map(([type, label]) => [type, label, known.get(type)]);
  const extra = windows.filter((win) => !QUOTA_WINDOWS.some(([type]) => type === String(win.type))).map((win) => [String(win.type), String(win.type), win]);
  return [...ordered, ...extra];
}
function quotaCountdown(resetsAt) {
  const at = Date.parse(String(resetsAt ?? ""));
  if (!Number.isFinite(at)) return "";
  const minutes = Math.round((at - Date.now()) / 6e4);
  if (minutes <= 0) return "";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes % 1440 / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${mins} 分钟`;
  return `${Math.max(1, mins)} 分钟`;
}
function quotaResetsIn(resetsAt) {
  const left = quotaCountdown(resetsAt);
  return left === "" ? "" : `${left}后重置`;
}
function quotaTone(percent) {
  if (!Number.isFinite(percent)) return "ok";
  if (percent >= 90) return "error";
  if (percent >= 70) return "warn";
  return "ok";
}
function quotaPercentValue(percent) {
  const n = Number(percent ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}
function formatQuotaPercent(percent) {
  return `${Math.round(quotaPercentValue(percent))}%`;
}

// plugin-src/client/backup-payload.js
function trimBackupPayload(payload, accountIds) {
  const wanted = new Set(Array.isArray(accountIds) ? accountIds : []);
  const accounts = (Array.isArray(payload?.accounts) ? payload.accounts : []).filter((entry2) => entry2 !== null && typeof entry2 === "object" && wanted.has(entry2.id));
  const refs = new Set(
    accounts.map((entry2) => entry2.credentialRef).filter((ref) => typeof ref === "string" && ref.length > 0)
  );
  const credentials = {};
  const source = payload?.credentials !== null && typeof payload?.credentials === "object" ? payload.credentials : {};
  for (const [ref, value] of Object.entries(source)) {
    if (refs.has(ref)) credentials[ref] = value;
  }
  return {
    ...payload,
    accounts,
    credentials,
    // ⚠️⚠️ **`disabledModels` 必须原样保留，不能改成空表**（真实缺陷，对抗审计
    // 实测证伪）。这里原先写的是 `disabledModels: {}`，注释理由是「让这份载荷
    // 无论被哪个版本的后端当成整体替换处理都不会改动模型开关（防误伤）」——
    // **该理由与实现相反**：`replaceAll` 收到空表执行的是
    // `modelCache = sanitizeDisabledModels({})` = `{}`，即**整体清空黑名单**，
    // 不是「不改动」。空表不是中性值，它谎称「这份备份里没有任何被关闭的模型」。
    //
    // 实测（本机）：先关闭 2 个模型 → 导入一份 `disabledModels: {}` 的载荷并走
    // `replace` → `disabledModelsFor(provider)` 变成空集，**用户的模型开关被静默清空**。
    //
    // ⇒ 正确做法是**保留原值**：`accountIds` 的语义本就只作用于 `accounts` 与
    // `credentials` 两个字段（见本模块文件头），黑名单与锁定表都是**全量**的。
    // 这样即便载荷真的被当成 `replace` 处理，落地的也是**备份文件里真实的开关
    // 状态**（`replace` 的正确语义），而不是被篡改成「全关」。
    // 真正防「误当 replace」的防线是**模式白名单**（`src/jet-hub-rpc.ts` 的
    // `req?.mode === 'merge' ? 'merge' : 'replace'`）与 **merge 分支根本不读
    // `disabledModels`**（`src/backup.ts` 的 `credentialsToWrite` 与
    // `pool.mergeAccounts(importedAccounts)`），不是靠篡改字段值。
    disabledModels: payload?.disabledModels !== null && typeof payload?.disabledModels === "object" && !Array.isArray(payload.disabledModels) ? payload.disabledModels : {}
  };
}
function describeBackupAccounts(payload) {
  const accounts = Array.isArray(payload?.accounts) ? payload.accounts : [];
  return accounts.filter((entry2) => entry2 !== null && typeof entry2 === "object" && typeof entry2.id === "string" && entry2.id.length > 0).map((entry2) => ({
    id: entry2.id,
    provider: typeof entry2.provider === "string" ? entry2.provider : "",
    nickname: typeof entry2.nickname === "string" && entry2.nickname.length > 0 ? entry2.nickname : entry2.id,
    enabled: entry2.enabled !== false
  }));
}

// plugin-src/client/backup-convert.js
var BACKUP_FORMAT = "dsh-codearts-auth/backup";
var BACKUP_VERSION = 1;
function decodeJwtPayload(token) {
  if (typeof token !== "string") return void 0;
  const parts = token.split(".");
  if (parts.length < 2) return void 0;
  try {
    let base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (base64.length % 4 !== 0) base64 += "=";
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return void 0;
  }
}
function stableShortId(input) {
  let hash = 2166136261;
  const text = String(input);
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
function isAccountRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const accessToken = value.access_token;
  const refreshToken = value.refresh_token;
  return typeof accessToken === "string" && accessToken.length > 0 && typeof refreshToken === "string" && refreshToken.length > 0;
}
function looksLikeForeignAccountList(value) {
  if (value === null || typeof value !== "object") return false;
  if (!Array.isArray(value) && value.format === BACKUP_FORMAT) return false;
  const list = pickAccountArray(value);
  if (list === null) return false;
  return list.length === 0 || list.some(isAccountRecord);
}
function pickAccountArray(value) {
  if (Array.isArray(value)) return value;
  return pickKnownAccountArray(value);
}
function pickKnownAccountArray(value) {
  if (typeof value !== "object" || value === null) return null;
  for (const key of ["accounts", "data", "items", "list"]) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate;
  }
  return null;
}
function providerFromIssuer(issuer) {
  if (typeof issuer !== "string" || issuer.length === 0) return "buddy";
  const host = hostOf(issuer);
  return host !== void 0 && host.includes("workbuddy") ? "workbuddy" : "buddy";
}
function hostOf(value) {
  if (typeof value !== "string" || value.length === 0) return void 0;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    const trimmed = value.replace(/^[a-z]+:\/\//i, "").split("/")[0];
    return trimmed.length > 0 ? trimmed.toLowerCase() : void 0;
  }
}
function toEpochMsString(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return String(parsed);
    const time = Date.parse(value);
    if (Number.isFinite(time)) return String(time);
  }
  return void 0;
}
function deriveRefreshExpiresAt(record, expiresAtMs) {
  const direct = toEpochMsString(record?.refresh_expires_at ?? record?.refreshExpiresAt);
  if (direct !== void 0) return direct;
  const auth = record?.auth_raw ?? record?.authRaw;
  const expiresIn = Number(auth?.expiresIn);
  const refreshExpiresIn = Number(auth?.refreshExpiresIn);
  if (Number.isFinite(expiresIn) && Number.isFinite(refreshExpiresIn) && expiresAtMs !== void 0 && Number.isFinite(Number(expiresAtMs))) {
    const delta = (refreshExpiresIn - expiresIn) * 1e3;
    if (Number.isFinite(delta)) return String(Number(expiresAtMs) + delta);
  }
  const exp = decodeJwtPayload(record?.refresh_token)?.exp;
  if (typeof exp === "number" && Number.isFinite(exp)) return String(exp * 1e3);
  return void 0;
}
function buildCredential(record) {
  const payload = decodeJwtPayload(record.access_token);
  const accessToken = record.access_token;
  const refreshToken = record.refresh_token;
  const expiresAtMs = toEpochMsString(record.expires_at ?? record.expiresAt);
  const refreshExpiresAtMs = deriveRefreshExpiresAt(record, expiresAtMs);
  const issuerHost = hostOf(payload?.iss);
  const userId = typeof payload?.sub === "string" && payload.sub.length > 0 ? payload.sub : typeof record.uid === "string" && record.uid.length > 0 ? record.uid : void 0;
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    ...expiresAtMs === void 0 ? {} : { expires_at: expiresAtMs },
    ...refreshExpiresAtMs === void 0 ? {} : { refresh_expires_at: refreshExpiresAtMs },
    token_type: typeof record.token_type === "string" && record.token_type.length > 0 ? record.token_type : "Bearer",
    ...issuerHost === void 0 ? {} : { domain: issuerHost },
    ...userId === void 0 ? {} : { user_id: userId },
    ...nicknameOf(record) === void 0 ? {} : { nickname: nicknameOf(record) },
    // 个人版为空串（与真实凭据一致）；企业版记录会自带非空值。
    enterprise_id: typeof record.enterprise_id === "string" ? record.enterprise_id : "",
    account_type: typeof record.account_type === "string" && record.account_type.length > 0 ? record.account_type : "personal"
  };
}
function nicknameOf(record) {
  for (const key of ["nickname", "email", "name", "uid"]) {
    const value = record?.[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return void 0;
}
function convertForeignAccounts(value) {
  if (!looksLikeForeignAccountList(value)) return null;
  const list = pickAccountArray(value) ?? [];
  const credentials = {};
  const accounts = [];
  const warnings = [];
  const usedIds = /* @__PURE__ */ new Set();
  const providers = /* @__PURE__ */ new Set();
  for (let index = 0; index < list.length; index++) {
    const record = list[index];
    if (!isAccountRecord(record)) {
      warnings.push(`第 ${index + 1} 条不是有效的账号记录（缺 access_token / refresh_token），已跳过`);
      continue;
    }
    const provider = providerFromIssuer(decodeJwtPayload(record.access_token)?.iss);
    const identity = typeof record.uid === "string" && record.uid.length > 0 ? record.uid : decodeJwtPayload(record.access_token)?.sub ?? `index-${index}`;
    let short = stableShortId(`${provider}:${identity}`);
    if (usedIds.has(short)) {
      short = stableShortId(`${provider}:${identity}:${index}`);
      warnings.push(`${nicknameOf(record) ?? identity}: 与前面的账号重复，已为其分配独立 id`);
    }
    usedIds.add(short);
    const credentialRef = `${provider.toUpperCase()}_ACCOUNT_${short.toUpperCase()}`;
    const credential = buildCredential(record);
    credentials[credentialRef] = JSON.stringify(credential);
    const expiresAtMs = toEpochMsString(record.expires_at ?? record.expiresAt);
    accounts.push({
      id: `${provider}-${short}`,
      provider,
      nickname: nicknameOf(record) ?? `${provider}-${short}`,
      enabled: record.enabled !== false,
      credentialRef,
      createdAt: createdAtMs(record),
      ...expiresAtMs === void 0 ? {} : { expiresAt: Number(expiresAtMs) },
      // 两个令牌都在才可能静默续期（isAccountRecord 已保证都在）。
      refreshable: true
    });
    providers.add(provider);
  }
  return {
    payload: {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
      credentials,
      accounts,
      // ⚠️ **空表是「如实表达」而非「中性值」**（原注释写的是「避免这份载荷被当成
      // 整体还原时改动模型设置」—— 那是**错的**）：第三方文件里确实不含模型开关
      // 信息，故这里没有更好的值可写；而 `replaceAll` 收到空表会执行
      // `modelCache = sanitizeDisabledModels({})` = `{}`，即**整体清空黑名单**。
      //
      // 风险由**两条**防线承担，不靠篡改这个字段：
      // ① UI 走第三方路径时**默认切到 `merge`**（`jet-hub.js` 的
      //    `setImportMode('merge')`），而 merge 分支**根本不读** `disabledModels`
      //    （`src/backup.ts` 的 `credentialsToWrite` + `pool.mergeAccounts`）；
      // ② 若用户手动改成「整体还原」，清空开关正是 `replace` 的**声明语义**
      //    （用户明确选择了「覆盖当前全部账号与模型开关」，UI 上有红字警告）。
      disabledModels: {}
    },
    warnings,
    accounts,
    providers: Array.from(providers)
  };
}
function createdAtMs(record) {
  const raw = record?.created_at ?? record?.createdAt;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed < 1e12 ? parsed * 1e3 : parsed;
  }
  return Date.now();
}

// plugin-src/client/provider-icons.js
var CODEARTS_ICON = "data:image/png;base64,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";
var CODEBUDDY_ICON = "data:image/png;base64,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";
var WORKBUDDY_ICON = "data:image/png;base64,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";
var LOBSTERAI_ICON = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0Ij48cmVjdCB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHJ4PSI1IiBmaWxsPSIjZTg1MDNhIi8+PHBhdGggZD0iTTEyIDUuNWMtMi40IDAtNC4yIDEuNi00LjIgNHY1LjJjMCAyLjMgMS44IDMuOCA0LjIgMy44czQuMi0xLjUgNC4yLTMuOFY5LjVjMC0yLjQtMS44LTQtNC4yLTR6IiBmaWxsPSIjZmZmIi8+PGNpcmNsZSBjeD0iMTAuMyIgY3k9IjEwLjIiIHI9IjEiIGZpbGw9IiNlODUwM2EiLz48Y2lyY2xlIGN4PSIxMy43IiBjeT0iMTAuMiIgcj0iMSIgZmlsbD0iI2U4NTAzYSIvPjxwYXRoIGQ9Ik04LjQgNy4yIDYuMiA0LjltOS40IDIuMyAyLjItMi4zTTkuOSAxOC41bC0xLjQgMm02LjYtMiAxLjQgMiIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjEuNCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBmaWxsPSJub25lIi8+PC9zdmc+";
var QODER_ICON = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0Ij48cmVjdCB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHJ4PSI1IiBmaWxsPSIjMWYyYTNmIi8+PGNpcmNsZSBjeD0iMTEiIGN5PSIxMSIgcj0iNC42IiBmaWxsPSJub25lIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMS44Ii8+PHBhdGggZD0iTTEzLjkgMTMuOSAxNyAxN2EwLjk1IDAuOTUgMCAwIDEtMS4zNSAxLjM1bC0zLjEtMy4xIiBmaWxsPSIjZmZmIi8+PC9zdmc+";
var QODERCN_ICON = "data:image/png;base64,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";
var TRAE_ICON = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjM4IDM4IDQzNSA0MzUiIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCI+PHBhdGggZmlsbD0iIzMyRjA4QyIgZmlsbC1ydWxlPSJldmVub2RkIiBkPSJNNTggMTE2aDM5NXYyNzlIMTE1di01NUg1OHpNMTE1IDE3MmgyODF2MTY4SDExNXoiLz48cGF0aCBmaWxsPSIjMzJGMDhDIiBkPSJNMjE1LjUgMjE1LjVsMzkgMzktMzkgMzktMzktMzl6TTMyOSAyMTUuNWwzOSAzOS0zOSAzOS0zOS0zOXoiLz48L3N2Zz4=";
var CLINE_ICON = "data:image/png;base64,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";
var LOOMY_ICON = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"%3E%3Crect width="24" height="24" rx="6" fill="%23007aff"/%3E%3Ctext x="12" y="17.5" font-size="15" font-family="sans-serif" font-weight="700" fill="white" text-anchor="middle"%3EL%3C/text%3E%3C/svg%3E';
var RACCOON_ICON = "data:image/png;base64,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";
var MINIMAX_ICON = "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iODAiIGhlaWdodD0iODAiIHZpZXdCb3g9IjAgMCA4MCA4MCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGcgY2xpcC1wYXRoPSJ1cmwoI2NsaXAwXzQ3XzY0MDUpIj4KPHJlY3Qgd2lkdGg9IjgwIiBoZWlnaHQ9IjgwIiBmaWxsPSIjN0RDNkZGIiBzdHlsZT0iZmlsbDojN0RDNkZGO2ZpbGw6Y29sb3IoZGlzcGxheS1wMyAwLjQ5MDIgMC43NzY1IDEuMDAwMCk7ZmlsbC1vcGFjaXR5OjE7Ii8+CjxwYXRoIGQ9Ik02Ni45NTc1IDUwLjY1NTZDNjYuOTU3NSA1MS43MDYgNjYuNDg1NSA1Mi43MDA4IDY1LjY3MTkgNTMuMzY1MUw1Ni4wMDgzIDYxLjI1NTZDNTUuMzgzOCA2MS43NjU1IDU0LjYwMjMgNjIuMDQ0IDUzLjc5NiA2Mi4wNDRIMTcuMTExOEMxNS4zMDA3IDYyLjA0NCAxMy44MzI1IDYwLjU3NTggMTMuODMyNSA1OC43NjQ3VjMxLjEwNzZDMTMuODMyNSAzMC4wNTQ3IDE0LjMwNjggMjkuMDU3OSAxNS4xMjM3IDI4LjM5MzZMMjUuODc2MyAxOS42NTAzQzI2LjUgMTkuMTQzMiAyNy4yNzkzIDE4Ljg2NjMgMjguMDgzMiAxOC44NjYzSDYzLjY3ODJDNjUuNDg5MyAxOC44NjYzIDY2Ljk1NzUgMjAuMzM0NSA2Ni45NTc1IDIyLjE0NTZWNTAuNjU1NloiIGZpbGw9ImJsYWNrIiBzdHlsZT0iZmlsbDpibGFjaztmaWxsLW9wYWNpdHk6MTsiLz4KPHBhdGggZD0iTTYwLjM5ODQgNDguMzY4NEM2MC4zOTg0IDQ4Ljg5NDYgNjAuMTYxNCA0OS4zOTI4IDU5Ljc1MzMgNDkuNzI1TDUzLjE3NDIgNTUuMDc4NUM1Mi44NjIzIDU1LjMzMjMgNTIuNDcyNCA1NS40NzA5IDUyLjA3MDMgNTUuNDcwOUgyMS41MzVDMjAuOTMxMyA1NS40NzA5IDIwLjQ0MTkgNTQuOTgxNSAyMC40NDE5IDU0LjM3NzhWMzMuMjYwMUMyMC40NDE5IDMyLjczMiAyMC42ODA1IDMyLjIzMjIgMjEuMDkxMSAzMS45MDAxTDI4LjYzNDcgMjUuNzk5OEMyOC45NDYyIDI1LjU0NzkgMjkuMzM0NyAyNS40MTA2IDI5LjczNTMgMjUuNDEwN0w1OS4zMDU4IDI1LjQyNDVDNTkuOTA5MyAyNS40MjQ3IDYwLjM5ODQgMjUuOTE0MSA2MC4zOTg0IDI2LjUxNzZWNDguMzY4NFoiIGZpbGw9IndoaXRlIiBzdHlsZT0iZmlsbDp3aGl0ZTtmaWxsLW9wYWNpdHk6MTsiLz4KPHBhdGggZD0iTTI2LjU1NDcgNDMuNjYxOUMyNi41NTQ3IDQyLjY5NTkgMjcuMzM3NyA0MS45MTI5IDI4LjMwMzcgNDEuOTEyOUgzMi40NTc1QzMzLjQyMzQgNDEuOTEyOSAzNC4yMDY0IDQyLjY5NTkgMzQuMjA2NCA0My42NjE5VjU2LjIzMjZIMjYuNTU0N1Y0My42NjE5WiIgZmlsbD0iYmxhY2siIHN0eWxlPSJmaWxsOmJsYWNrO2ZpbGwtb3BhY2l0eToxOyIvPgo8cGF0aCBkPSJNMzguMTQxOCA0My42NjE5QzM4LjE0MTggNDIuNjk1OSAzOC45MjQ5IDQxLjkxMjkgMzkuODkwOCA0MS45MTI5SDQ0LjA0NDZDNDUuMDEwNiA0MS45MTI5IDQ1Ljc5MzYgNDIuNjk1OSA0NS43OTM2IDQzLjY2MTlWNTYuMjMyNkgzOC4xNDE4VjQzLjY2MTlaIiBmaWxsPSJibGFjayIgc3R5bGU9ImZpbGw6YmxhY2s7ZmlsbC1vcGFjaXR5OjE7Ii8+CjwvZz4KPGRlZnM+CjxjbGlwUGF0aCBpZD0iY2xpcDBfNDdfNjQwNSI+CjxwYXRoIGQ9Ik0wIDIwQzAgOC45NTQzMSA4Ljk1NDMxIDAgMjAgMEg2MEM3MS4wNDU3IDAgODAgOC45NTQzMSA4MCAyMFY2MEM4MCA3MS4wNDU3IDcxLjA0NTcgODAgNjAgODBIMjBDOC45NTQzMSA4MCAwIDcxLjA0NTcgMCA2MFYyMFoiIGZpbGw9IndoaXRlIiBzdHlsZT0iZmlsbDp3aGl0ZTtmaWxsLW9wYWNpdHk6MTsiLz4KPC9jbGlwUGF0aD4KPC9kZWZzPgo8L3N2Zz4K";
var ZCODE_ICON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAgklEQVR42u3XsRGAIAyF4UxgYe0g7j+FpZtgRwN36stLAhruqP+v4ICIdNaybsViy92yCj+CeMW7CO94gwgFRMUrIgFTAPbzgPe/Aa5nAInTAGicAtDE1QBtXAVgxGEAeuIpAFYYArDj81xEoQDLd+A1ID8k3wTkXDDEaDbEcBo1nl/XXoK4yMqvMgAAAABJRU5ErkJggg==";
var MODELSCOPE_ICON = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiByeD0iNSIgZmlsbD0iIzYyNEFGRiIvPjxwYXRoIGQ9Ik02IDE3VjdoMi42bDMuNCA1LjJMMTUuNCA3SDE4djEwaC0yLjR2LTZsLTMgNC42aC0uMmwtMy00LjZ2Nkg2eiIgZmlsbD0iI2ZmZiIvPjwvc3ZnPg==";
var OPENCODE_ICON = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiByeD0iNSIgZmlsbD0iIzEyMTYxZCIvPjxwYXRoIGQ9Ik02LjUgOC41IDEwLjUgMTJsLTQgMy41IiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMS44IiBmaWxsPSJub25lIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz48cGF0aCBkPSJNMTIuNSAxNmg1IiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMS44IiBmaWxsPSJub25lIiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48L3N2Zz4=";
var GEMINI_ICON = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PGRlZnM+PGxpbmVhckdyYWRpZW50IGlkPSJnIiB4MT0iMCIgeTE9IjAiIHgyPSIxIiB5Mj0iMSI+PHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjNDI4NUY0Ii8+PHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjOUI3MkNCIi8+PC9saW5lYXJHcmFkaWVudD48L2RlZnM+PHBhdGggZD0iTTEyIDJjLjQgMy45IDIuMSA2LjYgNiA4LTMuOSAxLjQtNS42IDQuMS02IDgtLjQtMy45LTIuMS02LjYtNi04IDMuOS0xLjQgNS42LTQuMSA2LThaIiBmaWxsPSJ1cmwoI2cpIi8+PHBhdGggZD0iTTE5LjUgMTRjLjIgMS43LjkgMi45IDIuNiAzLjUtMS43LjYtMi40IDEuOC0yLjYgMy41LS4yLTEuNy0uOS0yLjktMi42LTMuNSAxLjctLjYgMi40LTEuOCAyLjYtMy41WiIgZmlsbD0idXJsKCNnKSIvPjwvc3ZnPg==";
var AGGREGATE_ICON = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PGNpcmNsZSBjeD0iNSIgY3k9IjUiIHI9IjIuNiIgZmlsbD0iIzRGOERGNyIvPjxjaXJjbGUgY3g9IjUiIGN5PSIxOSIgcj0iMi42IiBmaWxsPSIjOUI3MkNCIi8+PGNpcmNsZSBjeD0iMTkiIGN5PSIxMiIgcj0iMi42IiBmaWxsPSIjNEY4REY3Ii8+PHBhdGggZD0iTTcgNi4yIDE2LjQgMTFNNyAxNy44IDE2LjQgMTMiIHN0cm9rZT0iIzlCNzJDQiIgc3Ryb2tlLXdpZHRoPSIxLjciIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgZmlsbD0ibm9uZSIvPjxjaXJjbGUgY3g9IjEyIiBjeT0iMTIiIHI9IjEuNSIgZmlsbD0iIzlCNzJDQiIvPjwvc3ZnPg==";
var OFFICEACE_ICON = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHJlY3Qgd2lkdGg9IjIwIiBoZWlnaHQ9IjIwIiB4PSIyIiB5PSIyIiByeD0iNCIgZmlsbD0iI2M3MDAwMCIvPjx0ZXh0IHg9IjEyIiB5PSIxNS41IiBmb250LXNpemU9IjgiIGZvbnQtZmFtaWx5PSJBcmlhbCIgZm9udC13ZWlnaHQ9ImJvbGQiIGZpbGw9IiNmZmYiIHRleHQtYW5jaG9yPSJtaWRkbGUiPk9BPC90ZXh0Pjwvc3ZnPg==";
var ACCIO_ICON = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiByeD0iNSIgZmlsbD0iI0ZGNkEwMCIvPjxwYXRoIGQ9Ik03LjQgMTcuMiAxMSA2LjhoMmwzLjYgMTAuNGgtMi4xbC0uNzItMi4yNEgxMC4ybC0uNzIgMi4yNEg3LjRaIiBmaWxsPSIjZmZmIi8+PHBhdGggZD0iTTEwLjc0IDEzLjI2aDIuNTJMMTIgOS41bC0xLjI2IDMuNzZaIiBmaWxsPSIjRkY2QTAwIi8+PC9zdmc+";
var ASTUDIO_ICON = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiByeD0iNSIgZmlsbD0iIzFGNkZFQiIvPjxwYXRoIGQ9Ik0xMiA2LjIgMTcuNiAxOC4yaC0yLjJsLTEuMi0yLjlIOS44bC0xLjIgMi45SDYuNHoiIGZpbGw9IiNGRkZGRkYiLz48cmVjdCB4PSI5LjIiIHk9IjEyLjYiIHdpZHRoPSI1LjYiIGhlaWdodD0iMS41IiBmaWxsPSIjRkZGRkZGIi8+PC9zdmc+";
var AUTOCLAW_ICON = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0Ij48cmVjdCB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHJ4PSI1IiBmaWxsPSIjNDM2MWVlIi8+PHBhdGggZD0iTTcgOGwzIDNsLTItNG00IDBsMyA0bC0yLTNtNCAwbDMgNWwtMi00IiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+PC9zdmc+";
var CODELY_ICON = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiByeD0iNSIgZmlsbD0iIzI0MjQyNCIvPjxwYXRoIGQ9Ik03IDZ2OGE1IDUgMCAwIDAgMTAgMFY2aC0yLjV2Ny44YTIuNSAyLjUgMCAwIDEtNSAwVjZaIiBmaWxsPSIjZmZmIi8+PGNpcmNsZSBjeD0iMTYuNiIgY3k9IjcuMiIgcj0iMS4zIiBmaWxsPSIjOUFFMjJFIi8+PC9zdmc+";
var PROVIDER_ICONS = {
  codearts: CODEARTS_ICON,
  buddy: CODEBUDDY_ICON,
  workbuddy: WORKBUDDY_ICON,
  lobsterai: LOBSTERAI_ICON,
  qoder: QODER_ICON,
  qodercn: QODERCN_ICON,
  trae: TRAE_ICON,
  cline: CLINE_ICON,
  loomy: LOOMY_ICON,
  raccoon: RACCOON_ICON,
  minimax: MINIMAX_ICON,
  // ⚠️ 与 `minimax` **共用同一个常量**（两站同一产品、同一品牌 logo）。
  //    漏加这一行会让 `provider-registry.spec.ts` 的「图标键集合 == registry id
  //    集合」断言变红（而不是渲染出空白图标）。
  minimaxintl: MINIMAX_ICON,
  zcode: ZCODE_ICON,
  opencode: OPENCODE_ICON,
  gemini: GEMINI_ICON,
  officeace: OFFICEACE_ICON,
  accio: ACCIO_ICON,
  astudio: ASTUDIO_ICON,
  autoclaw: AUTOCLAW_ICON,
  // ⚠️ 国际版与国内版**共用同一个图标**（同一产品，只是部署区域不同）。
  //    但键必须存在：`PROVIDER_ICONS` 的键集合与 registry 的 id 集合必须完全相等
  //    （`provider-registry.spec.ts` 有行为断言）。
  autoclawintl: AUTOCLAW_ICON,
  modelscope: MODELSCOPE_ICON,
  aggregate: AGGREGATE_ICON,
  // ⚠️ Codely（Unity，本 fork 独有）：UI 先行阶段（registry 里 channel:false），
  //    但图标键集合守卫按**全量** registry 比对 —— 漏加这行会红（而非渲染空白图标）。
  //
  //    ⚠️⚠️ **本行必须留在 `}` 之前、且不得与上面的键重复**（2026-10-22 合并审计）：
  //    PR #1 的 `b69e6736 feat(codely)` 在追加本行时，把 `autoclaw` / `modelscope` /
  //    `aggregate` 三个键**又抄了一遍**（缩进也丢了）。重复键在 JS 里是「后者胜」，
  //    键集合不变 ⇒ **上面那条 `Object.keys()` 守卫照样全绿**，只有 esbuild 的
  //    `duplicate-object-key` 警告能发现它。三个值恰好相同所以当时没有功能后果，
  //    但「守卫全绿 + 有警告」这种组合正是本仓库记过的「假绿」形态：
  //    一旦哪天两处值不同，就会变成静默用错图标而无人报警。
  codely: CODELY_ICON
};

// plugin-src/client/compensation-panel-logic.js
function isClaimable(status) {
  return status?.active === true && status?.claimed !== true && Number(status?.creditNum) > 0;
}
function isClaimed(status) {
  return status?.claimed === true;
}
async function scanCompensation(accounts, onStatus) {
  let total = 0;
  let claimableCount = 0;
  let claimedCount = 0;
  let endTime = null;
  let errorCount = 0;
  let firstError = null;
  for (const account of accounts) {
    let status;
    try {
      status = await onStatus(account.id);
    } catch (caught) {
      errorCount += 1;
      if (firstError === null) firstError = caught?.message || "未知错误";
      continue;
    }
    if (isClaimable(status)) {
      claimableCount += 1;
      total += Number(status.creditNum);
      if (endTime === null && typeof status.endTime === "string") endTime = status.endTime;
    } else if (isClaimed(status)) {
      claimedCount += 1;
    }
  }
  return { scanned: accounts.length, claimableCount, claimedCount, total, endTime, errorCount, firstError };
}
function toCompensationState(scan) {
  const allFailed = scan.scanned > 0 && scan.claimableCount === 0 && scan.claimedCount === 0 && scan.errorCount > 0;
  return {
    scanned: scan.scanned,
    claimableCount: scan.claimableCount,
    claimedCount: scan.claimedCount,
    total: scan.total,
    endTime: scan.endTime,
    error: allFailed ? scan.firstError : null,
    errorCount: scan.errorCount
  };
}
async function claimAllCompensation(accounts, onStatus, onClaim) {
  const claimed = [];
  const failures = [];
  for (const account of accounts) {
    let status;
    try {
      status = await onStatus(account.id);
    } catch {
      continue;
    }
    if (!isClaimable(status)) continue;
    try {
      await onClaim(account.id);
      claimed.push(account.nickname || account.id);
    } catch (caught) {
      failures.push(`${account.nickname || account.id}：${caught?.message || "未知错误"}`);
    }
  }
  return { claimed, failures };
}
function shouldShowCompensation(state) {
  if (state === null) return false;
  if (state.error) return true;
  if (state.total > 0) return true;
  if (state.errorCount > 0) return true;
  return false;
}
function compensationHeadline(state) {
  if (state === null) return "";
  if (state.error) return `补偿积分状态查询失败：${state.error}`;
  if (state.total > 0) {
    return `DeepSeek 模型服务异常补偿：${state.total} 积分待领取` + (state.endTime ? `（${state.endTime} 截止）` : "");
  }
  if (state.claimedCount > 0) return "补偿积分已领取";
  if (state.scanned === 0) return "尚未添加 CodeBuddy 账号";
  return "当前没有可领取的补偿积分";
}
function compensationHint(state) {
  if (state === null) return "";
  if (state.total > 0) {
    const partial = state.errorCount > 0 ? `（另有 ${state.errorCount} 个账号查询失败，未计入）` : "";
    return `可领取账号 ${state.claimableCount} / ${state.scanned} 个（按账号独立，每账号限领一次）${partial}`;
  }
  if (state.error) return "该能力为附加信息，不影响账号列表的使用。";
  return "";
}

// plugin-src/client/jet-hub.js
var JET_HUB_RPC_CHANNEL = "/jet-hub";
var PROVIDERS = Object.freeze(
  PROVIDER_REGISTRY.map((d) => Object.freeze({
    id: d.id,
    label: d.label,
    icon: PROVIDER_ICONS[d.id],
    logoClass: d.logoClass
  }))
);
function providerLabel(id) {
  return PROVIDERS.find((p) => p.id === id)?.label ?? id;
}
var GROWTH_TASK_PROVIDERS = /* @__PURE__ */ new Set(["buddy"]);
var ACCIO_DAILY_BUCKET = "每日积分";
var ACCIO_DAILY_REWARD_NOTE = "Accio 的每日积分由服务端在登录时发放，有效期 24 小时，次日刷新、不累积。它没有可调用的领取接口 —— 要重新拿到这份每日额度，请删除该账号后重新登录一次。";
function ProviderLogo({ provider }) {
  const p = PROVIDERS.find((p2) => p2.id === provider);
  if (!p) return null;
  return React3.createElement(
    "span",
    { className: `dim-jh-providerIcon ${p.logoClass}` },
    React3.createElement("img", { src: p.icon, alt: "", width: 20, height: 20 })
  );
}
function formatTime(ts) {
  if (!ts || ts <= 0) return null;
  const d = new Date(ts);
  const now = Date.now();
  if (ts < now) return "已过期";
  const diff = ts - now;
  if (diff < 36e5) return `${Math.round(diff / 6e4)} 分钟后`;
  if (diff < 864e5) return `${Math.round(diff / 36e5)} 小时后`;
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleString("zh-CN", {
    ...sameYear ? {} : { year: "numeric" },
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}
var RETEST_HELP = "对本账号每个「限额重置」标记的模型真实发送一条最小消息：正常返回则清除该标记，仍被限流则保留。会消耗少量模型额度。";
var RETEST_ALL_HELP = "对本页全部账号（含已停用）执行「重测」：逐个模型真实发送一条最小消息，正常返回才清除标记。停用账号同样会发送。会消耗模型额度。";
var RESET_HELP = "直接清除本账号的全部「限额重置」标记，不发送任何请求。适用于你已确认额度恢复、只想清掉显示的情况。";
var RESET_ALL_HELP = "直接清除本页全部账号（含已停用）的「限额重置」标记，不发送任何请求。";
var TEST_HELP = "无条件真实发送一条最小消息给这个账号（不依赖是否存在「限额重置」标记），用来确认账号当下到底还能不能用。与「重测」的区别：重测只测「已有标记」的模型，没有标记时一次请求都不发；测试不看标记，直接挑一个模型发出去。只回报结果，不修改任何限流标记。会消耗少量模型额度。";
var MODEL_LIST_HELP = "列出该 Provider 的全部模型。每个模型后面的开关默认打开；关闭后，该模型不再出现在对话框的模型选择列表里（黑名单制：只有被关闭的才隐藏，其余含服务端新增的模型一律默认显示）。此设置持久化保存，可随时重新打开。";
var ORDER_HINT_TEXT = "拖动卡片调整排序，按顺序选号。限额账号会沉到末尾、恢复后不复位，避免长期占位将其他号额度放过期。";
function summarizeProbe(kind, res) {
  if (kind === "reset" || kind === "resetAll") {
    const n = res?.clearedCount ?? 0;
    return n > 0 ? `已清除 ${n} 条限流标记` : "没有可清除的限流标记";
  }
  const accounts = res?.accounts ?? [];
  const cleared = res?.clearedCount ?? 0;
  const still = accounts.reduce((sum, a) => sum + (a.stillLimited?.length ?? 0), 0);
  const parts = [];
  if (cleared > 0) parts.push(`已清除 ${cleared} 条`);
  if (still > 0) parts.push(`${still} 条仍受限`);
  if (parts.length === 0) parts.push("没有可重测的限流标记");
  return parts.join("，");
}
function summarizeTest(res) {
  const model = res?.modelId || "未知模型";
  if (res?.ok) return `测试通过：${model} 正常返回`;
  const reason = res?.message || "仍受限";
  return `测试未通过：${model} — ${reason}`;
}
function formatPackageLine(pkg, windowDays, now) {
  const remaining = formatUnits(pkg.remaining, pkg.unit) ?? "?";
  const total = formatUnits(pkg.total, pkg.unit) ?? "?";
  const parts = [`${pkg.active ? "" : "[已失效] "}${pkg.name || "未命名"}: ${remaining} / ${total}`];
  const daysLeft = daysUntilExpiry(pkg, now);
  if (!pkg.active && pkg.expiredTime) parts.push(`失效于 ${pkg.expiredTime}`);
  else if (daysLeft !== null) {
    const label = expiryBucketLabel(pkg, windowDays, now);
    parts.push(`距到期 ${Math.ceil(daysLeft)} 天${label ? `（${label}）` : ""}`);
  } else if (pkg.cycleEndTime) parts.push(`本周期至 ${pkg.cycleEndTime}`);
  return parts.join(" · ");
}
function CreditBalanceRow({ balance, error, loading, windowDays, provider, actions }) {
  const rowProps = actions === void 0 ? { className: "dim-jh-metaRow" } : { className: "dim-jh-metaRow dim-jh-metaRow--actions" };
  const all = balance?.packages || [];
  const unit = all.find((p) => p && p.unit)?.unit;
  const label = unitLabel(unit);
  if (loading) {
    return React3.createElement(
      "div",
      rowProps,
      React3.createElement("dt", null, label),
      React3.createElement("dd", { "data-tone": "muted" }, "读取中…"),
      // 读取中也要挂按钮：否则按钮会在读数到达的那一瞬从右侧跳出来。
      actions === void 0 ? null : actions
    );
  }
  if (error || !balance) {
    return React3.createElement(
      "div",
      rowProps,
      React3.createElement("dt", null, label),
      React3.createElement(
        "dd",
        { "data-tone": "warn", title: error || "查询失败" },
        error || "查询失败"
      ),
      // 查询失败恰恰是最需要「重测」的时候，按钮必须还在。
      actions === void 0 ? null : actions
    );
  }
  const total = formatUnits(balance.total, unit) ?? "0";
  const activeCount = all.filter((p) => p.active).length;
  const quotaText = formatQuotaLine(all, unit);
  const now = Date.now();
  const split = splitCreditsByExpiry(all, windowDays, now);
  const formatForUnit = (value) => formatUnits(value, unit);
  const expiryText = formatExpirySplitLine(split, formatForUnit);
  const expiryParts = expirySplitParts(split, formatForUnit, now);
  const exclusiveRemaining = exclusivePoolRemainingOf(all);
  const exclusiveNames = all.filter((pkg) => pkg && pkg.active === true && isExclusivePool(pkg) && Number.isFinite(Number(pkg.remaining)) && Number(pkg.remaining) > 0).map((pkg) => pkg.name).join("、");
  const detail = [
    all.length > 1 ? `共 ${all.length} 个资源包，${activeCount} 个有效` : null,
    ...all.map((pkg) => formatPackageLine(pkg, windowDays, now))
  ].filter(Boolean).join("\n");
  const quotaDetail = quotaText === null ? null : formatQuotaDetail(all);
  const poolSplitText = provider === "accio" ? null : formatPoolSplitLine(
    all,
    formatForUnit,
    // Loomy 的另一个池就叫「永久积分」；Raccoon 的奖励/会员/充值三种池
    // 到期规则各不相同，不能统称永久。
    provider === "loomy" ? "永久" : "长期"
  );
  const namedPoolText = provider === "accio" ? formatNamedPoolLine(all, formatForUnit) : null;
  const accioResetNote = provider === "accio" ? (() => {
    const countdown = formatAccioResetCountdown(accioResetSeconds(all, now));
    return countdown === null ? null : `每日额度 ${countdown}后刷新`;
  })() : null;
  return React3.createElement(
    "div",
    rowProps,
    // ⚠ 标签按单位走：ZCode 是 token，显示「Token」而不是「积分」。
    React3.createElement("dt", null, label),
    React3.createElement(
      "dd",
      {
        className: "dim-jh-creditValue",
        title: quotaDetail ?? (detail || void 0)
      },
      // ⚠️ 配额窗口显示**逐窗口百分比**而不是均值：均值（94.5）既不是上游给的数，
      // 在「额度」这个标签下更会被读成 94.5 个积分。见 quotaText 的注释。
      React3.createElement("strong", { className: "dim-jh-creditTotal" }, quotaText ?? total),
      // 当日池分桶（loomy / raccoon）：`formatPoolSplitLine` 已覆盖原先硬编码的
      // loomy 两池判据，且对 Raccoon 的「每日积分」同样成立（用户 2026-09-29 要求）。
      // ⚠ 数字按**包自身的单位**格式化（remote 的单位支持）：池可能来自
      // 不同 provider，不能假定都是积分。
      poolSplitText ? React3.createElement("span", { className: "dim-jh-creditPools" }, poolSplitText) : null,
      // 两个 buddy + TRAE + LobsterAI + OfficeAce：按「会不会近期作废」分**三档**，
      // 与选号判据同一套规则（后端只分两档，前端把「真永久」与「到期还远」拆开着色）。
      // 这条也解释了「锁定永久积分后为什么没有可用账号」——临期桶是 0。
      // ⚠️ 用词「长期」不是「永久」：有到期日的积分即使很远也不叫永久（用户定）；
      //    只有**服务端没给到期时间**的才是真·永久（绿）。
      // ⚠️ Accio 的逐池列（与 loomy 的 `poolSplitText` 同位置、同样式，故视觉统一）。
      namedPoolText ? React3.createElement("span", { className: "dim-jh-creditPools" }, namedPoolText) : null,
      /**
       * ⚠️ Accio 的每日额度重置倒计时（**唯一**与 loomy 不同的附注）。
       *
       * 别的家没有这一条；但 accio 的每日额度是 24 小时作废且**不累积**，
       * 「还有多久刷新」是用户唯一能据此决定「现在要不要用掉」的信息。
       * ⚠️ 它放在**积分行内**（而不是另起区块）—— 这正是 2026-10-13 的统一要求。
       */
      accioResetNote ? React3.createElement("span", {
        className: "dim-jh-creditPools",
        title: ACCIO_DAILY_REWARD_NOTE
      }, accioResetNote) : null,
      // 两个 buddy + TRAE + LobsterAI：按「会不会近期作废」分桶，与选号判据同一套规则。
      // 这条也解释了「锁定永久积分后为什么没有可用账号」——临时桶是 0。
      // ⚠️ 用词「长期」不是「永久」：这些积分都有到期日，只是较远（用户定）。
      // ⚠️ 与上面的池分桶互斥：有当日池的（loomy / raccoon）走池名分桶，
      // 没有的走到期时间分桶。
      !poolSplitText && expiryParts.length > 0 ? React3.createElement("span", {
        className: "dim-jh-creditPools",
        title: `永久 = 服务端未给到期时间（不会作废）；长期 = 有到期时间但距扣费截止还有 ${windowDays} 天以上；临期 = 距扣费截止不足 ${windowDays} 天（再不用就作废，优先消耗，锁定永久积分后不参与消耗）。`
      }, expiryParts.flatMap((part, index) => {
        const node = React3.createElement("span", {
          key: part.key,
          className: "dim-jh-creditPoolPart",
          "data-tone": part.tone
        }, part.countdown === void 0 ? part.text : `${part.text}（${part.countdown}）`);
        return index === 0 ? [node] : [React3.createElement("span", { key: `sep-${part.key}`, className: "dim-jh-creditPoolSep" }, " · "), node];
      })) : null,
      /**
       * **独立池**提示（2026-10-21 用户报障「没标注星火专属」）。
       *
       * 为什么不塞进上面那行：三档分桶是按**金额**聚合的，塞进去就只能写成
       * 「永久 25000」—— 而那正是误导的来源（用户会以为是通用积分）。
       * 单独一行 + 「不计入」字样，才能既显示这笔钱存在、又说明它不能混用。
       *
       * ⚠️ `exclusiveRemaining === 0` 时不渲染 ⇒ 没有独立池的 provider
       *    （现有全部）行为**逐字不变**。
       */
      exclusiveRemaining > 0 ? React3.createElement("span", {
        className: "dim-jh-creditExclusive",
        title: `${exclusiveNames}：服务端下发的独立池，与上方主池分开结算，不参与主池合计、也不能当通用积分消耗。`
      }, `另有 ${formatUnits(exclusiveRemaining, unit) ?? exclusiveRemaining} 专属（不计入）`) : null,
      // ⚠️ 配额单位（Gemini）下**不渲染**这句：它的两个「包」是 5 小时窗口与
      // 周窗口，不是资源包 —— 说「2/2 个资源包有效」既没信息量又误导
      // （用户报障原文：「不要渲染 / 2/2 个资源包有效」）。窗口自身的读数
      // 已由上面的 `quotaText` 逐条列出，这里再补一句纯属噪音。
      // ⚠️ 非配额单位（真正由多个资源包构成余额的 provider）行为**逐字不变**。
      quotaText === null && !poolSplitText && expiryParts.length === 0 && all.length > 1 ? React3.createElement(
        "span",
        { className: "dim-jh-creditPackages" },
        `${activeCount}/${all.length} 个资源包有效`
      ) : null,
      // 失效额度单独提示：它们仍在服务端响应里，但不计入上面的数字
      // ⚠️ 配额单位下恒不渲染（`expiredTotal` 就是 0），留着分支只为不改变
      // 其它 provider 的行为。
      balance.expiredTotal > 0 ? React3.createElement(
        "span",
        { className: "dim-jh-creditExpired" },
        `另有 ${formatUnits(balance.expiredTotal, unit)} 已失效`
      ) : null,
      /**
       * 失效额度单独提示：它们仍在服务端响应里，但不计入上面的数字
       * ⚠️ 配额单位下恒不渲染（`expiredTotal` 就是 0），留着分支只为不改变
       * 其它 provider 的行为。
       */
      balance.expiredTotal > 0 ? React3.createElement(
        "span",
        { className: "dim-jh-creditExpired" },
        `另有 ${formatUnits(balance.expiredTotal, unit)} 已失效`
      ) : null
    ),
    // 操作按钮（重测 / 重置 / 停用 / 删除）贴在这行最右侧 —— 三列网格的第三列。
    // ⚠️ 必须是 div 的直接子节点（与 dt / dd 同级）：挂进 dd 会被它的
    //    `overflow: hidden` + `white-space: nowrap` 直接裁掉。
    actions === void 0 ? null : actions
  );
}
function isAnonymousAccountId(accountId) {
  return String(accountId || "").indexOf("opencode-anon-") === 0;
}
function proxyModalComponent(provider) {
  if (provider === "gemini") return GeminiProxyModal;
  if (provider === "minimaxintl") return MinimaxIntlProxyModal;
  if (provider === "qoder") return QoderProxyModal;
  if (provider === "qodercn") return QoderProxyModal;
  return OpencodeProxyModal;
}
function AccountCard({
  account,
  index,
  order,
  provider,
  onToggle,
  onDelete,
  onRetest,
  onReset,
  onTest,
  onClaimOnboarding,
  onboardingBusy,
  busy,
  credits,
  creditsLoading,
  showCredits,
  showPackageList,
  windowDays,
  showRateLimitActions,
  drag,
  // ⚠️ opencode 专属：传了才渲染「代理」「指纹」两个按钮（见按钮区注释）。
  // 前者额外需要 current 代理串，故签名与 onRetest 略有不同。
  // ⚠️ **本 fork 独有**：modelscope 的「令牌」按钮同理（传了才渲染），
  // 第二参是宿主算好的**打码**串。
  onOpenProxy,
  onRotateFingerprint,
  onEditModelscopeKey
}) {
  const rateLimits = account.modelRateLimits ? Object.entries(account.modelRateLimits).filter(([, v]) => v > Date.now()) : [];
  const expired = typeof account.expiresAt === "number" && account.expiresAt > 0 && account.expiresAt <= Date.now();
  const hasAnyLimit = Boolean(account.modelRateLimits && Object.keys(account.modelRateLimits).length > 0);
  const dragProps = drag || {};
  const hoverPackages = credits?.balance?.packages;
  const packageTooltip = showPackageList && hoverPackages?.length ? formatPackageTooltip(hoverPackages, {
    format: (value) => formatUnits(value, hoverPackages.find((p) => p && p.unit)?.unit),
    now: Date.now()
  }) : null;
  const accountTitle = packageTooltip ?? (showPackageList && creditsLoading ? "资源包加载中…" : void 0);
  const actionsNode = React3.createElement(
    "div",
    { className: "dim-jh-accountActions" },
    // 新手任务（仅 Loomy）：一次性 10000 分，每号只能领一次。
    // 与「一键领取积分」（每日签到）是**不同**的操作，故独立按钮 ——
    // 混进「一键签到」会导致每天对已领完的账号发 8 个必然 alreadyCompleted 的请求。
    //
    // ⚠️ **只显示礼物图标**（用户报障：「领取新手任务」文字太长、按钮溢出行尾）。
    // 该行有 5 个按钮且 `flex-wrap: nowrap`，多一个宽按钮就会被挤出容器。
    // 文案移到 `title`（hover tooltip）与 `aria-label`（无障碍）里。
    onClaimOnboarding ? React3.createElement("button", {
      className: "dim-jh-btn dim-jh-iconBtn",
      // tooltip 说明「是什么 + 一次性 + 多少分」，因为图标本身不自解释
      title: "领取新手任务（合计 10000 积分，每个账号仅能领取一次）",
      "aria-label": "领取新手任务",
      disabled: busy || onboardingBusy,
      onClick: () => onClaimOnboarding(account.id)
    }, onboardingBusy ? "领取中…" : React3.createElement(
      "svg",
      {
        width: 14,
        height: 14,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
        focusable: "false"
      },
      // 礼物盒：盒身 + 盖子 + 竖带 + 蝴蝶结
      React3.createElement("rect", { x: 3, y: 8, width: 18, height: 4, rx: 1 }),
      React3.createElement("path", { d: "M12 8v13" }),
      React3.createElement("path", { d: "M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7" }),
      React3.createElement("path", { d: "M7.5 8a2.5 2.5 0 0 1 0-5A4.8 4.8 0 0 1 12 8a4.8 4.8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5" })
    )) : null,
    // 卡片级「重测 / 重置」同样只对会限流的 provider 有意义
    // （Loomy 不返回限流错误，故这两个按钮对它永远禁用 —— 直接不渲染）。
    //
    // ⚠️ 「测试」与上面两个**互不替代**，故用**独立**的 props 存在性开关
    // （与 `onOpenProxy` 同款约定）：重测只测已有标记的模型、没有标记时零请求；
    // 测试无条件真发一次。当前 Gemini 恰好只登记了测试、没登记重测 —— 若把
    // 两者绑在同一个开关上，就会出现「要么都渲染（重测对它无意义）、要么
    // 都不渲染（测试消失）」的二选一。
    //
    // ⚠️ 该行是 `flex-wrap: nowrap`，多一个按钮就可能溢出（见上方礼物图标
    // 按钮的注释）。故「测试」放在最前，且**只有**在 provider 同时登记了
    // 测试与重测时才会出现 6 个按钮 —— 当前没有任何 provider 两者皆登记。
    onTest ? React3.createElement("button", {
      className: "dim-jh-btn",
      title: TEST_HELP,
      // 不依赖 hasAnyLimit：测试的意义正是「没有标记时也能探活」。
      disabled: busy,
      onClick: () => onTest(account.id)
    }, "测试") : null,
    showRateLimitActions ? React3.createElement("button", {
      className: "dim-jh-btn",
      title: RETEST_HELP,
      disabled: busy || !hasAnyLimit,
      onClick: () => onRetest(account.id)
    }, "重测") : null,
    showRateLimitActions ? React3.createElement("button", {
      className: "dim-jh-btn",
      title: RESET_HELP,
      disabled: busy || !hasAnyLimit,
      onClick: () => onReset(account.id)
    }, "重置") : null,
    // ⚠️ 「停用 / 启用」按钮已**移除**（用户 2026-10-26）：该能力合并进
    //    账号名右侧的状态徽章（点徽章即切换）。留在这里会有两个入口，
    //    且按钮离状态显示很远 —— 用户点完还得回头找徽章确认结果。
    // ⚠️ 仅 opencode / gemini / qoder：出口代理是该 provider 独有的**账号维度**
    // 能力（其余 provider 没有这一项）。用 props 存在性开关而非
    // `provider === 'opencode'` 硬判断 —— 前者让 AccountCard 无需知道
    // provider 列表，也避免以后新增同类 provider 时漏改。
    // 位置在「停用」之后、「删除」之前：删除按钮带 data-kind='danger'，
    // 是这一行的视觉终点，不能被挤到中间。
    onOpenProxy ? React3.createElement("button", {
      className: "dim-jh-btn",
      // ⚠️ tooltip 必须解释「不设置会怎样」。四家语义不同，故按各自的
      // 池字段分流文案：
      // - opencode：共用出口 = 共用额度；
      // - gemini：出不去 = 墙外恒连不上；
      // - qoder：只有国际版在墙外，中国版不设反而更快；
      // - minimaxintl：出口在大陆 = 被 307 到中国站（**连得上但用不了**）。
      // ⚠️ 顺序有语义：`opencodeProxy` 用真值判（它一配就非空），其余三家
      // 必须用 `!== undefined`（「未设置 = undefined、已清除 = 空串」两种
      // 状态在 UI 上必须区分，见 `src/types.ts` 各字段的注释）。
      title: account.opencodeProxy ? "出口代理：" + account.opencodeProxy + "（点击修改）" : account.minimaxIntlProxy !== void 0 ? "出口代理：" + (account.minimaxIntlProxy || "直连") + "（点击修改）" : account.geminiProxy !== void 0 ? "出口代理：" + (account.geminiProxy || "直连") + "（点击修改）" : account.qoderProxy !== void 0 ? "出口代理：" + (account.qoderProxy || "直连") + "（点击修改）" : "设置该账号的出口代理；不设置则直连本机（等于与其它未设代理的账号共享本机出口 IP）",
      onClick: () => onOpenProxy(
        account.id,
        account.opencodeProxy || account.minimaxIntlProxy || account.geminiProxy || account.qoderProxy || ""
      )
    }, "代理") : null,
    onRotateFingerprint ? React3.createElement("button", {
      className: "dim-jh-btn",
      title: "轮换该账号的指纹（生成新的 project id；用于怀疑多个账号被关联时）",
      disabled: busy,
      onClick: () => onRotateFingerprint(account.id)
    }, "指纹") : null,
    // ⚠️ **本 fork 独有**（魔搭，2026-10-17）：编辑访问令牌。
    //    账号 id 与 credentialRef 都由 Key 尾段派生 ⇒ 换 Key 等于换一条账号，
    //    没有这个入口时用户只能删除重建（会丢昵称与停用状态）。
    //    ⚠️ 同样用 **props 存在性**开关（与上面 opencode 代理/指纹同款），
    //    而非 `provider === 'modelscope'` 硬判断。
    //    ⚠️ tooltip 里给的是**宿主算好的打码串**（`modelscopeKeyMask`）——
    //    客户端不自己打码，避免与 `maskModelscopeKey` 两份实现漂移。
    onEditModelscopeKey ? React3.createElement("button", {
      className: "dim-jh-btn",
      title: account.modelscopeKeyMask ? "访问令牌：" + account.modelscopeKeyMask + "（点击修改）" : "设置该账号的访问令牌（ms-…）",
      disabled: busy,
      onClick: () => onEditModelscopeKey(account.id, account.modelscopeKeyMask || "")
    }, "令牌") : null,
    // ⚠️ **只显示垃圾桶图标**（用户 2026-10-26 要求「删除按钮改为图标」）。
    //    ⚠️ 换成图标后有两处**必须**补上，否则是净损失：
    //    ① `title` —— 原按钮文案「删除」自带动作语义，图标不自解释；
    //       且这是**不可逆**操作，tooltip 必须把后果说全
    //       （与 `onDelete` 里那句 confirm 的措辞保持一致）。
    //    ② `aria-label` —— 图标按钮没有文字节点，`svg` 又标了 `aria-hidden`
    //       ⇒ 不给 `aria-label` 时读屏只会念出「按钮」，用户无从知道它删号。
    //       这是「文字改图标」最容易漏、也最难被自测发现的一处。
    //    ⚠️ 行为一行未动（`data-kind='danger'` 也保留，危险色靠它）。
    React3.createElement(
      "button",
      {
        className: "dim-jh-btn dim-jh-iconBtn",
        "data-kind": "danger",
        title: "删除该账号（不可逆：关联的凭据也将被清除）",
        "aria-label": "删除该账号",
        onClick: () => onDelete(account.id)
      },
      React3.createElement(
        "svg",
        {
          width: 14,
          height: 14,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 2,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
          focusable: "false"
        },
        // 垃圾桶：盖沿 + 桶身 + 盖上的提手 + 两道竖纹
        React3.createElement("path", { d: "M3 6h18" }),
        React3.createElement("path", { d: "M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" }),
        React3.createElement("path", { d: "M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" }),
        React3.createElement("path", { d: "M10 11v6" }),
        React3.createElement("path", { d: "M14 11v6" })
      )
    )
  );
  return React3.createElement(
    "div",
    {
      className: "dim-jh-accountCard",
      "data-enabled": account.enabled,
      "data-dragging": dragProps.isDragging ? "true" : void 0,
      // 插入位置指示：before 画在卡片上方，after 画在下方 —— 必须与
      // 实际落点一致，否则用户按指示拖放却得到不同结果。
      "data-dropBefore": dragProps.isDropTarget && dragProps.dropPosition !== "after" ? "true" : void 0,
      "data-dropAfter": dragProps.isDropTarget && dragProps.dropPosition === "after" ? "true" : void 0,
      // 整卡可拖：抓取柄之外也能拖，手感更好；但文本选择区（凭据/时间）
      // 仍可正常选中——HTML5 拖拽不会阻止选择。
      draggable: dragProps.enabled ? "true" : void 0,
      onDragStart: dragProps.onDragStart,
      onDragEnd: dragProps.onDragEnd,
      onDragOver: dragProps.onDragOver,
      onDrop: dragProps.onDrop
    },
    React3.createElement(
      "div",
      { className: "dim-jh-accountTop" },
      // 抓取柄 + 序号：序号即自动选号的优先级，让"拖到第一位"的含义明确。
      dragProps.enabled ? React3.createElement("span", {
        className: "dim-jh-dragHandle",
        title: "拖动以调整顺序（顺序即自动选号优先级）",
        "aria-hidden": "true"
      }, "⠿") : null,
      dragProps.enabled ? React3.createElement(
        "span",
        { className: "dim-jh-accountOrder", title: "自动选号优先级" },
        String((order ?? index ?? 0) + 1)
      ) : null,
      React3.createElement("span", {
        className: "dim-jh-accountStatus",
        "data-on": account.enabled ? "true" : "false",
        title: account.enabled ? "已启用" : "已停用",
        "aria-hidden": "true"
      }),
      React3.createElement(
        "span",
        {
          className: "dim-jh-accountName",
          // 资源包列表（剩余/总量 + 到期时间）。仅 buddy 系挂，见 packageTooltip。
          title: accountTitle
        },
        account.nickname || account.id
      ),
      /**
             * 状态徽章 = **唯一的启停入口**（用户 2026-10-26：「将停用按钮功能
             * 合并到右上角的已启用，点击后账号已启用/停用切换」）。
             *
             * ⚠️ 用 `span` + `role="button"` 而不是 `<button>`：`dim-jh-accountTag`
             * 的胶囊外观（圆角 / 内边距 / 字号）是按 span 的盒模型调的，
             * 换成 button 会带上浏览器默认的 border 与 font，得整段覆盖。
             * ⚠️ 键盘可达性靠 `tabIndex` + `onKeyDown`，否则它就成了只能用
             * 鼠标点的控件（原来那个真 `<button>` 是可达的，不能倒退）。
             */
      React3.createElement("span", {
        className: "dim-jh-accountTag",
        "data-tone": account.enabled ? "on" : "off",
        "data-clickable": "true",
        role: "button",
        tabIndex: 0,
        /**
         * ⚠️ title 必须**同时**说清「当前状态」与「点了会怎样」。
         * 只写「已启用」的话用户根本不知道它能点 —— 这正是本次合并的
         * 关键落差：原按钮的文案「停用」本身就是动作，而徽章的文字是状态。
         */
        title: [
          accountTitle,
          `当前${account.enabled ? "已启用" : "已停用"}，点击${account.enabled ? "停用" : "启用"}该账号`
        ].filter(Boolean).join("\n\n"),
        onClick: () => onToggle(account.id, !account.enabled),
        onKeyDown: (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onToggle(account.id, !account.enabled);
        }
      }, account.enabled ? "已启用" : "已停用"),
      // 受限标记：这张卡片被自动沉到了列表末尾，标出来才说得清「为什么它在下面」。
      // 判据与下方「限额重置」行同源（都是未到期的 modelRateLimits）。
      rateLimits.length > 0 ? React3.createElement("span", {
        className: "dim-jh-accountTag",
        "data-tone": "warn",
        title: "当前处于模型限额中。该账号不会参与自动选号，并已被沉到列表末尾；限额解除后仍留在末尾，避免它再次霸占首位而让其它账号的额度白白过期。"
      }, "限额中") : null,
      // ⚠️ 匿名通道标记：它不需要 key、只用于免费模型，额度按**出口 IP** 计。
      // 标注出来是为了让用户知道「这几条不是登录账号」，
      // 以及为什么给它们配不同代理才会各自获得独立额度。
      provider === "opencode" && isAnonymousAccountId(account.id) ? React3.createElement("span", {
        className: "dim-jh-accountTag",
        "data-tone": "on",
        title: "匿名通道：无需 API key，仅用于免费模型。额度按出口 IP 计算 —— 给它单独配置代理，才会获得独立额度。"
      }, "匿名") : null
    ),
    React3.createElement(
      "dl",
      { className: "dim-jh-accountMeta" },
      React3.createElement(
        "div",
        { className: "dim-jh-metaRow" },
        React3.createElement("dt", null, "凭据"),
        React3.createElement("dd", null, React3.createElement("code", null, account.credentialRef))
      ),
      React3.createElement(
        "div",
        { className: "dim-jh-metaRow" },
        React3.createElement("dt", null, "有效期"),
        React3.createElement(
          "dd",
          { "data-tone": expired ? "warn" : void 0 },
          account.expiresAt ? `${formatTime(account.expiresAt) || "未知"}${account.refreshable ? " · 自动续期" : ""}` : "未知"
        )
      ),
      // 账号规格（目前只有 Gemini 有）：Pro / Free / Ultra。
      //
      // ⚠️ 判据是 `extra.accountTier` 有值才渲染 —— 取不到档位（上游改协议、
      // 网络失败、非 Gemini 的 provider）时**整行不出现**，不显示「未知」也不
      // 报错：它只是一栏附注信息，不该制造一条无法修复的提示。
      // `title` 放上游原文（`Google AI Pro（g1-pro-tier）`），面板只放得下一个词。
      credits?.extra?.accountTier ? React3.createElement(
        "div",
        { className: "dim-jh-metaRow" },
        React3.createElement("dt", null, "账号规格"),
        React3.createElement(
          "dd",
          { title: credits.extra.accountTier.title },
          credits.extra.accountTier.label
        )
      ) : null,
      // 不支持积分余额的 provider 不渲染该行：留着它只能显示「查询失败」，
      // 而失败原因是「这个 provider 根本没有此接口」——与其展示一条无法修复
      // 的错误，不如不展示。
      showCredits ? React3.createElement(CreditBalanceRow, {
        balance: credits?.balance ?? null,
        error: credits?.error,
        loading: creditsLoading,
        // 「临时 / 长期」分桶的窗口天数（buddy 系 + TRAE + LobsterAI 有值）。
        windowDays,
        // 池名分桶（loomy / raccoon）要按 provider 决定另一个池的标签。
        provider,
        // 操作按钮（重测 / 重置 / 停用 / 删除）挂在积分这一行的最右侧，
        // 不再单独占一行（用户报障）。
        actions: actionsNode
      }) : null
    ),
    rateLimits.length > 0 ? React3.createElement(
      "div",
      { className: "dim-jh-rateLimits" },
      React3.createElement("span", { className: "dim-jh-rateLimitsLabel" }, "限额重置"),
      rateLimits.map(([modelId, resetAt]) => React3.createElement("span", {
        key: modelId,
        className: "dim-jh-ttlBadge",
        title: `模型 ${modelId}`
      }, `${modelId} · ${formatTime(resetAt)}`))
    ) : null,
    // 不支持积分余额的 provider 没有积分行可挂按钮 ⇒ 退回原来的独立行。
    // 否则那个账号卡片上就再也没有「重测 / 重置 / 停用 / 删除」入口了。
    showCredits ? null : actionsNode
  );
}
function ModelToggle({ provider, model, busy, onToggle, onRestore }) {
  const dead = model.dead === true;
  return React3.createElement(
    "label",
    {
      className: "dim-jh-modelRow",
      "data-disabled": model.disabled ? "true" : "false",
      "data-dead": dead ? "true" : "false",
      title: dead ? `${model.id}（上游已下架，点击「重新显示」可恢复）` : model.id
    },
    // ⚠️ 供应商图标放在**行首**（与左栏供应商列表同一视觉语言，用户 2026-10-26
    //    要求：「给所有页面供应商和模型左侧 + 供应商图标」）。
    //    模型中心横跨十几家供应商，光看模型名认不出归属 ——
    //    `deepseek-v4.1-flash` 这类 id 在多家目录里都出现过。
    // ⚠️ 它在 `<label>` 内、但**不是可标记控件**，故不影响「点整行切开关」
    //    那条既有交互。真正的坑是插入第二个 checkbox，见上面的类注释。
    React3.createElement(ProviderLogo, { provider }),
    React3.createElement(
      "span",
      { className: "dim-jh-modelInfo" },
      React3.createElement("strong", { className: "dim-jh-modelName" }, model.name || model.id),
      dead ? React3.createElement("span", { className: "dim-jh-modelDead" }, "已下架") : null,
      React3.createElement("code", { className: "dim-jh-modelId" }, model.id)
    ),
    dead ? React3.createElement("button", {
      type: "button",
      className: "dim-jh-modelRestore",
      disabled: busy,
      onClick: (event) => {
        event.preventDefault();
        event.stopPropagation();
        onRestore(model.id);
      }
    }, "重新显示") : React3.createElement("input", {
      type: "checkbox",
      className: "dim-jh-switch",
      role: "switch",
      checked: !model.disabled,
      disabled: busy,
      "aria-label": `${model.name || model.id} 是否在模型选择中显示`,
      onChange: () => onToggle(model.id, !model.disabled)
    })
  );
}
function ModelListPanel({ provider, rpcCall, onClose }) {
  const [models, setModels] = React3.useState(null);
  const [phase, setPhase] = React3.useState("loading");
  const [error, setError] = React3.useState(null);
  const [toggleError, setToggleError] = React3.useState(null);
  const [toggleWarnings, setToggleWarnings] = React3.useState([]);
  const [busyIds, setBusyIds] = React3.useState(() => /* @__PURE__ */ new Set());
  const [deadRestoreBusy, setDeadRestoreBusy] = React3.useState(false);
  const [bulkBusy, setBulkBusy] = React3.useState(false);
  const [query, setQuery] = React3.useState("");
  const [statusFilter, setStatusFilter] = React3.useState("all");
  const [groupToggles, setGroupToggles] = React3.useState({});
  const [groupBusy, setGroupBusy] = React3.useState(null);
  const mounted = React3.useRef(true);
  const load = React3.useCallback(async () => {
    setPhase("loading");
    setError(null);
    try {
      const res = await rpcCall("model.list", { provider });
      if (!mounted.current) return;
      setModels(res.models || []);
      setPhase("ready");
    } catch (caught) {
      if (!mounted.current) return;
      setError(caught?.message || "无法读取模型列表");
      setPhase("error");
    }
  }, [provider, rpcCall]);
  React3.useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);
  React3.useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  const toggleModel = async (modelId, disabled) => {
    setBusyIds((prev) => new Set(prev).add(modelId));
    setToggleError(null);
    setToggleWarnings([]);
    try {
      const res = await rpcCall("model.setDisabled", { provider, modelId, disabled });
      if (!mounted.current) return;
      setToggleWarnings(res?.warnings || []);
      setModels((prev) => (prev || []).map((m) => m.id === modelId ? { ...m, disabled } : m));
    } catch (caught) {
      console.error("[jet-hub] toggle model failed:", caught);
      if (!mounted.current) return;
      setToggleError(caught?.message || "切换模型显示状态失败");
    } finally {
      if (mounted.current) {
        setBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(modelId);
          return next;
        });
      }
    }
  };
  const restoreModel = async (modelId) => {
    setBusyIds((prev) => new Set(prev).add(modelId));
    try {
      await rpcCall("model.clearDead", { provider, modelId });
      if (!mounted.current) return;
      await load();
    } catch (caught) {
      console.error("[jet-hub] restore dead model failed:", caught);
      if (!mounted.current) return;
      setToggleError(caught?.message || "恢复模型失败");
    } finally {
      if (mounted.current) {
        setBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(modelId);
          return next;
        });
      }
    }
  };
  const all = models || [];
  const hiddenCount = all.filter((m) => m.disabled).length;
  const deadCount = all.filter((m) => m.dead === true).length;
  const restoreAllDead = async () => {
    if (deadCount === 0) return;
    if (!confirm(`确认把 ${deadCount} 个「已下架」模型重新显示？若它们确实已被上游移除，使用时会再次失败并被重新隐藏。`)) return;
    setDeadRestoreBusy(true);
    try {
      await rpcCall("model.clearDead", { provider });
      if (!mounted.current) return;
      await load();
    } catch (caught) {
      console.error("[jet-hub] restore all dead models failed:", caught);
      if (!mounted.current) return;
      setToggleError(caught?.message || "恢复模型失败");
    } finally {
      if (mounted.current) setDeadRestoreBusy(false);
    }
  };
  const providerLabel2 = PROVIDERS.find((p) => p.id === provider)?.label || provider;
  const filtered = filterModels(all, { query, status: statusFilter });
  const filtering = isFilterActive({ query, status: statusFilter });
  const groups = groupModelsForDisplay(all, { query, status: statusFilter });
  const isGroupExpanded = (group) => groupExpanded(group, {
    filterActive: filtering,
    toggled: groupToggles[group.key]
  });
  const toggleGroup = (group) => {
    const next = !isGroupExpanded(group);
    setGroupToggles((prev) => ({ ...prev, [group.key]: next }));
  };
  const setGroupDisabled = async (group, disabled) => {
    const ids = group.models.map((model) => model.id);
    if (disabled && !confirm(
      `确认关闭「${group.label}」的 ${ids.length} 个模型？关闭后它们不再出现在对话框的模型选择里。`
    )) {
      return;
    }
    setGroupBusy(group.key);
    setToggleError(null);
    setToggleWarnings([]);
    try {
      const res = await rpcCall("model.setDisabledMany", { provider, modelIds: ids, disabled });
      if (!mounted.current) return;
      setToggleWarnings(res?.warnings || []);
      const changed = new Set(ids);
      setModels((prev) => (prev || []).map((m) => changed.has(m.id) ? { ...m, disabled } : m));
    } catch (caught) {
      console.error("[jet-hub] group toggle failed:", caught);
      if (!mounted.current) return;
      setToggleError(caught?.message || `本组批量${disabled ? "关闭" : "打开"}模型失败`);
    } finally {
      if (mounted.current) setGroupBusy(null);
    }
  };
  const resetFilters = () => {
    setQuery("");
    setStatusFilter("all");
  };
  const dialog = React3.createElement(
    "div",
    {
      // `--top`：顶部锚定。列表长度随搜索变化，若垂直居中会让弹窗整体上下跳动
      //（见 jet-hub-styles.js 中该修饰类的说明）。
      className: "dim-jh-modalOverlay",
      // 点击遮罩关闭；点击弹窗内部不关闭（stopPropagation 由内层容器负责）。
      onClick: (event) => {
        if (event.target === event.currentTarget) onClose();
      }
    },
    React3.createElement(
      "div",
      {
        className: "dim-jh-modal",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": `${providerLabel2} 模型列表`
      },
      React3.createElement(
        "div",
        { className: "dim-jh-modalHead" },
        React3.createElement(
          "div",
          { className: "dim-jh-modalTitle" },
          React3.createElement("strong", null, "模型列表"),
          React3.createElement("span", { className: "dim-jh-modalSubtitle" }, providerLabel2),
          phase === "ready" ? React3.createElement(
            "span",
            { className: "dim-jh-modelPanelCount" },
            filtering ? `${filtered.length} / ${all.length} 个模型${hiddenCount > 0 ? `，已隐藏 ${hiddenCount} 个` : ""}` : `${all.length} 个模型${hiddenCount > 0 ? `，已隐藏 ${hiddenCount} 个` : ""}`
          ) : null
        ),
        React3.createElement(
          "div",
          { className: "dim-jh-modelPanelActions" },
          React3.createElement("button", {
            className: "dim-jh-btn",
            disabled: phase === "loading",
            onClick: () => void load()
          }, phase === "loading" ? "读取中…" : "刷新"),
          React3.createElement("button", {
            className: "dim-jh-btn",
            "data-kind": "primary",
            onClick: onClose
          }, "完成")
        )
      ),
      React3.createElement(
        "p",
        { className: "dim-jh-modalHint" },
        "关闭开关后该模型不再出现在对话框的模型选择里；其余模型（含服务端新增的）默认显示。"
      ),
      // ⚠️ 失效模型提示条：它们已被上游下架并从目录剔除，故单独说明「为什么看不见」
      // 并给出**批量**恢复入口（逐个点很麻烦，而误判往往不止一个）。
      phase === "ready" && deadCount > 0 ? React3.createElement(
        "div",
        { className: "dim-jh-modelDeadBar" },
        React3.createElement(
          "span",
          null,
          `有 ${deadCount} 个模型被上游下架，已自动从列表隐藏。`
        ),
        React3.createElement("button", {
          className: "dim-jh-btn",
          disabled: deadRestoreBusy,
          title: "清空该供应商的失效模型记录，让它们重新出现在列表里。",
          onClick: () => void restoreAllDead()
        }, deadRestoreBusy ? "恢复中…" : "全部重新显示")
      ) : null,
      // 搜索 + 状态筛选：Cline 的目录实测近 500 条，没有它就只能一页页翻。
      // 只在列表可用时渲染（载入中/出错时没有可筛的内容）。
      phase === "ready" && all.length > 0 ? React3.createElement(
        "div",
        { className: "dim-jh-modelFilterBar" },
        React3.createElement("input", {
          type: "search",
          className: "dim-jh-input dim-jh-modelSearch",
          placeholder: "搜索模型名或 id…",
          value: query,
          "aria-label": "搜索模型",
          onChange: (event) => setQuery(event.target.value)
        }),
        React3.createElement(
          "div",
          { className: "dim-jh-modelStatusFilter", role: "group", "aria-label": "按状态筛选" },
          [["all", "全部"], ["enabled", "已打开"], ["disabled", "已关闭"]].map(([value, label]) => React3.createElement("button", {
            key: value,
            className: "dim-jh-btn",
            "data-active": statusFilter === value ? "true" : "false",
            "aria-pressed": statusFilter === value ? "true" : "false",
            onClick: () => setStatusFilter(value)
          }, label))
        ),
        filtering ? React3.createElement("button", {
          className: "dim-jh-btn",
          title: "清空搜索词与状态筛选，恢复完整列表。",
          onClick: resetFilters
        }, "清空筛选") : null
      ) : null,
      toggleError ? React3.createElement("div", {
        className: "dim-jh-probeNotice",
        "data-tone": "error",
        role: "alert"
      }, React3.createElement("div", null, toggleError)) : null,
      // ⚠️ 与 `toggleError` 分开渲染（Issue IKJW33）：本条是「操作成功，但没有
      // 实际效果」的说明（下架模型的空操作），用中性 tone + `role=status`；
      // 混进错误通道会让「模型已下架」看起来像插件故障。
      toggleWarnings.length > 0 ? React3.createElement("div", {
        className: "dim-jh-probeNotice",
        // ⚠️ tone 取值必须是 `warn`：样式表里定义的是 `[data-tone="warn"]`
        //（全仓既有约定），写成 `warning` 会静默落到默认中性色 —— 不报错，
        // 但提示看起来和普通文字一样，等于没做。
        "data-tone": "warn",
        role: "status"
      }, toggleWarnings.map((text, index) => React3.createElement("div", { key: index }, text))) : null,
      phase === "error" ? React3.createElement(
        "div",
        { className: "dim-jh-modalBody" },
        React3.createElement(
          "div",
          { className: "dim-jh-empty" },
          React3.createElement("p", null, error),
          React3.createElement("button", { className: "dim-jh-btn", onClick: () => void load() }, "重新读取")
        )
      ) : phase === "loading" ? React3.createElement(
        "div",
        { className: "dim-jh-modalBody" },
        React3.createElement("div", { className: "dim-jh-empty" }, "正在读取模型列表…")
      ) : all.length === 0 ? React3.createElement(
        "div",
        { className: "dim-jh-modalBody" },
        React3.createElement(
          "div",
          { className: "dim-jh-empty" },
          React3.createElement("p", null, "该 Provider 当前没有可用的模型。")
        )
      ) : filtered.length === 0 ? React3.createElement(
        "div",
        { className: "dim-jh-modalBody" },
        React3.createElement(
          "div",
          { className: "dim-jh-empty" },
          React3.createElement("p", null, "没有符合当前搜索与筛选条件的模型。"),
          React3.createElement("button", { className: "dim-jh-btn", onClick: resetFilters }, "清空筛选")
        )
      ) : React3.createElement(
        "div",
        { className: "dim-jh-modalBody" },
        React3.createElement(
          "div",
          { className: "dim-jh-modelList" },
          // **按计费/来源分组**渲染（订阅 / 免费 / Cline Cloud / 按量计费）。
          // 组内仍是全部筛选结果（**无渲染上限**）：改动前 478 条就是
          // 一次性全渲染、工作正常，加「显示更多」属于功能收缩。
          groups.map((group) => {
            const expanded = isGroupExpanded(group);
            const groupBulk = groupBulkStateFor(group, bulkBusy || groupBusy !== null);
            return React3.createElement(
              "div",
              {
                key: group.key,
                className: "dim-jh-modelGroup"
              },
              React3.createElement(
                "div",
                { className: "dim-jh-modelGroupHead" },
                React3.createElement("button", {
                  className: "dim-jh-modelGroupToggle",
                  "aria-expanded": expanded ? "true" : "false",
                  title: group.hint,
                  onClick: () => toggleGroup(group)
                }, `${expanded ? "▾" : "▸"} ${group.label}`),
                React3.createElement(
                  "span",
                  { className: "dim-jh-modelGroupCount" },
                  group.counts.disabled > 0 ? `${group.counts.shown} 个 · 已关闭 ${group.counts.disabled}` : `${group.counts.shown} 个`
                ),
                // ⚠️ 文案用裸的「全开 / 全关」：模型列表弹窗顶部那排
                //    「打开全部 / 关闭全部」工具条已按用户要求删除
                //    （2026-10-26），两排并列的歧义不复存在，不必再加「本组」前缀。
                //    title 里仍写明「只影响这一组」—— 分组头本身要能自解释。
                React3.createElement("button", {
                  className: "dim-jh-btn dim-jh-modelGroupBtn",
                  title: `打开「${group.label}」的全部模型（只影响这一组）`,
                  disabled: groupBulk.openAllDisabled,
                  onClick: () => void setGroupDisabled(group, false)
                }, "全开"),
                React3.createElement("button", {
                  className: "dim-jh-btn dim-jh-modelGroupBtn",
                  title: `关闭「${group.label}」的全部模型（只影响这一组）`,
                  disabled: groupBulk.closeAllDisabled,
                  onClick: () => void setGroupDisabled(group, true)
                }, "全关")
              ),
              expanded ? React3.createElement(
                "div",
                { className: "dim-jh-modelGroupBody" },
                group.models.map((model) => React3.createElement(ModelToggle, {
                  key: model.id,
                  // 本弹窗是**单家供应商**的详情（`provider` 来自
                  // 组件 props，与 `model.list` 用的是同一个值），
                  // 故整份列表同图标。
                  provider,
                  model,
                  // 批量提交期间一并禁用单条开关：黑名单是整体写入，
                  // 并发提交必然互相覆盖（后写的会丢掉先写的改动）。
                  // 分组批量也算「批量」，故一并计入。
                  busy: busyIds.has(model.id) || bulkBusy || groupBusy !== null,
                  onToggle: (id, disabled) => void toggleModel(id, disabled),
                  onRestore: (id) => void restoreModel(id)
                }))
              ) : null
            );
          })
        )
      )
    )
  );
  return dialog;
}
function formatStamp(ts) {
  const at = new Date(Number(ts ?? 0));
  if (!Number.isFinite(at.getTime())) return "-";
  const pad = (part) => String(part).padStart(2, "0");
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
  if (at.toDateString() === (/* @__PURE__ */ new Date()).toDateString()) return clock;
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${clock.slice(0, 5)}`;
}
function formatTokenCount2(value) {
  const n = Math.max(0, Number(value ?? 0));
  if (!Number.isFinite(n)) return "0";
  if (n < 1e5) return n.toLocaleString("en-US");
  if (n < 1e6) {
    const k = (n / 1e3).toFixed(1);
    return Number(k) >= 1e3 ? `${(n / 1e6).toFixed(1)}M` : `${k}k`;
  }
  return `${(n / 1e6).toFixed(1)}M`;
}
function formatMs(value) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return n >= 1e3 ? `${(n / 1e3).toFixed(1)}s` : `${Math.round(n)}ms`;
}
function tokenParts(row) {
  if (row?.usageReported !== true) return null;
  const parts = [
    { key: "in", icon: "↓", value: Number(row.inputTokens ?? 0) },
    { key: "out", icon: "↑", value: Number(row.outputTokens ?? 0) }
  ];
  if (Number(row.cacheReadTokens ?? 0) > 0) {
    parts.push({ key: "cache", icon: "⚡", value: Number(row.cacheReadTokens) });
  }
  if (Number(row.reasoningTokens ?? 0) > 0) {
    parts.push({ key: "think", icon: "🧠", value: Number(row.reasoningTokens) });
  }
  return parts;
}
function tokenSummary(row) {
  const parts = tokenParts(row);
  if (parts === null) return "—";
  return parts.map((part) => `${part.icon}${formatTokenCount2(part.value)}`).join(" ");
}
function tokenSummaryExact(row) {
  const parts = tokenParts(row);
  if (parts === null) return "";
  return parts.map((part) => `${part.icon}${part.value.toLocaleString("en-US")}`).join(" ");
}
var TOKEN_LEGEND = "↓输入 ↑输出 ⚡缓存 🧠推理；— 表示网关本次未返回用量";
function tokenTooltip(row) {
  const exact = tokenSummaryExact(row);
  return exact === "" ? TOKEN_LEGEND : `${exact}
${TOKEN_LEGEND}`;
}
function latencyParts(row) {
  const first = Number(row?.ttftMs ?? 0);
  const total = Number(row?.totalMs ?? 0);
  const rate = formatRowTokensPerSecond(row);
  const decodeMs = total - first;
  const rateTitle = rate !== "—" ? `官方 TPS 口径：输出 ${Number(row?.outputTokens ?? 0)} tok ÷ 生成阶段 ${(decodeMs / 1e3).toFixed(2)}s（首字之后到结束，含推理 token；官方取整：≥10 整数、<10 一位小数）` : row?.usageReported === true ? "缺少可用的生成阶段时长（首字时刻缺失或总耗时不大于首字）—— 速率不可测" : "网关本次未返回用量 —— 速率不可测";
  return { first, total, rate, rateTitle };
}
function StatusDot({ ok, title }) {
  return React3.createElement("span", {
    className: "dim-jh-quotaDot",
    "data-tone": ok ? "ok" : "error",
    title,
    "aria-label": title
  });
}
function MinimaxXffPanel({ rpcCall, value, onSaved, onClose }) {
  const mounted = React3.useRef(true);
  React3.useEffect(() => () => {
    mounted.current = false;
  }, []);
  const [draft, setDraft] = React3.useState(value ?? "");
  const [busy, setBusy] = React3.useState(false);
  const [notice, setNotice] = React3.useState(null);
  const save = async (override) => {
    const payloadValue = typeof override === "string" ? override : draft;
    setBusy(true);
    setNotice(null);
    try {
      const res = await rpcCall("minimax.setXff", { xff: payloadValue });
      if (!mounted.current) return;
      const next = typeof res?.xff === "string" ? res.xff : "";
      setDraft(next);
      onSaved(next);
      setNotice(next === "" ? { kind: "ok", text: "已清除：后续请求不附 X-Forwarded-For（将按真实出口 IP 分流）。" } : { kind: "ok", text: `已保存并生效：${next}` });
    } catch (caught) {
      if (!mounted.current) return;
      setDraft(value ?? "");
      setNotice({
        kind: "bad",
        text: (caught instanceof Error ? caught.message : String(caught)) + `（当前生效值未改动：${value === "" ? "未设置" : value}）`
      });
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return React3.createElement(
    "div",
    {
      className: "dim-jh-modalOverlay",
      onClick: (event) => {
        if (event.target === event.currentTarget) onClose();
      }
    },
    React3.createElement(
      "div",
      {
        className: "dim-jh-modal",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": "MiniMax 国际站分流设置"
      },
      React3.createElement(
        "div",
        { className: "dim-jh-modalHead" },
        React3.createElement(
          "div",
          { className: "dim-jh-modalTitle" },
          React3.createElement("strong", null, "MiniMax 国际站分流设置")
        ),
        React3.createElement(
          "div",
          { className: "dim-jh-modelPanelActions" },
          React3.createElement("button", {
            className: "dim-jh-btn",
            onClick: onClose
          }, "关闭")
        )
      ),
      React3.createElement(
        "div",
        { className: "dim-jh-modalBody" },
        // ── 原因说明 ──
        React3.createElement(
          "div",
          { className: "dim-jh-hint" },
          "MiniMax 国际站的服务器按**出口 IP 所在国家**分流：中国大陆 IP 会被重定向到中国站，从而出现「余额查询失败」「模型不可用」，而凭据本身是好的。"
        ),
        // ── 两条出路（先给更正当的那条）──
        React3.createElement(
          "div",
          { className: "dim-jh-hint" },
          "① 推荐：用代理把出口 IP 改到海外（此时无需本设置）；② 应急：在下面填一个海外 IP，让请求被判为海外来源。"
        ),
        // ── 输入 ──
        React3.createElement(
          "div",
          { className: "dim-jh-field" },
          React3.createElement(
            "label",
            { className: "dim-jh-fieldLabel", htmlFor: "dim-jh-minimax-xff" },
            "X-Forwarded-For（留空 = 不伪造来源）"
          ),
          React3.createElement("input", {
            id: "dim-jh-minimax-xff",
            className: "dim-jh-input",
            type: "text",
            value: draft,
            spellCheck: false,
            autoComplete: "off",
            placeholder: "例如 8.8.8.8（只接受 IPv4 / IPv6）",
            disabled: busy,
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === "Enter" && !busy) void save();
            }
          })
        ),
        // ── 结果 / 错误 ──
        notice !== null ? React3.createElement("div", {
          className: "dim-jh-hint",
          style: notice.kind === "bad" ? { color: "var(--dim-danger, #e5534b)" } : void 0
        }, notice.text) : null,
        // ── 风险说明（必须显式写出来）──
        React3.createElement(
          "div",
          { className: "dim-jh-hint" },
          "⚠️ 该值是**声明一个并非本机的来源 IP**，仅在应急时使用；上游若改为不信任该头，本设置会失效（届时仍会如实报错，不会假装成功）。"
        ),
        // ── 操作 ──
        React3.createElement(
          "div",
          { className: "dim-jh-modalActions" },
          React3.createElement("button", {
            className: "dim-jh-btn",
            "data-kind": "primary",
            disabled: busy,
            onClick: () => void save()
          }, busy ? "保存中…" : "保存"),
          /**
           * ⚠️ 「清除设置」**必须真的落盘**，不能只清输入框。
           *
           * 初版写的是 `onClick: () => setDraft('')` —— 只改了本地草稿，
           * 后端仍是旧值。用户点完看到输入框空了，会以为已经关掉绕过分流，
           * 而实际请求**仍在带 XFF**（症状：他以为改回了正常行为，其实没有）。
           * ⇒ 这里直接调后端清空并回读，语义与「保存空值」完全一致。
           */
          React3.createElement("button", {
            className: "dim-jh-btn",
            disabled: busy || draft === "" && value === "",
            /**
             * ⚠️ **不要在这里 `setDraft('')`**（2026-10-17 审计指出的细节）：
             * `save('')` 成功后会回读 `next` 并 `setDraft(next)`；失败时 catch 会把
             * draft 回滚到真值 `value`。若这里先清空，一旦失败就会出现
             * 「输入框空、实际仍带 XFF」的不一致。
             */
            onClick: () => {
              void save("");
            }
          }, "清除设置")
        )
      )
    )
  );
}
function ClineQuotaPanel({ rpcCall, onClose }) {
  const mounted = React3.useRef(true);
  React3.useEffect(() => () => {
    mounted.current = false;
  }, []);
  const [quota, setQuota] = React3.useState([]);
  const [quotaPhase, setQuotaPhase] = React3.useState("loading");
  const [quotaError, setQuotaError] = React3.useState("");
  const [viewIndex, setViewIndex] = React3.useState(0);
  const [logNonce, setLogNonce] = React3.useState(0);
  const [rows, setRows] = React3.useState([]);
  const [logPhase, setLogPhase] = React3.useState("idle");
  const [logError, setLogError] = React3.useState("");
  const loadQuota = React3.useCallback(async () => {
    setQuotaPhase("loading");
    setQuotaError("");
    try {
      const res = await rpcCall("cline.quota", { provider: "cline" });
      if (!mounted.current) return;
      const list = Array.isArray(res?.accounts) ? res.accounts : [];
      setQuota(list);
      setQuotaPhase("ready");
    } catch (caught) {
      if (!mounted.current) return;
      console.error("[jet-hub] load cline quota failed:", caught);
      setQuotaError(caught?.message || "订阅额度查询失败");
      setQuotaPhase("error");
    }
  }, [rpcCall]);
  React3.useEffect(() => {
    void loadQuota();
  }, [loadQuota]);
  const loadLog = React3.useCallback(async (accountId) => {
    setLogPhase("loading");
    setLogError("");
    try {
      const res = await rpcCall("cline.requestLog", { provider: "cline", accountId });
      if (!mounted.current) return;
      setRows(Array.isArray(res?.rows) ? res.rows : []);
    } catch (caught) {
      if (!mounted.current) return;
      console.error("[jet-hub] load cline request log failed:", caught);
      setLogError(caught?.message || "请求记录查询失败");
    } finally {
      if (mounted.current) setLogPhase("ready");
    }
  }, [rpcCall]);
  const viewAccount = quota.length > 0 ? quota[Math.min(viewIndex, quota.length - 1)] : void 0;
  const viewAccountId = viewAccount?.accountId ?? "";
  const stepView = (delta) => {
    if (quota.length === 0) return;
    setViewIndex((prev) => ((prev + delta) % quota.length + quota.length) % quota.length);
  };
  React3.useEffect(() => {
    if (viewAccountId === "") return;
    void loadLog(viewAccountId);
  }, [viewAccountId, logNonce, loadLog]);
  const renderQuota = () => {
    if (quotaPhase === "loading" && quota.length === 0) {
      return React3.createElement("div", { className: "dim-jh-empty" }, "正在读取订阅额度…");
    }
    if (quotaPhase === "error") {
      return React3.createElement(
        "div",
        { className: "dim-jh-empty", role: "alert" },
        React3.createElement("p", null, quotaError),
        React3.createElement("button", { className: "dim-jh-btn", onClick: () => void loadQuota() }, "重试")
      );
    }
    if (quota.length === 0) {
      return React3.createElement("div", { className: "dim-jh-empty" }, "尚未配置账号");
    }
    const entry2 = viewAccount;
    if (entry2 === void 0) return null;
    const pager = quota.length > 1 ? React3.createElement(
      "div",
      { className: "dim-jh-quotaPager" },
      React3.createElement("button", {
        className: "dim-jh-quotaArrow",
        title: "上一个账号",
        "aria-label": "上一个账号",
        onClick: () => stepView(-1)
      }, "‹"),
      React3.createElement(
        "div",
        { className: "dim-jh-quotaAccountName" },
        React3.createElement("span", {
          className: "dim-jh-quotaAccountLabel",
          title: entry2.nickname || entry2.accountId
        }, entry2.nickname || entry2.accountId),
        React3.createElement(
          "span",
          { className: "dim-jh-quotaIndex" },
          `第 ${viewIndex + 1} / ${quota.length} 个`
        )
      ),
      React3.createElement("button", {
        className: "dim-jh-quotaArrow",
        title: "下一个账号",
        "aria-label": "下一个账号",
        onClick: () => stepView(1)
      }, "›")
    ) : null;
    const windows = quotaWindowsOf(entry2.windows);
    const body = entry2.ok ? windows.length === 0 ? React3.createElement("div", { className: "dim-jh-quotaMuted" }, "官方未返回额度窗口。") : React3.createElement(
      "div",
      { className: "dim-jh-quotaWindows" },
      windows.map(([type, label, win]) => {
        const percent = quotaPercentValue(win.percentUsed);
        const tone = quotaTone(percent);
        const resetsIn = quotaResetsIn(win.resetsAt);
        return React3.createElement(
          "div",
          {
            key: `${type}`,
            className: "dim-jh-quotaWindow"
          },
          React3.createElement(
            "div",
            { className: "dim-jh-quotaWindowHead" },
            React3.createElement("span", { className: "dim-jh-quotaWindowName" }, label),
            // ⚠️ 18px 大字 + 夹取后取整(参考实现同款):百分比是这张卡
            // 唯一要读的数,值得占最大的字级。
            React3.createElement("span", {
              className: "dim-jh-quotaWindowPercent",
              "data-tone": tone
            }, formatQuotaPercent(percent))
          ),
          React3.createElement(
            "div",
            {
              className: "dim-jh-quotaBar",
              role: "progressbar",
              "aria-label": `${label} 已用`,
              "aria-valuenow": percent,
              "aria-valuemin": 0,
              "aria-valuemax": 100
            },
            React3.createElement("div", {
              className: "dim-jh-quotaBarFill",
              "data-tone": tone,
              style: { width: `${percent}%` }
            })
          ),
          resetsIn === "" ? null : React3.createElement("div", { className: "dim-jh-quotaReset" }, resetsIn)
        );
      })
    ) : React3.createElement(
      "div",
      { className: "dim-jh-quotaMuted" },
      `暂时读不到官方额度。${entry2.error ? ` ${entry2.error}` : ""}`
    );
    return React3.createElement("div", {
      // ⚠️ 按账号 id 作 key → 切账号时**重新挂载**该块(参考实现同款):
      // 否则进度条的 width 过渡会在两个账号的读数之间播放,
      // 看起来像"这个账号的额度在涨",而那只是动画。
      key: entry2.accountId,
      className: "dim-jh-quotaGroup"
    }, pager, body);
  };
  const renderLog = () => {
    if (viewAccountId === "") return null;
    const head = React3.createElement(
      "h3",
      { className: "dim-jh-quotaSectionTitle" },
      "请求记录"
    );
    const hint = React3.createElement(
      "p",
      { className: "dim-jh-quotaLogHint" },
      "是本插件发出的请求流水（进程内存，重启后清空），不是官方账单 —— 官方渠道的消费在 Cline 自己的用量页里。"
    );
    const tableHead = React3.createElement(
      "thead",
      null,
      React3.createElement(
        "tr",
        null,
        React3.createElement("th", { className: "dim-jh-quotaDotCol" }, ""),
        React3.createElement("th", { className: "dim-jh-quotaWhenCol" }, "时间"),
        React3.createElement("th", null, "模型 / 上游"),
        React3.createElement("th", null, "TOKEN"),
        React3.createElement("th", null, "延迟")
      )
    );
    const colGroup = React3.createElement(
      "colgroup",
      null,
      React3.createElement("col", { className: "dim-jh-quotaDotCol" }),
      React3.createElement("col", { className: "dim-jh-quotaWhenCol" }),
      React3.createElement("col", null),
      React3.createElement("col", { className: "dim-jh-quotaTokensCol" }),
      React3.createElement("col", { className: "dim-jh-quotaLoadCol" })
    );
    const tableBody = React3.createElement(
      "tbody",
      null,
      rows.flatMap((row, index) => {
        const key = `${row.ts}-${index}`;
        const failed = row.error !== void 0;
        const figures = latencyParts(row);
        const label = String(row.model ?? "").replace(/^cline-pass\//, "");
        const cells = [
          React3.createElement("td", null, React3.createElement(StatusDot, {
            ok: !failed,
            title: failed ? String(row.error) : "成功"
          })),
          React3.createElement("td", { className: "dim-jh-quotaWhen" }, formatStamp(row.ts)),
          React3.createElement(
            "td",
            null,
            React3.createElement("span", {
              className: "dim-jh-quotaModel",
              title: String(row.model ?? "")
            }, label || "—"),
            // 上游与模型是两个维度:同模型可能由不同通道服务,拼一列会让
            // 「同名不同上游」的行无法区分。
            React3.createElement(
              "span",
              { className: "dim-jh-quotaMeta" },
              React3.createElement(
                "span",
                { className: "dim-jh-quotaTag" },
                row.upstream || "—"
              )
            )
          ),
          React3.createElement("td", {
            className: "dim-jh-quotaTokens",
            // ⚠️ tooltip = **精确**数字 + 图例:单元格里超过 10 万会缩写成 k/M,
            // tooltip 是唯一保留个位的地方;`—` 的含义也只在图例里解释
            // (参考实现同款)。
            title: tokenTooltip(row)
          }, tokenSummary(row)),
          React3.createElement(
            "td",
            { className: "dim-jh-quotaLoad" },
            React3.createElement(
              "span",
              { className: "dim-jh-quotaLoadRow" },
              React3.createElement("span", { className: "dim-jh-quotaLoadKey" }, "首字"),
              React3.createElement("span", null, formatMs(figures.first))
            ),
            React3.createElement(
              "span",
              { className: "dim-jh-quotaLoadRow" },
              React3.createElement("span", { className: "dim-jh-quotaLoadKey" }, "总耗时"),
              React3.createElement("span", null, formatMs(figures.total))
            ),
            React3.createElement(
              "span",
              { className: "dim-jh-quotaLoadRow", title: figures.rateTitle },
              React3.createElement("span", { className: "dim-jh-quotaLoadKey" }, "输出速度"),
              React3.createElement("span", null, figures.rate)
            )
          )
        ];
        const rowEl = React3.createElement("tr", {
          key,
          "data-error": failed ? "error" : void 0,
          // 整行 restate 一遍事实(含 token 与速率):截图或复制时信息不丢
          // (参考实现同款)。⚠️ 这里用**有界**的 tokenSummary(不是精确值),
          // 与参考实现一致:精确个位只出现在 TOKEN 单元格的 tooltip 里。
          title: [
            String(row.model ?? ""),
            `${row.upstream || "—"} · ${tokenSummary(row)}`,
            `首字 ${formatMs(figures.first)} · 总耗时 ${formatMs(figures.total)} · 输出速度 ${figures.rate}`,
            // 推理强度:有值时才有这一行(参考实现同款)。
            row.effort ? `推理强度 ${row.effort}` : "",
            failed ? String(row.error) : ""
          ].filter((line) => line !== "").join("\n")
        }, ...cells);
        if (failed) {
          return [
            rowEl,
            React3.createElement(
              "tr",
              { key: `${key}-err`, "data-error": "error" },
              React3.createElement("td", null, ""),
              React3.createElement("td", null, ""),
              React3.createElement("td", {
                className: "dim-jh-quotaError",
                colSpan: 3,
                title: String(row.error)
              }, String(row.error))
            )
          ];
        }
        return [rowEl];
      })
    );
    const table = React3.createElement(
      "table",
      { className: "dim-jh-quotaTable" },
      colGroup,
      tableHead,
      tableBody
    );
    const wrap = React3.createElement(
      "div",
      { className: "dim-jh-quotaTableWrap" },
      table
    );
    const empty = React3.createElement(
      "div",
      { className: "dim-jh-empty" },
      logError === "" ? "暂无记录。（面板打开后新发起的请求才会出现在这里）" : logError
    );
    const body = logPhase === "loading" ? React3.createElement("div", { className: "dim-jh-empty" }, "正在读取请求记录…") : rows.length === 0 ? empty : wrap;
    return React3.createElement(
      "div",
      { className: "dim-jh-quotaLog" },
      head,
      hint,
      body
    );
  };
  const quotaSubtitle = () => {
    if (quota.length > 1) return `Cline · ${quota.length} 个账号`;
    const only = quota[0];
    if (only === void 0) return "Cline";
    return `Cline · 账号 ${only.nickname || only.accountId}`;
  };
  return React3.createElement(
    "div",
    {
      className: "dim-jh-modalOverlay",
      onClick: (event) => {
        if (event.target === event.currentTarget) onClose();
      }
    },
    React3.createElement(
      "div",
      {
        className: "dim-jh-modal",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": "Cline 订阅额度"
      },
      React3.createElement(
        "div",
        { className: "dim-jh-modalHead" },
        React3.createElement(
          "div",
          { className: "dim-jh-modalTitle" },
          React3.createElement("strong", null, "订阅额度"),
          React3.createElement("span", { className: "dim-jh-modalSubtitle" }, quotaSubtitle())
        ),
        React3.createElement(
          "div",
          { className: "dim-jh-modelPanelActions" },
          React3.createElement("button", {
            className: "dim-jh-btn",
            disabled: quotaPhase === "loading",
            title: "重新查询全部账号的订阅额度窗口，并重读当前账号的请求记录。",
            onClick: () => {
              void loadQuota();
              setLogNonce((n) => n + 1);
            }
          }, quotaPhase === "loading" ? "读取中…" : "刷新"),
          React3.createElement("button", {
            className: "dim-jh-btn",
            "data-kind": "primary",
            onClick: onClose
          }, "完成")
        )
      ),
      React3.createElement(
        "p",
        { className: "dim-jh-modalHint" },
        "额度窗口来自 Cline 官方网关；请求记录是本插件自己发出的请求流水（重启后清空）。两者与账号卡片上的「积分」是三份不同的读数：积分答「还剩多少」，额度答「各时间窗用掉百分之几」，记录答「每一笔发了多久、花了多少 token」。"
      ),
      // ⚠️ 内容**必须**放进 .dim-jh-modalBody（flex:1; min-height:0; overflow-y:auto）。
      // .dim-jh-modal 是 max-height 有限的 flex **列**容器，子项默认不可收缩，
      // 内容直接铺在里面就会**画出弹窗边界之外** —— 首版正是漏了这一层：
      // 额度卡 + 请求表把弹窗撑破，看起来像「弹窗位置不对、内容显示不对」。
      // 模型列表弹窗的内容同样在 modalBody 里（见其 error/loading/empty 分支）。
      React3.createElement(
        "div",
        { className: "dim-jh-modalBody" },
        renderQuota(),
        renderLog()
      )
    )
  );
}
function csvCell(value) {
  let text = value === null || value === void 0 ? "" : String(value);
  if (/^\s*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
function downloadCsv(filename, headers, rows) {
  const body = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob(["\uFEFF", body], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1e3);
}
function TokenLedgerPanel({ rpcCall, onClose }) {
  const mounted = React3.useRef(true);
  React3.useEffect(() => () => {
    mounted.current = false;
  }, []);
  const [snapshot, setSnapshot] = React3.useState(null);
  const [phase, setPhase] = React3.useState("loading");
  const [error, setError] = React3.useState("");
  const [selected, setSelected] = React3.useState(null);
  const [historyRange, setHistoryRange] = React3.useState("30d");
  const [historyFromDay, setHistoryFromDay] = React3.useState("");
  const [historyToDay, setHistoryToDay] = React3.useState("");
  const [history, setHistory] = React3.useState(null);
  const [historyPhase, setHistoryPhase] = React3.useState("idle");
  const [deletingHistoryDay, setDeletingHistoryDay] = React3.useState(null);
  const [historyDeleteError, setHistoryDeleteError] = React3.useState("");
  const [expandedDay, setExpandedDay] = React3.useState(null);
  const [hoveredDay, setHoveredDay] = React3.useState(null);
  const [entryQuery, setEntryQuery] = React3.useState("");
  const [entryChannel, setEntryChannel] = React3.useState("all");
  const [entryStatus, setEntryStatus] = React3.useState("all");
  const [entrySort, setEntrySort] = React3.useState("newest");
  const [entryPage, setEntryPage] = React3.useState(1);
  const load = React3.useCallback(async () => {
    setPhase("loading");
    setError("");
    try {
      const res = await rpcCall("usage.tokenLedger", {});
      if (!mounted.current) return;
      setSnapshot(res?.snapshot ?? null);
      setPhase("ready");
    } catch (caught) {
      if (!mounted.current) return;
      console.error("[jet-hub] load token ledger failed:", caught);
      setError(caught?.message || "Token 用量读取失败");
      setPhase("error");
    }
  }, [rpcCall]);
  React3.useEffect(() => {
    void load();
  }, [load]);
  const loadHistory = React3.useCallback(async (rangeKey, fromDay = historyFromDay, toDay = historyToDay) => {
    if (rangeKey === "custom" && fromDay && toDay && fromDay > toDay) {
      setHistory(null);
      setHistoryPhase("ready");
      return;
    }
    setHistoryPhase("loading");
    try {
      const days = rangeDaysOf(rangeKey);
      const payload = rangeKey === "custom" ? { ...fromDay ? { fromDay } : {}, ...toDay ? { toDay } : {} } : days > 0 ? { sinceDays: days } : {};
      const res = await rpcCall("usage.tokenLedgerHistory", payload);
      if (!mounted.current) return;
      setHistory(res ?? null);
      setHistoryPhase("ready");
    } catch (caught) {
      if (!mounted.current) return;
      console.error("[jet-hub] load token ledger history failed:", caught);
      setHistory(null);
      setHistoryPhase("error");
    }
  }, [historyFromDay, historyToDay, rpcCall]);
  const deleteHistoryDay = React3.useCallback(async (day) => {
    if (typeof day !== "string" || !confirm(
      `确认删除 ${day} 的历史用量？只清除这一天的日累计，不会清除实时明细、其他日期或账号设置。`
    )) return;
    setDeletingHistoryDay(day);
    setHistoryDeleteError("");
    try {
      await rpcCall("usage.tokenLedgerDeleteDay", { day });
      if (!mounted.current) return;
      setExpandedDay(null);
      await loadHistory(historyRange);
    } catch (caught) {
      if (!mounted.current) return;
      console.error("[jet-hub] delete token ledger history failed:", caught);
      setHistoryDeleteError(caught?.message || `${day} 历史用量删除失败`);
    } finally {
      if (mounted.current) setDeletingHistoryDay(null);
    }
  }, [historyRange, loadHistory, rpcCall]);
  React3.useEffect(() => {
    void loadHistory(historyRange);
  }, [historyRange, historyFromDay, historyToDay, loadHistory]);
  const channels = React3.useMemo(() => {
    const list = Array.isArray(snapshot?.channels) ? [...snapshot.channels] : [];
    list.sort((a, b) => channelOrder(a?.channel, b?.channel));
    return selected === null ? list : list.filter((c) => c?.channel === selected);
  }, [snapshot, selected]);
  const perfCell = (row) => React3.createElement("span", {
    className: "dim-jh-ledgerPerf",
    title: avgPerfDetailTooltip(row)
  }, avgPerfText(row));
  const renderModelRow = (modelRow, key) => React3.createElement(
    "div",
    {
      key,
      className: "dim-jh-ledgerModel"
    },
    React3.createElement("span", { className: "dim-jh-ledgerModelName", title: modelRow.model }, modelRow.model),
    React3.createElement(
      "span",
      { className: "dim-jh-ledgerModelReq", title: "请求数（含失败）" },
      modelRow.requests + " 次"
    ),
    perfCell(modelRow),
    React3.createElement(
      "span",
      { className: "dim-jh-ledgerModelTokens", title: tokenSummaryTooltip(modelRow) },
      tokenSummaryText(modelRow)
    )
  );
  const renderSummary = () => {
    if (phase === "loading" && snapshot === null) {
      return React3.createElement("div", { className: "dim-jh-empty" }, "正在读取 Token 用量…");
    }
    if (phase === "error") {
      return React3.createElement(
        "div",
        { className: "dim-jh-empty", role: "alert" },
        React3.createElement("p", null, error),
        React3.createElement("button", { className: "dim-jh-btn", onClick: () => void load() }, "重试")
      );
    }
    if (!hasAnyData(snapshot)) {
      return React3.createElement(
        "div",
        { className: "dim-jh-empty" },
        React3.createElement("p", null, "还没有任何请求记录。"),
        React3.createElement(
          "p",
          null,
          "本插件在每次模型请求结束时记录 token 用量（含直连与网关两条通道），重启 DSH 后清空。"
        )
      );
    }
    const present = Array.from(new Set((snapshot?.channels ?? []).map((c) => c?.channel)));
    const filterRow = present.length > 1 ? React3.createElement(
      "div",
      { className: "dim-jh-ledgerFilters", key: "filters" },
      [null, ...present].map((key) => React3.createElement("button", {
        key: key === null ? "all" : key,
        className: "dim-jh-btn dim-jh-ledgerFilterBtn",
        "data-active": selected === key ? "true" : "false",
        onClick: () => setSelected(key)
      }, key === null ? "全部" : channelLabel(key)))
    ) : null;
    const renderProviderBody = (providerRow) => {
      const accounts = providerRow.accounts ?? [];
      if (accounts.length > 1) {
        return accounts.map((accountRow) => React3.createElement(
          "div",
          {
            key: providerRow.provider + "#" + accountRow.accountId,
            className: "dim-jh-ledgerAccount"
          },
          React3.createElement(
            "div",
            { className: "dim-jh-ledgerAccountHead" },
            React3.createElement(
              "span",
              { className: "dim-jh-ledgerAccountName", title: accountRow.accountId },
              accountLabel(accountRow.accountId)
            ),
            perfCell(accountRow.totals),
            React3.createElement(
              "span",
              { className: "dim-jh-ledgerAccountSum", title: tokenSummaryTooltip(accountRow.totals) },
              tokenSummaryText(accountRow.totals)
            )
          ),
          accountRow.models.map((modelRow) => renderModelRow(modelRow, modelRow.model))
        ));
      }
      return accounts.flatMap((accountRow) => accountRow.models.map((modelRow) => renderModelRow(modelRow, providerRow.provider + "#" + modelRow.model)));
    };
    return React3.createElement(
      React3.Fragment,
      null,
      filterRow,
      // 汇总卡：渠道 → provider → 账号 → 模型（第 2 期加了账号层）。
      // provider / 账号行带自身小计（与模型行同列对齐）。
      channels.map((channelRow) => React3.createElement(
        "div",
        {
          key: channelRow.channel,
          className: "dim-jh-ledgerCard"
        },
        React3.createElement(
          "div",
          { className: "dim-jh-ledgerCardHead" },
          React3.createElement("strong", null, channelCardTitle(channelRow)),
          perfCell(channelRow.totals),
          React3.createElement(
            "span",
            { className: "dim-jh-ledgerCardSum", title: tokenSummaryTooltip(channelRow.totals) },
            tokenSummaryText(channelRow.totals)
          )
        ),
        channelRow.providers.map((providerRow) => React3.createElement(
          "div",
          {
            key: providerRow.provider,
            className: "dim-jh-ledgerProvider"
          },
          React3.createElement(
            "div",
            { className: "dim-jh-ledgerProviderHead" },
            React3.createElement("span", { className: "dim-jh-ledgerProviderName" }, providerRow.provider),
            perfCell(providerRow.totals),
            React3.createElement(
              "span",
              { className: "dim-jh-ledgerProviderSum", title: tokenSummaryTooltip(providerRow.totals) },
              tokenSummaryText(providerRow.totals)
            )
          ),
          renderProviderBody(providerRow)
        ))
      ))
    );
  };
  const entries = Array.isArray(snapshot?.entries) ? snapshot.entries : [];
  const visibleEntries = React3.useMemo(() => {
    const query = entryQuery.trim().toLowerCase();
    const filtered = entries.filter((entry2) => {
      if (entryChannel !== "all" && entry2.channel !== entryChannel) return false;
      if (entryStatus === "success" && entry2.error !== void 0) return false;
      if (entryStatus === "error" && entry2.error === void 0) return false;
      if (query && !String(entry2.model ?? "").toLowerCase().includes(query)) return false;
      return true;
    });
    const tokenValue = totalTokensOf;
    filtered.sort((a, b) => {
      if (entrySort === "tokens") return tokenValue(b) - tokenValue(a) || b.ts - a.ts;
      if (entrySort === "duration") return (b.durationMs ?? 0) - (a.durationMs ?? 0) || b.ts - a.ts;
      if (entrySort === "speed") return (b.tps ?? 0) - (a.tps ?? 0) || b.ts - a.ts;
      return b.ts - a.ts;
    });
    return filtered;
  }, [entries, entryChannel, entryQuery, entrySort, entryStatus]);
  React3.useEffect(() => {
    setEntryPage(1);
  }, [entryChannel, entryQuery, entrySort, entryStatus]);
  const entryPageCount = Math.max(1, Math.ceil(visibleEntries.length / 50));
  const safeEntryPage = Math.min(entryPage, entryPageCount);
  const pageEntries = visibleEntries.slice((safeEntryPage - 1) * 50, safeEntryPage * 50);
  const exportEntries = () => downloadCsv(
    "token-usage-details.csv",
    ["时间", "渠道", "模型", "状态", "总处理量", "输入", "输出", "缓存命中", "缓存写入", "推理", "首字毫秒", "输出tok每秒", "耗时毫秒", "错误"],
    visibleEntries.map((entry2) => [
      Number.isFinite(entry2.ts) ? new Date(entry2.ts).toISOString() : "",
      channelLabel(entry2.channel),
      entry2.model,
      entry2.error === void 0 ? "成功" : "失败",
      // ⚠️ 未收到 usage 的失败行导出**空串**而非 0：界面用 `—` 与真实的 0 严格区分
      //（见 token-ledger.ts 的「0 会被读成瞬间完成、没花 token」注释），
      // CSV 若写 0 就与界面自相矛盾，且 Excel 里再也分不出「没数据」与「真的是 0」。
      entry2.usageReported === false ? "" : totalTokensOf(entry2),
      entry2.usageReported === false ? "" : entry2.inputTokens ?? 0,
      entry2.usageReported === false ? "" : entry2.outputTokens ?? 0,
      entry2.cacheReadTokens ?? 0,
      entry2.cacheWriteTokens ?? 0,
      entry2.reasoningTokens ?? 0,
      entry2.ttftMs ?? "",
      entry2.tps ?? "",
      entry2.durationMs ?? "",
      entry2.error ?? ""
    ])
  );
  const renderEntries = () => {
    if (entries.length === 0) return null;
    const toolbar = React3.createElement(
      "div",
      { className: "dim-jh-ledgerEntryTools" },
      React3.createElement("strong", null, "最近请求"),
      React3.createElement("span", { className: "dim-jh-ledgerEntryCount" }, `${visibleEntries.length} / ${entries.length}`),
      React3.createElement("input", {
        className: "dim-jh-input dim-jh-ledgerSearch",
        type: "search",
        value: entryQuery,
        placeholder: "筛选模型",
        "aria-label": "按模型筛选请求",
        onChange: (event) => setEntryQuery(event.target.value)
      }),
      React3.createElement("select", {
        className: "dim-jh-ledgerSelect",
        value: entryChannel,
        "aria-label": "按渠道筛选请求",
        onChange: (event) => setEntryChannel(event.target.value)
      }, [
        React3.createElement("option", { key: "all", value: "all" }, "全部渠道"),
        React3.createElement("option", { key: "direct", value: "direct" }, "直连"),
        React3.createElement("option", { key: "gateway", value: "gateway" }, "网关")
      ]),
      React3.createElement("select", {
        className: "dim-jh-ledgerSelect",
        value: entryStatus,
        "aria-label": "按请求状态筛选",
        onChange: (event) => setEntryStatus(event.target.value)
      }, [
        React3.createElement("option", { key: "all", value: "all" }, "全部状态"),
        React3.createElement("option", { key: "success", value: "success" }, "成功"),
        React3.createElement("option", { key: "error", value: "error" }, "失败")
      ]),
      React3.createElement("select", {
        className: "dim-jh-ledgerSelect",
        value: entrySort,
        "aria-label": "请求排序方式",
        onChange: (event) => setEntrySort(event.target.value)
      }, [
        React3.createElement("option", { key: "newest", value: "newest" }, "最新优先"),
        React3.createElement("option", { key: "tokens", value: "tokens" }, "Token 量最多"),
        React3.createElement("option", { key: "duration", value: "duration" }, "耗时最长"),
        React3.createElement("option", { key: "speed", value: "speed" }, "速率最高")
      ]),
      React3.createElement("button", {
        className: "dim-jh-btn dim-jh-ledgerExport",
        onClick: exportEntries,
        disabled: visibleEntries.length === 0,
        title: "导出当前筛选后的请求明细 CSV"
      }, "导出明细")
    );
    if (visibleEntries.length === 0) return React3.createElement(
      "div",
      { key: "entries" },
      toolbar,
      React3.createElement("div", { className: "dim-jh-empty" }, "没有符合当前筛选条件的请求。")
    );
    return React3.createElement(
      "div",
      { key: "entries" },
      toolbar,
      React3.createElement(
        "table",
        { className: "dim-jh-ledgerTable" },
        React3.createElement(
          "thead",
          null,
          React3.createElement(
            "tr",
            null,
            ["时间", "渠道", "模型", "TOKEN", "首字", "速率", "耗时", "状态"].map((h) => React3.createElement("th", {
              key: h,
              title: h === "TOKEN" ? "总处理量 = 未命中缓存输入 + 缓存命中输入 + 输出；缓存写入单列展示，不重复计入总量" : void 0
            }, h))
          )
        ),
        React3.createElement("tbody", null, pageEntries.map((entry2, index) => React3.createElement(
          "tr",
          {
            key: entry2.ts + "-" + index,
            "data-error": entry2.error !== void 0 ? "true" : "false"
          },
          React3.createElement("td", { title: new Date(entry2.ts).toLocaleString() }, formatEntryTime(entry2.ts)),
          React3.createElement("td", null, channelLabel(entry2.channel)),
          React3.createElement("td", { className: "dim-jh-ledgerEntryModel" }, entry2.model),
          React3.createElement("td", { title: tokenSummaryTooltip(entry2) }, entryTokenText(entry2)),
          React3.createElement("td", null, formatTtft(entry2)),
          React3.createElement("td", null, formatTps(entry2)),
          React3.createElement("td", null, formatDuration(entry2.durationMs)),
          React3.createElement("td", {
            className: entry2.error !== void 0 ? "dim-jh-ledgerError" : "dim-jh-ledgerSuccess",
            title: entry2.error !== void 0 ? entry2.error : "请求成功",
            "aria-label": entry2.error !== void 0 ? "失败详情：" + entry2.error : "请求成功"
          }, entry2.error !== void 0 ? "失败 ⓘ" : "成功 ✓")
        )))
      ),
      React3.createElement(
        "div",
        { className: "dim-jh-ledgerPagination" },
        React3.createElement("span", null, `第 ${safeEntryPage} / ${entryPageCount} 页，每页 50 条`),
        React3.createElement("button", {
          className: "dim-jh-btn",
          disabled: safeEntryPage <= 1,
          onClick: () => setEntryPage((page) => Math.max(1, page - 1))
        }, "上一页"),
        React3.createElement("button", {
          className: "dim-jh-btn",
          disabled: safeEntryPage >= entryPageCount,
          onClick: () => setEntryPage((page) => Math.min(entryPageCount, page + 1))
        }, "下一页")
      )
    );
  };
  const historyDays = Array.isArray(history?.history) ? history.history : [];
  const heatmapDays = historyRange === "custom" ? Math.min(90, historyFromDay && historyToDay ? Math.max(1, Math.round((Date.parse(historyToDay + "T00:00:00Z") - Date.parse(historyFromDay + "T00:00:00Z")) / 864e5) + 1) : 30) : rangeDaysOf(historyRange) || 90;
  const heatmapEndDay = historyRange === "custom" && historyToDay ? historyToDay : todayDayKey();
  const heatmapCells = historyHeatmapCells(historyDays, heatmapDays, heatmapEndDay);
  const selectedHistoryDay = historyDays.find((d) => d?.day === (hoveredDay ?? expandedDay)) ?? null;
  const invalidHistoryRange = historyRange === "custom" && historyFromDay && historyToDay && historyFromDay > historyToDay;
  const exportHistory = () => downloadCsv(
    "token-usage-history.csv",
    ["日期", "请求数", "总处理量", "输入", "输出", "缓存命中", "缓存写入", "推理"],
    historyDays.map((day) => [
      day.day,
      day.totals?.requests ?? 0,
      day.totals?.totalTokens ?? 0,
      day.totals?.inputTokens ?? 0,
      day.totals?.outputTokens ?? 0,
      day.totals?.cacheReadTokens ?? 0,
      day.totals?.cacheWriteTokens ?? 0,
      day.totals?.reasoningTokens ?? 0
    ])
  );
  const renderHistory = () => {
    const rangeRow = React3.createElement(
      "div",
      { className: "dim-jh-ledgerFilters", key: "historyRanges" },
      HISTORY_RANGES.map((r) => React3.createElement("button", {
        key: r.key,
        className: "dim-jh-btn dim-jh-ledgerFilterBtn",
        "data-active": historyRange === r.key ? "true" : "false",
        onClick: () => {
          setHistoryRange(r.key);
          setExpandedDay(null);
        }
      }, r.label)),
      React3.createElement("button", {
        key: "custom",
        className: "dim-jh-btn dim-jh-ledgerFilterBtn",
        "data-active": historyRange === "custom" ? "true" : "false",
        onClick: () => {
          const today = todayDayKey();
          const [year, month, date] = today.split("-").map(Number);
          const fromDefault = new Date(Date.UTC(year, month - 1, date - 6)).toISOString().slice(0, 10);
          setHistoryFromDay((value) => value || fromDefault);
          setHistoryToDay((value) => value || today);
          setHistoryRange("custom");
          setExpandedDay(null);
        }
      }, "自选"),
      historyRange === "custom" ? React3.createElement(
        "div",
        { className: "dim-jh-ledgerDateRange", key: "dateRange" },
        React3.createElement("label", null, "从", React3.createElement("input", {
          type: "date",
          className: "dim-jh-input",
          value: historyFromDay,
          onChange: (event) => setHistoryFromDay(event.target.value)
        })),
        React3.createElement("label", null, "到", React3.createElement("input", {
          type: "date",
          className: "dim-jh-input",
          value: historyToDay,
          onChange: (event) => setHistoryToDay(event.target.value)
        }))
      ) : null,
      React3.createElement("button", {
        className: "dim-jh-btn dim-jh-ledgerExport",
        disabled: historyPhase !== "ready" || historyDays.length === 0,
        title: "导出当前日期范围的每日汇总 CSV",
        onClick: exportHistory
      }, "导出历史"),
      React3.createElement(
        "span",
        {
          className: "dim-jh-ledgerPerf",
          style: { marginLeft: "auto" },
          title: history?.totals ? tokenSummaryTooltip(history.totals) : void 0
        },
        history !== null && history.totals !== void 0 ? "总处理 " + formatTokenCount2(history.totals.totalTokens) + " · " + (history.totals.requests ?? 0) + " 次" : ""
      )
    );
    const body = invalidHistoryRange ? React3.createElement("div", { className: "dim-jh-empty", key: "histRangeError", role: "alert" }, "起始日期不能晚于结束日期。") : historyPhase === "loading" ? React3.createElement("div", { className: "dim-jh-empty", key: "histLoading" }, "正在读取历史用量…") : historyPhase === "error" ? React3.createElement("div", { className: "dim-jh-empty", key: "histError" }, "历史用量读取失败（不影响明细）。") : historyDays.length === 0 ? React3.createElement(
      "div",
      { className: "dim-jh-empty", key: "histEmpty" },
      "还没有历史用量。请求完成后会立即按 UTC+8 日期累计，历史最多保留 90 天。"
    ) : React3.createElement(
      React3.Fragment,
      { key: "histBody" },
      // GitHub 风格用量格：固定四行，按日期顺序排列，点击可展开当日详情。
      React3.createElement(
        "div",
        { className: "dim-jh-ledgerHeatmapWrap" },
        React3.createElement(
          "div",
          { className: "dim-jh-ledgerHeatmap", role: "group", "aria-label": "每日 Token 用量热力图" },
          heatmapCells.map((cell) => React3.createElement("button", {
            key: cell.day,
            className: "dim-jh-ledgerHeatmapCell",
            type: "button",
            "data-level": String(cell.level),
            "data-today": cell.isToday ? "true" : "false",
            "data-active": expandedDay === cell.day ? "true" : "false",
            title: `${cell.day}
总处理 ${formatTokenCount2(cell.tokens)}
请求 ${cell.requests} 次
${tokenSummaryTooltip(historyDays.find((day) => day.day === cell.day)?.totals)}
点击展开当日明细`,
            "aria-label": `${cell.day}，总处理 ${formatTokenCount2(cell.tokens)}，${cell.requests} 次请求。点击展开`,
            onMouseEnter: () => setHoveredDay(cell.day),
            onMouseLeave: () => setHoveredDay(null),
            onFocus: () => setHoveredDay(cell.day),
            onBlur: () => setHoveredDay(null),
            onClick: () => setExpandedDay((prev) => prev === cell.day ? null : cell.day)
          }))
        )
      ),
      selectedHistoryDay ? React3.createElement(
        "div",
        { className: "dim-jh-ledgerDayPeek" },
        React3.createElement("strong", null, selectedHistoryDay.day),
        React3.createElement("span", null, "总处理 " + formatTokenCount2(selectedHistoryDay.totals?.totalTokens)),
        React3.createElement("span", null, (selectedHistoryDay.totals?.requests ?? 0) + " 次请求"),
        React3.createElement("span", { title: tokenSummaryTooltip(selectedHistoryDay.totals) }, "悬停查看 Token 拆分"),
        React3.createElement("button", {
          className: "dim-jh-btn dim-jh-ledgerDeleteQuick",
          onClick: () => setExpandedDay(selectedHistoryDay.day),
          title: "展开当日详情与删除入口"
        }, "查看 / 删除")
      ) : React3.createElement(
        "div",
        { className: "dim-jh-ledgerChartHint" },
        "悬停查看当日用量，点击日期展开详情"
      ),
      ...expandedDay !== null ? historyDays.filter((d) => d?.day === expandedDay).map((dayRow) => renderDayTree(dayRow)) : []
    );
    return React3.createElement(
      "div",
      { className: "dim-jh-ledgerSection", key: "history" },
      React3.createElement(
        "div",
        { className: "dim-jh-ledgerSectionTitle" },
        historyTitle(historyRange)
      ),
      rangeRow,
      body
    );
  };
  const renderDayTree = (dayRow) => React3.createElement(
    "div",
    { key: "day-" + dayRow.day, className: "dim-jh-ledgerCard" },
    React3.createElement(
      "div",
      { className: "dim-jh-ledgerCardHead" },
      React3.createElement("strong", null, dayRow.day + " · " + (dayRow.totals?.requests ?? 0) + " 次请求"),
      perfCell(dayRow.totals),
      React3.createElement(
        "span",
        { className: "dim-jh-ledgerCardSum", title: tokenSummaryTooltip(dayRow.totals) },
        tokenSummaryText(dayRow.totals)
      ),
      React3.createElement("button", {
        className: "dim-jh-btn",
        "data-kind": "danger",
        disabled: deletingHistoryDay === dayRow.day,
        title: "只删除此日期的历史累计",
        onClick: () => {
          void deleteHistoryDay(dayRow.day);
        }
      }, deletingHistoryDay === dayRow.day ? "删除中…" : "删除此日")
    ),
    historyDeleteError ? React3.createElement("div", { className: "dim-jh-empty", role: "alert" }, historyDeleteError) : null,
    dayRow.channels.map((channelRow) => React3.createElement(
      "div",
      { key: channelRow.channel, className: "dim-jh-ledgerProvider" },
      React3.createElement(
        "div",
        { className: "dim-jh-ledgerProviderHead" },
        React3.createElement("span", { className: "dim-jh-ledgerProviderName" }, channelLabel(channelRow.channel)),
        perfCell(channelRow.totals),
        React3.createElement(
          "span",
          { className: "dim-jh-ledgerProviderSum", title: tokenSummaryTooltip(channelRow.totals) },
          tokenSummaryText(channelRow.totals)
        )
      ),
      channelRow.providers.map((providerRow) => React3.createElement(
        "div",
        {
          key: providerRow.provider,
          className: "dim-jh-ledgerAccount"
        },
        React3.createElement(
          "div",
          { className: "dim-jh-ledgerAccountHead" },
          React3.createElement("span", { className: "dim-jh-ledgerAccountName" }, providerRow.provider),
          perfCell(providerRow.totals),
          React3.createElement(
            "span",
            { className: "dim-jh-ledgerAccountSum", title: tokenSummaryTooltip(providerRow.totals) },
            tokenSummaryText(providerRow.totals)
          )
        ),
        (providerRow.accounts ?? []).length > 1 ? providerRow.accounts.map((accountRow) => React3.createElement(
          "div",
          {
            key: providerRow.provider + "#" + accountRow.accountId,
            className: "dim-jh-ledgerAccount",
            style: { padding: "0 0 0 8px" }
          },
          React3.createElement(
            "div",
            { className: "dim-jh-ledgerAccountHead" },
            React3.createElement(
              "span",
              { className: "dim-jh-ledgerAccountName" },
              accountLabel(accountRow.accountId)
            ),
            React3.createElement(
              "span",
              { className: "dim-jh-ledgerAccountSum", title: tokenSummaryTooltip(accountRow.totals) },
              tokenSummaryText(accountRow.totals)
            )
          ),
          accountRow.models.map((modelRow) => renderModelRow(modelRow, accountRow.accountId + "#" + modelRow.model))
        )) : (providerRow.accounts ?? []).flatMap((accountRow) => accountRow.models.map((modelRow) => renderModelRow(modelRow, providerRow.provider + "#" + modelRow.model)))
      ))
    ))
  );
  return React3.createElement(
    "div",
    {
      className: "dim-jh-modalOverlay",
      onClick: (event) => {
        if (event.target === event.currentTarget) onClose();
      }
    },
    React3.createElement(
      "div",
      {
        role: "dialog",
        "aria-modal": "true",
        "aria-label": "Token 用量",
        className: "dim-jh-modal dim-jh-modal--ledger"
      },
      React3.createElement(
        "div",
        { className: "dim-jh-modalHead" },
        React3.createElement(
          "div",
          { className: "dim-jh-modalTitle" },
          React3.createElement("strong", null, "Token 用量"),
          React3.createElement("span", { className: "dim-jh-modalSubtitle" }, ledgerSubtitle())
        ),
        React3.createElement(
          "div",
          { className: "dim-jh-modelPanelActions" },
          React3.createElement("button", {
            className: "dim-jh-btn",
            disabled: phase === "loading",
            title: "重新读取本机 Token 账本。",
            onClick: () => void load()
          }, phase === "loading" ? "读取中…" : "刷新"),
          React3.createElement("button", {
            className: "dim-jh-btn",
            "data-kind": "primary",
            onClick: onClose
          }, "完成")
        )
      ),
      React3.createElement(
        "p",
        {
          className: "dim-jh-modalHint",
          title: "总处理量 = 输入 + 输出；缓存写入不重复计入。输出速率的均值对离群样本敏感；P50/P90 是完整分布估算。速率要求解码时长至少 100ms。明细最多保留最近 500 笔，重启清空；按日累计写入 token-ledger.json。"
        },
        "按渠道、供应商、账号和模型统计用量。悬停数字查看 Token 拆分与性能口径；逐笔明细重启后清空，按日历史会保留。"
      ),
      React3.createElement(
        "div",
        { className: "dim-jh-modalBody" },
        renderHistory(),
        renderSummary(),
        renderEntries()
      )
    )
  );
}
function formatAccioResetCountdown(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  const totalMinutes = Math.floor(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分`;
  return `${seconds} 秒`;
}
function accioResetSeconds(packages, now) {
  if (!Array.isArray(packages)) return null;
  const daily = packages.find((pkg) => pkg && pkg.name === ACCIO_DAILY_BUCKET);
  if (daily === void 0) return null;
  const end = typeof daily.cycleEndTime === "string" && daily.cycleEndTime.length > 0 ? Date.parse(daily.cycleEndTime) : Number.NaN;
  if (!Number.isFinite(end)) return null;
  const at = typeof now === "number" && Number.isFinite(now) ? now : Date.now();
  return Math.max(0, Math.round((end - at) / 1e3));
}
function ProviderPanel({ provider, rpcCall }) {
  const [accounts, setAccounts] = React3.useState([]);
  const [phase, setPhase] = React3.useState("loading");
  const [error, setError] = React3.useState(null);
  const [creating, setCreating] = React3.useState(false);
  const [compensation, setCompensation] = React3.useState(null);
  const compensationClaimRef = React3.useRef(false);
  const [zcodeProvider, setZcodeProvider] = React3.useState("bigmodel");
  const [accioRegion, setAccioRegion] = React3.useState("cn");
  const [astudioLoginMethod, setAstudioLoginMethod] = React3.useState("local");
  const [autoclawMode, setAutoclawMode] = React3.useState("local");
  const [pendingLogin, setPendingLogin] = React3.useState(void 0);
  const [probeBusy, setProbeBusy] = React3.useState(null);
  const [probeNotice, setProbeNoticeState] = React3.useState(null);
  const setProbeNotice = React3.useCallback((next) => {
    setProbeNoticeState(normalizeProbeNotice(next));
  }, []);
  const [credits, setCredits] = React3.useState({});
  const [creditsLoading, setCreditsLoading] = React3.useState(false);
  const [expiryWindowDays, setExpiryWindowDays] = React3.useState(null);
  const [loginUrlForManual, setLoginUrlForManual] = React3.useState(null);
  const [loginLinkCopied, setLoginLinkCopied] = React3.useState(null);
  const [proxyModal, setProxyModal] = React3.useState(null);
  const [keyEditModal, setKeyEditModal] = React3.useState(null);
  const [keyModal, setKeyModal] = React3.useState(null);
  const keyInputRef = React3.useRef(null);
  const keyEditInputRef = React3.useRef(null);
  const [draggingId, setDraggingId] = React3.useState(null);
  const [dropTargetId, setDropTargetId] = React3.useState(null);
  const [dropPosition, setDropPosition] = React3.useState("before");
  const [reordering, setReordering] = React3.useState(false);
  const [reorderError, setReorderError] = React3.useState(null);
  const mounted = React3.useRef(true);
  const accountsRef = React3.useRef([]);
  const pollRef = React3.useRef(0);
  const claimInFlightRef = React3.useRef(false);
  const loadAccounts = React3.useCallback(async () => {
    setPhase("loading");
    setError(null);
    try {
      const res = await rpcCall("account.list", { provider });
      if (!mounted.current) return;
      const list = res.accounts || [];
      accountsRef.current = list;
      setAccounts(list);
      setPhase("ready");
    } catch (caught) {
      if (!mounted.current) return;
      setError(caught?.message || "无法读取账号列表");
      setPhase("error");
    }
  }, [provider, rpcCall]);
  const reloadAccountsQuietly = React3.useCallback(async () => {
    try {
      const res = await rpcCall("account.list", { provider });
      if (!mounted.current) return;
      const list = res.accounts || [];
      accountsRef.current = list;
      setAccounts(list);
    } catch (caught) {
      console.error("[jet-hub] 静默重读账号列表失败（不影响积分显示）:", caught);
    }
  }, [provider, rpcCall]);
  const canLoadCredits = supportsCreditBalance(provider);
  const accioDialog = provider === "accio";
  const astudioDialog = provider === "astudio";
  const autoclawDialog = provider === "autoclaw" || provider === "autoclawintl";
  const autoclawSmsAvailable = provider === "autoclaw";
  const supportsCredits = supportsDailyCheckin(provider);
  const supportsGrowthTasks = GROWTH_TASK_PROVIDERS.has(provider);
  const canShowSubscriptionQuota = supportsSubscriptionQuota(provider);
  const loadCredits = React3.useCallback(async (force = false) => {
    if (!canLoadCredits) return;
    setCreditsLoading(true);
    try {
      const res = await rpcCall("credits.balances", force ? { provider, force: true } : { provider });
      if (!mounted.current) return;
      const next = {};
      for (const item of res.accounts || []) {
        next[item.accountId] = { balance: item.balance, error: item.error, extra: item.extra };
      }
      setCredits(next);
      setExpiryWindowDays(res?.windowDays ?? null);
      await reloadAccountsQuietly();
    } catch (caught) {
      console.error("[jet-hub] load credits failed:", caught);
      if (!mounted.current) return;
      const snapshot = accountsRef.current;
      setCredits((prev) => {
        const next = { ...prev };
        for (const account of snapshot) {
          next[account.id] = { balance: null, error: caught?.message || "积分查询失败" };
        }
        return next;
      });
    } finally {
      if (mounted.current) setCreditsLoading(false);
    }
  }, [provider, rpcCall, canLoadCredits, reloadAccountsQuietly]);
  const loadCompensation = React3.useCallback(async () => {
    if (provider !== "buddy") return;
    try {
      const list = await rpcCall("account.list", { provider });
      const entries = Array.isArray(list?.accounts) ? list.accounts : [];
      const scan = await scanCompensation(
        entries,
        (accountId) => rpcCall("buddy.compensationStatus", { provider, accountId })
      );
      if (!mounted.current) return;
      setCompensation({ ...toCompensationState(scan), busy: false });
    } catch (caught) {
      console.error("[jet-hub] compensation status failed:", caught);
      if (!mounted.current) return;
      setCompensation({
        scanned: 0,
        claimableCount: 0,
        claimedCount: 0,
        total: 0,
        endTime: null,
        busy: false,
        errorCount: 0,
        error: caught && caught.message || "未知错误"
      });
    }
  }, [provider, rpcCall]);
  const claimCompensation = async () => {
    if (provider !== "buddy" || compensation === null || compensationClaimRef.current === true) return;
    compensationClaimRef.current = true;
    setCompensation((prev) => prev === null ? prev : { ...prev, busy: true });
    try {
      const list = await rpcCall("account.list", { provider });
      const entries = Array.isArray(list?.accounts) ? list.accounts : [];
      const { claimed, failures } = await claimAllCompensation(
        entries,
        (accountId) => rpcCall("buddy.compensationStatus", { provider, accountId }),
        (accountId) => rpcCall("buddy.claimCompensation", { provider, accountId })
      );
      await loadAccounts();
      await loadCompensation();
      if (failures.length > 0) {
        setProbeNotice({ tone: "warn", text: `部分账号领取失败（${failures.length} 个）`, details: failures });
      } else if (claimed.length > 0) {
        setProbeNotice({ tone: "ok", text: `已为 ${claimed.length} 个账号领取补偿积分。`, details: [] });
      }
    } catch (caught) {
      console.error("[jet-hub] compensation claim failed:", caught);
      if (mounted.current) {
        setProbeNotice({ tone: "error", text: `领取失败：${caught && caught.message || "未知错误"}`, details: [] });
      }
    } finally {
      compensationClaimRef.current = false;
      if (mounted.current) setCompensation((prev) => prev === null ? prev : { ...prev, busy: false });
    }
  };
  React3.useEffect(() => {
    mounted.current = true;
    void loadAccounts();
    void loadCompensation();
    if (canLoadCredits) void loadCredits();
    return () => {
      mounted.current = false;
      if (pollRef.current !== 0) {
        clearInterval(pollRef.current);
        pollRef.current = 0;
      }
      claimInFlightRef.current = false;
      compensationClaimRef.current = false;
    };
  }, [provider]);
  const [claiming, setClaiming] = React3.useState(false);
  const [claimNotice, setClaimNotice] = React3.useState(null);
  const [onboarding, setOnboarding] = React3.useState(null);
  const [onboardingLoading, setOnboardingLoading] = React3.useState(false);
  const [onboardingNotice, setOnboardingNotice] = React3.useState(null);
  const canClaimOnboarding = supportsOnboardingTasks(provider);
  const canLockPermanent = supportsPermanentLock(provider);
  const lockCopy = permanentLockCopy(provider, expiryWindowDays);
  const [permanentLocked, setPermanentLocked] = React3.useState(false);
  const [lockBusy, setLockBusy] = React3.useState(false);
  const [lockNotice, setLockNotice] = React3.useState(null);
  React3.useEffect(() => {
    if (!canLockPermanent) return void 0;
    let alive = true;
    void (async () => {
      try {
        const res = await rpcCall("credits.permanentLock", { provider });
        if (!alive) return;
        setPermanentLocked(res?.locked === true);
        setExpiryWindowDays(res?.windowDays ?? null);
      } catch (caught) {
        console.error("[jet-hub] load permanent lock failed:", caught);
      }
    })();
    return () => {
      alive = false;
    };
  }, [canLockPermanent, provider]);
  React3.useEffect(() => {
    if (provider !== "minimaxintl") return void 0;
    let alive = true;
    void (async () => {
      try {
        const res = await rpcCall("minimax.getXff", {});
        if (!alive) return;
        setMinimaxXff(typeof res?.xff === "string" ? res.xff : "");
      } catch (caught) {
        console.error("[jet-hub] load minimax xff failed:", caught);
      }
    })();
    return () => {
      alive = false;
    };
  }, [provider]);
  const togglePermanentLock = async () => {
    if (!canLockPermanent) return;
    const next = !permanentLocked;
    setLockBusy(true);
    setLockNotice(null);
    try {
      const res = await rpcCall("credits.permanentLock", { provider, locked: next });
      if (!mounted.current) return;
      setPermanentLocked(res?.locked === true);
      setExpiryWindowDays(res?.windowDays ?? null);
      setLockNotice({
        tone: "ok",
        text: next ? lockCopy.lockedNotice : lockCopy.unlockedNotice
      });
    } catch (caught) {
      console.error("[jet-hub] toggle permanent lock failed:", caught);
      if (!mounted.current) return;
      setLockNotice({ tone: "error", text: `操作失败：${caught?.message || "未知错误"}` });
    } finally {
      if (mounted.current) setLockBusy(false);
    }
  };
  const claimOnboarding = async (accountId) => {
    if (!canClaimOnboarding) return;
    setOnboardingLoading(true);
    setOnboardingNotice(null);
    try {
      const res = await rpcCall("onboarding.claim", { provider, accountId });
      const parts = [];
      if (res.claimed.length > 0) {
        const gained = res.claimed.reduce((sum, item) => sum + item.points, 0);
        parts.push(`本次领取 ${res.claimed.length} 个任务（+${gained} 积分）`);
      }
      if (res.skipped.length > 0) parts.push(`${res.skipped.length} 个此前已完成`);
      setOnboardingNotice({
        tone: "ok",
        text: parts.length > 0 ? parts.join("，") : "没有可领取的任务",
        details: [
          `累计已领 ${res.earned} / ${res.total}`,
          ...res.claimed.map((item) => `${item.title} +${item.points}`)
        ]
      });
      setOnboarding({ earned: res.earned, total: res.total, skipped: res.skipped });
      if (canLoadCredits) await loadCredits(true);
    } catch (caught) {
      setOnboardingNotice({ tone: "error", text: caught?.message || "领取新手任务失败" });
    } finally {
      if (mounted.current) setOnboardingLoading(false);
    }
  };
  const [showModels, setShowModels] = React3.useState(false);
  const [showQuota, setShowQuota] = React3.useState(false);
  const [minimaxXff, setMinimaxXff] = React3.useState("");
  const [showMinimaxXff, setShowMinimaxXff] = React3.useState(false);
  const claimCredits = async () => {
    if (!supportsCredits) return;
    if (claimInFlightRef.current) {
      setClaimNotice({
        tone: "warn",
        text: "上一次领取仍在进行中（成长任务一轮可能数分钟），请等它结束。",
        details: []
      });
      return;
    }
    claimInFlightRef.current = true;
    setClaiming(true);
    setClaimNotice(null);
    try {
      const res = await rpcCall("credits.claimAll", {
        provider,
        runTasks: supportsGrowthTasks
      });
      const { summary, results, growth } = res;
      const parts = [];
      if (summary.claimed > 0) parts.push(`${summary.claimed} 个账号领取成功`);
      if (summary.alreadyClaimed > 0) parts.push(`${summary.alreadyClaimed} 个今日已领取`);
      if (summary.inactive > 0) parts.push(`${summary.inactive} 个活动未开启`);
      if (summary.failed > 0) parts.push(`${summary.failed} 个失败`);
      if (!mounted.current) return;
      const details = [];
      for (const item of results || []) {
        const outcome = item.outcome || {};
        if (outcome.kind === "claimed") {
          const unit = outcome.unit === "token" ? "token" : "credit";
          details.push(
            `${item.nickname || item.accountId}：领取成功 +${formatUnits(outcome.credit, unit)}${unitLabel(unit)}`
          );
        } else if (outcome.kind === "already-claimed") {
          details.push(`${item.nickname || item.accountId}：${outcome.message || "今天已领取"}`);
        } else if (outcome.kind === "inactive") {
          details.push(`${item.nickname || item.accountId}：${outcome.message || "不在活动范围"}`);
        } else if (outcome.kind === "failed") {
          details.push(`${item.nickname || item.accountId}：失败 — ${outcome.message || "未知原因"}`);
        }
      }
      let growthFailed = 0;
      let growthTimedOut = false;
      if (Array.isArray(growth) && growth.length > 0) {
        let completed = 0;
        let clientOnly = 0;
        let claimedCount = 0;
        let claimedCredit = 0;
        for (const account of growth) {
          const who = account.nickname || account.accountId;
          completed += account.completed || 0;
          clientOnly += account.clientOnly || 0;
          growthFailed += account.failed || 0;
          claimedCount += account.claimedCount || 0;
          claimedCredit += account.claimedCredit || 0;
          if (account.timedOut) growthTimedOut = true;
          if (account.error) {
            details.push(`${who}：${account.error}`);
            continue;
          }
          const tasks = account.tasks || [];
          const settled = tasks.filter((t) => t.ok && !t.clientOnly);
          const broken = tasks.filter((t) => !t.ok);
          const needClient = tasks.filter((t) => t.ok && t.clientOnly);
          if (settled.length === 0 && broken.length === 0) {
            const why = needClient.length > 0 ? `${needClient.length} 项判据只在客户端行为里记录，API 推不动` : "本轮无 API 可达的任务";
            details.push(`${who}：${why}（未领到积分）`);
            continue;
          }
          const head = [
            settled.length > 0 ? `完成 ${settled.length} 项` : null,
            broken.length > 0 ? `失败 ${broken.length} 项` : null,
            needClient.length > 0 ? `需客户端 ${needClient.length} 项` : null
          ].filter(Boolean).join("，");
          details.push(`${who}：${head}`);
          for (const task of settled.concat(broken)) {
            const label = task.taskCode || "未知任务";
            const reason = task.message || "";
            if (!task.ok) details.push(`　· ${label}：失败 — ${reason}`);
            else details.push(`　· ${label}：${reason}`);
          }
        }
        if (completed > 0) parts.push(`成长完成 ${completed} 项`);
        if (clientOnly > 0) parts.push(`成长需客户端 ${clientOnly} 项`);
        if (growthFailed > 0) parts.push(`成长失败 ${growthFailed} 项`);
        if (claimedCount > 0) parts.push(`自动领取 ${claimedCount} 项（+${claimedCredit} 积分）`);
        if (growthTimedOut) parts.push("本轮时间预算用尽，剩余项未执行，再点一次即可继续");
      }
      setClaimNotice({
        tone: summary.failed > 0 || growthFailed > 0 ? "warn" : "ok",
        text: parts.length > 0 ? parts.join("，") : "没有可领取的账号",
        details
      });
      await loadAccounts();
      await loadCredits(true);
    } catch (caught) {
      console.error("[jet-hub] claim credits failed:", caught);
      if (!mounted.current) return;
      setClaimNotice({ tone: "error", text: caught?.message || "领取积分失败" });
    } finally {
      claimInFlightRef.current = false;
      if (mounted.current) setClaiming(false);
    }
  };
  const stopPoll = () => {
    if (pollRef.current !== 0) {
      clearInterval(pollRef.current);
      pollRef.current = 0;
    }
    if (mounted.current) setCreating(false);
  };
  const submitOpencodeKey = async (rawKey) => {
    const key = String(rawKey == null ? "" : rawKey).trim();
    if (key === "") return;
    await submitOpencodeEntry("opencode.addAccount", { apiKey: key });
  };
  const submitAnonymous = async () => {
    await submitOpencodeEntry("opencode.addAnonymous", {});
  };
  const submitModelscopeKey = async (rawKey) => {
    const key = String(rawKey == null ? "" : rawKey).trim();
    if (key === "") return;
    await submitOpencodeEntry("modelscope.addAccount", { apiKey: key });
  };
  const submitModelscopeKeyEdit = async (rawKey) => {
    const key = String(rawKey == null ? "" : rawKey).trim();
    if (key === "") return;
    const accountId = keyEditModal?.accountId;
    if (!accountId) return;
    setCreating(true);
    try {
      const res = await rpcCall("modelscope.setApiKey", { accountId, apiKey: key });
      setKeyEditModal(null);
      await loadAccounts();
      setProbeNotice({
        tone: "ok",
        text: res?.renamed ? "已更新访问令牌。该账号的标识随 Key 尾段一并更新（昵称与停用状态已保留）。" : "已更新访问令牌。",
        details: []
      });
    } catch (caught) {
      setKeyEditModal((prev) => prev ? { ...prev, error: caught?.message ? caught.message : "未知错误" } : prev);
    } finally {
      setCreating(false);
    }
  };
  const submitOpencodeEntry = async (method, payload) => {
    setCreating(true);
    setError(null);
    try {
      const res = await rpcCall(method, payload);
      setKeyModal(null);
      await loadAccounts();
      if (res && res.existed) {
        setProbeNotice({
          tone: "ok",
          text: "该 key 已存在，已为你定位到原有账号。",
          details: []
        });
      }
    } catch (caught) {
      setKeyModal({ error: caught && caught.message ? caught.message : "未知错误" });
    } finally {
      setCreating(false);
    }
  };
  const createAccount = async () => {
    if (pollRef.current !== 0) {
      setProbeNotice({ tone: "warn", text: "上一次登录仍在进行中，请先完成或等待它结束。", details: [] });
      return;
    }
    if (provider === "opencode") {
      setKeyModal({ provider, error: "" });
      return;
    }
    if (provider === "modelscope") {
      setKeyModal({ provider, error: "" });
      return;
    }
    setCreating(true);
    let accountId = "";
    let loginUrl = "";
    try {
      const res = await rpcCall(
        "account.create",
        // ⚠ 两个 provider 各占一个位置参数（astudio 第 4 位、autoclaw 第 5 位），
        //    不可合并成一个 —— 载荷字段不同，合并会静默串台（见 new-account.js）。
        buildCreateAccountPayload(provider, zcodeProvider, accioRegion, astudioLoginMethod, autoclawMode)
      );
      accountId = res.accountId;
      loginUrl = res.loginUrl;
      console.log("[jet-hub] account.create ok, provider =", provider, ", accountId =", accountId);
      if (res.reused) {
        setLoginUrlForManual(null);
        await loadAccounts();
        setProbeNotice({ tone: "ok", text: "已复用本机已有的账号凭据，未新建账号。", details: [] });
        return;
      }
      if (!loginUrl) {
        await loadAccounts();
        setProbeNotice({ tone: "ok", text: "已成功导入账号凭据。", details: [] });
        return;
      }
      if (loginUrl) {
        let loginWindow = null;
        let skipClientOpen = false;
        if (res.incognitoOpened === true) {
          console.log("[jet-hub] 宿主也以无痕窗口打开过授权页");
          const canConfirm = typeof window !== "undefined" && typeof window.confirm === "function";
          const confirmed = canConfirm ? window.confirm(
            "宿主已在**无痕窗口**中打开授权页（推荐在那个窗口里完成 —— 它能强制换号）。\n\n如果你看不到那个窗口（无头 / 远程部署），可以在**本机浏览器**再开一个；\n但若你已经登录过同一家服务，那个窗口可能**直接复用旧账号**，\n导致「新建的账号其实还是老账号」。\n\n要在本机浏览器再打开一个吗？"
          ) : true;
          skipClientOpen = !confirmed;
        }
        if (!skipClientOpen) {
          const forcedLoginUrl = typeof res.forcedLoginUrl === "string" && res.forcedLoginUrl.length > 0 ? res.forcedLoginUrl : "";
          if (forcedLoginUrl !== "") {
            const logoutUrl = typeof res.logoutUrl === "string" && res.logoutUrl.length > 0 ? res.logoutUrl : "";
            if (logoutUrl !== "") {
              const okToLogout = confirm(
                "为了不再带上一个账号的登录态，将先退出 MiniMax 网页登录（含你在本浏览器里的 MiniMax 网页版会话），然后打开授权页让你重新登录。\n\n继续吗？（取消 = 不清会话，直接打开授权页）"
              );
              if (okToLogout) {
                try {
                  window.open(logoutUrl, "_blank", "width=800,height=600");
                } catch {
                }
                await new Promise((r) => setTimeout(r, 900));
              }
            }
            loginWindow = window.open(forcedLoginUrl, "_blank", "width=800,height=600");
            if (!loginWindow || loginWindow.closed) {
              setLoginUrlForManual(forcedLoginUrl);
              setLoginLinkCopied(null);
            }
          } else {
            loginWindow = window.open(loginUrl, "_blank", "width=800,height=600");
            if (!loginWindow || loginWindow.closed) {
              setLoginUrlForManual(loginUrl);
              setLoginLinkCopied(null);
            }
          }
        }
        const deadline = Date.now() + 3e5;
        let lastPollError = null;
        let pollErrorCount = 0;
        pollRef.current = setInterval(async () => {
          if (!mounted.current) {
            stopPoll();
            return;
          }
          if (Date.now() > deadline) {
            if (loginWindow && !loginWindow.closed) loginWindow.close();
            setLoginUrlForManual(null);
            setError("登录超时或未完成（已等待 5 分钟）：可能是授权未完成、授权被拒，或账号条目已被删除。请重新点击「+ 新建账号」再试一次；若账号其实已经添加，可点「重新读取」查看。" + (pollErrorCount > 0 ? `（期间有 ${pollErrorCount} 次轮询请求本身失败，最后一次：${lastPollError}）` : ""));
            setPhase("error");
            stopPoll();
            return;
          }
          try {
            const pollRes = await rpcCall("login.poll", { accountId, provider });
            if (!mounted.current) return;
            if (pollRes?.success === false) {
              if (loginWindow && !loginWindow.closed) loginWindow.close();
              setLoginUrlForManual(null);
              setError(pollRes.error || "登录失败（宿主未给出原因），请重新点击「+ 新建账号」。");
              setPhase("error");
              stopPoll();
              return;
            }
            if (!pollRes?.done) return;
            if (loginWindow && !loginWindow.closed) loginWindow.close();
            setLoginUrlForManual(null);
            await loadAccounts();
            stopPoll();
          } catch (caught) {
            pollErrorCount += 1;
            lastPollError = caught && caught.message ? caught.message : String(caught);
          }
        }, 1e3);
      } else {
        setError("后端未返回登录地址（loginUrl 为空）。");
        setPhase("error");
      }
    } catch (caught) {
      console.error("[jet-hub] create account failed:", caught);
      setError("新建账号失败：" + (caught?.message || "未知错误"));
      setPhase("error");
    } finally {
      if (pollRef.current === 0) setCreating(false);
    }
  };
  const toggleAccount = async (accountId, enabled) => {
    try {
      const isLastEnabled = !enabled && disablingLeavesNoEnabledAccount(accountsRef.current, accountId, provider);
      const isFirstEnabled = enabled && !accountsRef.current.some((a) => a.provider === provider && a.id !== accountId && a.enabled !== false);
      await rpcCall("account.update", { accountId, patch: { enabled } });
      await loadAccounts();
      if (isLastEnabled) {
        const closeModels = confirm(
          `该 Provider 已没有启用账号，它的模型不会再被使用。

是否同时关闭它的全部模型（从对话框的模型选择里移除）？
选择「取消」则只停用账号，模型保持现状。`
        );
        if (closeModels) {
          try {
            await rpcCall("model.setAllDisabled", { provider, disabled: true });
          } catch (caught) {
            console.error("[jet-hub] cascade disable models failed:", caught);
            if (mounted.current) {
              setProbeNotice({
                tone: "warn",
                text: `账号已停用，但关闭模型失败：${caught?.message || "未知错误"}。可在「模型列表」中手动关闭。`,
                details: []
              });
            }
          }
        }
        return;
      }
      if (isFirstEnabled) {
        let models;
        try {
          const res = await rpcCall("model.list", { provider });
          models = res.models || [];
        } catch (caught) {
          console.error("[jet-hub] read models for cascade enable failed:", caught);
          models = null;
        }
        if (models !== null && allModelsDisabled(models)) {
          const openModels = confirm(
            `该 Provider 的 ${models.length} 个模型当前全部处于关闭状态。

是否同时打开它们（让模型重新出现在对话框的模型选择里）？`
          );
          if (openModels) {
            try {
              await rpcCall("model.setAllDisabled", { provider, disabled: false });
            } catch (caught) {
              console.error("[jet-hub] cascade enable models failed:", caught);
              if (mounted.current) {
                setProbeNotice({
                  tone: "warn",
                  text: `账号已启用，但打开模型失败：${caught?.message || "未知错误"}。可在「模型列表」中手动打开。`,
                  details: []
                });
              }
            }
          }
        }
      }
    } catch (caught) {
      console.error("[jet-hub] toggle failed:", caught);
    }
  };
  const deleteAccount = async (accountId) => {
    if (!confirm("确认删除此账号？关联的凭据也将被清除。")) return;
    try {
      await rpcCall("account.delete", { accountId });
      await loadAccounts();
    } catch (caught) {
      console.error("[jet-hub] delete failed:", caught);
    }
  };
  const rotateFingerprint = async (accountId) => {
    if (!confirm("轮换该账号的指纹？将生成新的 project id（用于与其他账号区分）。")) return;
    try {
      await rpcCall("opencode.rotateFingerprint", { accountId });
      await loadAccounts();
    } catch (caught) {
      alert("轮换失败：" + (caught?.message || String(caught)));
    }
  };
  const commitOrder = async (orderedIds) => {
    const snapshot = accountsRef.current;
    const byId = new Map(snapshot.map((a) => [a.id, a]));
    const next = orderedIds.map((id) => byId.get(id)).filter(Boolean);
    if (next.length !== snapshot.length) return;
    accountsRef.current = next;
    setAccounts(next);
    setReordering(true);
    setReorderError(null);
    try {
      await rpcCall("account.reorder", { provider, orderedIds });
    } catch (caught) {
      console.error("[jet-hub] reorder failed:", caught);
      if (!mounted.current) return;
      accountsRef.current = snapshot;
      setAccounts(snapshot);
      setReorderError(caught?.message || "顺序保存失败");
    } finally {
      if (mounted.current) setReordering(false);
    }
  };
  const computeDropOrder = (sourceId, targetId, position) => orderAfterDrop(accountsRef.current.map((a) => a.id), sourceId, targetId, position);
  const dragPropsFor = (account, index) => {
    if (accounts.length < 2) return { enabled: false };
    return {
      enabled: true,
      order: index,
      isDragging: draggingId === account.id,
      isDropTarget: dropTargetId === account.id && draggingId !== null && draggingId !== account.id,
      dropPosition,
      onDragStart: (event) => {
        setDraggingId(account.id);
        setReorderError(null);
        try {
          event.dataTransfer.setData("text/plain", account.id);
        } catch {
        }
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      },
      onDragEnd: () => {
        setDraggingId(null);
        setDropTargetId(null);
      },
      onDragOver: (event) => {
        if (draggingId === null || draggingId === account.id) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        if (dropTargetId !== account.id) setDropTargetId(account.id);
        const rect = event.currentTarget?.getBoundingClientRect?.();
        const next = dropPositionFromPointer(event.clientY, rect);
        if (next !== dropPosition) setDropPosition(next);
      },
      onDrop: (event) => {
        event.preventDefault();
        const sourceId = draggingId;
        setDraggingId(null);
        setDropTargetId(null);
        if (sourceId === null || sourceId === account.id) return;
        const next = computeDropOrder(sourceId, account.id, dropPosition);
        if (next !== null) void commitOrder(next);
      }
    };
  };
  const runLimitAction = async (kind, accountId) => {
    if (kind === "retestAll" && !confirm("将对本页全部账号（含已停用）各发送一条真实消息来验证限流状态，会消耗模型额度。继续？")) {
      return;
    }
    setProbeBusy(kind === "retestAll" || kind === "resetAll" ? "all" : "one");
    setProbeNotice(null);
    try {
      let res;
      if (kind === "retest") res = await rpcCall("account.retest", { accountId });
      else if (kind === "retestAll") res = await rpcCall("account.retestAll", { provider });
      else if (kind === "reset") res = await rpcCall("account.reset", { accountId });
      else res = await rpcCall("account.resetAll", { provider });
      if (!mounted.current) return;
      const details = (res?.accounts || []).flatMap((a) => (a.stillLimited || []).map((m) => `${a.nickname || a.accountId} · ${m.modelId}：${m.message || "仍受限"}`));
      const summary = summarizeProbe(kind, res);
      setProbeNotice({ tone: details.length > 0 ? "warn" : "ok", text: summary, details });
      await loadAccounts();
    } catch (caught) {
      console.error("[jet-hub] limit action failed:", caught);
      if (!mounted.current) return;
      setProbeNotice({ tone: "error", text: `操作失败：${caught?.message || "未知错误"}`, details: [] });
    } finally {
      if (mounted.current) setProbeBusy(null);
    }
  };
  const runTestAction = async (accountId) => {
    setProbeBusy("one");
    setProbeNotice(null);
    try {
      const res = await rpcCall("account.test", { accountId });
      if (!mounted.current) return;
      const text = summarizeTest(res);
      const details = res && res.ok === false && res.message ? [`${res.nickname || res.accountId} · ${res.modelId || "未知模型"}：${res.message}`] : [];
      setProbeNotice({ tone: res?.ok ? "ok" : "warn", text, details });
      await loadAccounts();
    } catch (caught) {
      console.error("[jet-hub] account test failed:", caught);
      if (!mounted.current) return;
      setProbeNotice({ tone: "error", text: `测试失败：${caught?.message || "未知错误"}`, details: [] });
    } finally {
      if (mounted.current) setProbeBusy(null);
    }
  };
  const compensationCard = provider === "buddy" && shouldShowCompensation(compensation) ? React3.createElement(
    "div",
    {
      className: "dim-jh-probeNotice",
      "data-tone": compensation.error ? "warn" : compensation.total > 0 ? "ok" : "idle"
    },
    React3.createElement("div", null, compensationHeadline(compensation)),
    // 副文案可能为空串（已领完那条分支已不再印说明）⇒ 空时不挂空 div，
    // 否则 .dim-jh-hint 的 margin 会凭空多出一截间距。
    compensationHint(compensation).length > 0 ? React3.createElement("div", { className: "dim-jh-hint" }, compensationHint(compensation)) : null,
    compensation.total > 0 ? React3.createElement("button", {
      className: "dim-jh-btn",
      type: "button",
      disabled: compensation.busy === true,
      title: "逐个账号调用补偿领取端点。这是**一次性写操作**（每账号只能领一次），故只在你点了这个按钮时才发起，不会随每日签到自动执行。",
      onClick: () => void claimCompensation()
    }, compensation.busy === true ? "领取中…" : "立即领取") : null
  ) : null;
  return React3.createElement(
    "section",
    {
      className: "dim-jh-accountSection",
      "aria-label": `${provider} 账号管理`
    },
    // ⚠️ 2026-10-26 用户要求「将按钮行合并到文案行最右侧」：原先标题 / 按钮组 /
    //    排序提示是三行，按钮组独占一行很浪费。现在改成：
    //      第一行：标题（flex-basis: 100% 独占）
    //      第二行：[排序提示 ………………… 按钮组]（提示 flex:1 撑开，按钮组 margin-left:auto 贴右）
    //    ⇒ **排序提示必须从 `.dim-jh-accountList` 挪到本容器**，否则它和按钮组
    //    不同父级，CSS 无论如何排不到同一行（这是本次改动的关键，不是样式微调）。
    //    ⚠️ 提示为 null（账号 ≤ 1）时按钮组仍靠右：margin-left: auto 与
    //    justify-content: flex-end 两条都留着，任一条都能把它推到右边。
    React3.createElement(
      "div",
      { className: "dim-jh-panelHead" },
      React3.createElement(
        "h2",
        { className: "dim-jh-panelTitle" },
        `${PROVIDERS.find((p) => p.id === provider)?.label || provider} 账号管理`
      ),
      // ⚠️ 2026-10-26 用户要求「信息应该在按钮行上方行，而不是下方行」：
      //    面板级状态提示（探测结果 / 锁定状态 / 领取结果 / 新手任务 / 登录链接 /
      //    补偿卡片）此前是 section 的直接子节点，排在 panelHead **之后** ⇒
      //    视觉上落在按钮行下方（截图里那条「已锁定永久积分…」就是）。
      //    现在全部搬进 panelHead、**排在按钮组之前**，于是页头变成：
      //      第一行 标题 → 第二行起 各条状态提示 → 最后一行 [排序提示 …… 按钮组]
      //    ⚠️ 每个提示都必须独占整行（样式侧 `.dim-jh-panelHead > .dim-jh-probeNotice
      //    { flex: 1 0 100% }`）—— 少那条规则，提示会与按钮组挤在同一行，
      //    又变回「挤在按钮旁边」的老毛病。
      //    ⚠️ 它们仍必须是 panelHead 的**直接**子节点：包一层容器会让
      //    `.dim-jh-panelHead > ...` 那组选择器全部失效。
      probeNotice ? React3.createElement(
        "div",
        {
          className: "dim-jh-probeNotice",
          "data-tone": probeNotice.tone,
          role: "status"
        },
        React3.createElement("div", null, probeNotice.text),
        // ⚠️ 不能直接读 `probeNotice.details.length`：`probeNotice` 若被写成裸
        //    字符串（2026-10-22 整页白屏事故），`.details` 是 undefined ⇒ 抛
        //    TypeError ⇒ 整个 Jet Hub 设置页被 React 卸载。这里按「无明细」
        //    降级：宁可少一行明细，也不能让整页消失。
        safeNoticeDetails(probeNotice.details).length > 0 ? React3.createElement(
          "ul",
          { className: "dim-jh-probeDetails" },
          safeNoticeDetails(probeNotice.details).map((d, i) => React3.createElement("li", { key: i }, d))
        ) : null
      ) : null,
      lockNotice ? React3.createElement("div", {
        className: "dim-jh-probeNotice",
        "data-tone": lockNotice.tone,
        role: lockNotice.tone === "error" ? "alert" : "status"
      }, lockNotice.text) : null,
      claimNotice ? React3.createElement(
        "div",
        {
          className: "dim-jh-probeNotice",
          "data-tone": claimNotice.tone,
          role: claimNotice.tone === "error" ? "alert" : "status"
        },
        React3.createElement("div", null, claimNotice.text),
        // 逐账号原因列表。没有它时用户只看到「1 个失败」，无从判断是
        // 凭据问题、活动未开、还是解析 bug。
        (claimNotice.details || []).length > 0 ? React3.createElement(
          "ul",
          { className: "dim-jh-probeDetails" },
          claimNotice.details.map((d, i) => React3.createElement("li", { key: i }, d))
        ) : null
      ) : null,
      // 新手任务结果（仅 Loomy，一次性领取）。
      onboardingNotice ? React3.createElement(
        "div",
        {
          className: "dim-jh-probeNotice",
          "data-tone": onboardingNotice.tone,
          role: onboardingNotice.tone === "error" ? "alert" : "status"
        },
        React3.createElement("div", null, onboardingNotice.text),
        (onboardingNotice.details || []).length > 0 ? React3.createElement(
          "ul",
          { className: "dim-jh-probeDetails" },
          onboardingNotice.details.map((line, index) => React3.createElement("li", { key: index }, line))
        ) : null
      ) : null,
      // 弹窗被拦截：给出可点击的登录链接 + 复制按钮。不劫持当前页面（见 createAccount 的说明）。
      // 链接 300+ 字符，用户此刻唯一动作就是复制到别处；手工框选漏一个字符会得到「授权失败」假象。
      loginUrlForManual ? React3.createElement(
        "div",
        {
          className: "dim-jh-probeNotice",
          "data-tone": "warn",
          role: "alert"
        },
        React3.createElement("div", null, "登录窗口被浏览器拦截，请手动打开下方链接完成登录："),
        React3.createElement(
          "div",
          {
            className: "dim-jh-loginLinkRow",
            "data-copy-state": loginLinkCopied === false ? "failed" : "idle"
          },
          React3.createElement("a", {
            className: "dim-jh-loginLink",
            href: loginUrlForManual,
            target: "_blank",
            rel: "noopener noreferrer"
          }, loginUrlForManual),
          // type='button' 必须有：按钮若落在表单里，默认 submit 会连带提交表单。
          React3.createElement("button", {
            className: "dim-jh-btn",
            type: "button",
            title: loginLinkCopied === false ? "复制失败：请手动选中链接后按 Ctrl+C" : "复制授权链接",
            onClick: async () => setLoginLinkCopied(await copyToClipboard(loginUrlForManual))
          }, loginLinkCopied === true ? "已复制 ✓" : loginLinkCopied === false ? "复制失败，请手动选中" : "复制链接")
        )
      ) : null,
      compensationCard,
      // 排序提示：顺序会真实影响自动选号，必须让用户知道，否则
      // 「拖了有什么用」无从得知。仅两个以上账号时才显示。
      // ⚠️ 2026-10-26 用户定稿文案（第二次改）：两句，保留**两个不可省的语义**：
      //    ① 顺序 = 优先级（拖动不是装饰）；② 命中限额会沉到末尾且不复位 ——
      //    连同「为什么这样设计」（免得一个号长期占位、把别人的额度放过期）。
      // ⚠️ 文案必须**单行显示**（用户同日「文案改为一行显示」）：样式侧用
      //    white-space: nowrap 钉死，故窄窗口下会被省略号截断 ⇒ 必须把
      //    完整文案挂到 title 上，否则被截掉的那半句就再也读不到。
      accounts.length > 1 ? React3.createElement("p", {
        className: "dim-jh-orderHint",
        title: ORDER_HINT_TEXT
      }, ORDER_HINT_TEXT) : null,
      React3.createElement(
        "div",
        { className: "dim-jh-headerActions" },
        // 「订阅额度」放在**面板级**（而不是账号卡片的按钮行）：
        // 那一行已有 5 个按钮且 `flex-wrap: nowrap`，再塞一个必然溢出
        // （该行的注释里记着「领取新手任务」当时就是这么被挤出去的）。
        // 且额度是**跨账号**的读数，放在面板级与它的语义一致。
        canShowSubscriptionQuota ? React3.createElement("button", {
          className: "dim-jh-btn",
          title: "查看 Cline 官方订阅额度窗口（5 小时 / 周 / 月各用掉百分之几）与逐笔请求记录（模型、token、积分）。数据来自官方网关，非本地记账。",
          onClick: () => setShowQuota(true)
        }, "订阅额度") : null,
        supportsCredits ? React3.createElement("button", {
          className: "dim-jh-btn",
          title: supportsGrowthTasks ? `领取全部 ${PROVIDERS.find((p) => p.id === provider)?.label || provider} 账号（含已停用）的每日签到积分，**并完成成长中心任务**。成长一轮单账号实测 90～270s 且全串行，账号多时可能需多点几次；受客户端动作限制的项（微信、夜猫子窗口、判据推不动）会如实标为「需客户端」。` : `领取全部 ${PROVIDERS.find((p) => p.id === provider)?.label || provider} 账号（含已停用）的每日签到积分`,
          disabled: claiming || accounts.length === 0,
          onClick: () => void claimCredits()
        }, claiming ? "领取中…" : supportsGrowthTasks ? "一键领取积分 + 成长任务" : "一键领取积分") : null,
        // 「重测 / 重置」只对**会返回限流错误**的 provider 有意义。
        // ⚠️ Loomy 不会限流（积分耗尽时静默降级为扣永久积分），故对它
        // 隐藏这两个按钮 —— 重测永远测不出限流、重置也没有标记可清，
        // 而重测还会白烧积分（用户报障：「这个 provider 好像没发现模型限流，
        // 把重置所有按钮删掉」）。
        supportsRateLimit(provider) ? React3.createElement("button", {
          className: "dim-jh-btn",
          title: RETEST_ALL_HELP,
          disabled: probeBusy !== null || accounts.length === 0,
          onClick: () => void runLimitAction("retestAll")
        }, probeBusy === "all" ? "重测中…" : "重测所有") : null,
        supportsRateLimit(provider) ? React3.createElement("button", {
          className: "dim-jh-btn",
          title: RESET_ALL_HELP,
          disabled: probeBusy !== null || accounts.length === 0,
          onClick: () => void runLimitAction("resetAll")
        }, "重置所有") : null,
        // 锁定永久积分：只消耗会近期作废的积分，保住长期积分。
        // 文案按 provider 给（Loomy 是「每日赠送额度」，两个 buddy 是
        // 「15 天内到期的积分包」）—— 见 permanentLockCopy 的说明。
        //
        // ⚠️ 2026-10-26 用户要求「解锁/锁定永久积分改为图标+永久积分」：
        //    按钮文字**固定**为「永久积分」，当前是锁定还是解锁**只由图标形态 +
        //    data-kind=primary 表达**（锁着 = 闭合挂锁 + 实心蓝底；解锁 = 开口挂锁 + 描边）。
        //    由此带来的三条硬约束，缺任一条都是净损失：
        //    ① `title` 仍按状态给 lockCopy 的整句 —— 按钮上只剩四个字，
        //       「保住的是什么 / 先烧的是什么 / 什么时候会没有可用账号」全靠它；
        //    ② `aria-label` 必须说**动作**（「锁定永久积分」/「解锁永久积分」），
        //       不能跟着按钮文字念「永久积分」—— 读屏用户听不出点下去会怎样；
        //       这两个字面量同时是 tests/unit/loomy-client.spec.ts 的锚点，别改字；
        //    ③ 加载态文字换成「处理中…」之外，图标也一起转圈（`data-loading`
        //       驱动样式里的 .dim-jh-iconBtn[data-loading="true"] svg 动画）——
        //       双保险：文字换了但用户眼神在图标上，只动一处会看不出还在忙。
        canLockPermanent ? React3.createElement(
          "button",
          {
            className: "dim-jh-btn dim-jh-iconTextBtn",
            "data-kind": permanentLocked ? "primary" : void 0,
            "data-loading": lockBusy ? "true" : void 0,
            "aria-label": permanentLocked ? "解锁永久积分" : "锁定永久积分",
            title: permanentLocked ? lockCopy.lockedTitle : lockCopy.lockTitle,
            disabled: lockBusy,
            onClick: () => void togglePermanentLock()
          },
          React3.createElement(
            "svg",
            {
              width: 14,
              height: 14,
              viewBox: "0 0 24 24",
              fill: "none",
              stroke: "currentColor",
              strokeWidth: 2,
              strokeLinecap: "round",
              strokeLinejoin: "round",
              "aria-hidden": "true",
              focusable: "false"
            },
            // 挂锁图标，两种状态共用锁体，只改锁梁：
            //   锁定 = 锁梁闭合（两边都落到锁体上）；
            //   解锁 = 锁梁右侧抬起（左端仍插在锁体里），一眼能分辨。
            React3.createElement("rect", { x: 3, y: 11, width: 18, height: 11, rx: 2 }),
            permanentLocked ? React3.createElement("path", { d: "M7 11V7a5 5 0 0 1 10 0v4" }) : React3.createElement("path", { d: "M7 11V7a5 5 0 0 1 9.9-1" })
          ),
          lockBusy ? "处理中…" : "永久积分"
        ) : null,
        // ⚠️ **「模型列表」排在「+ 新建账号」左边，且已改成图标 + 文字**
        //    （用户 2026-10-26：「模型按钮移动到新建账号左边改为图标+模型」）。
        //    图标是「列表」语义（三横线 + 圆点），文字仍保留「模型」二字 ——
        //    纯图标认不出是列表还是筛选，而这按钮与新建账号紧挨着、只差一个字的
        //    宽度，省不出多少地方。
        //    ⚠️ `aria-label` 仍写全「模型列表」（读屏念的是动作，不是按钮上那两个字）。
        //    ⚠️ 顺序：**模型列表 → 新建账号 → 刷新积分**（三个都跟「本页内容」相关）。
        React3.createElement(
          "button",
          {
            className: "dim-jh-btn dim-jh-iconTextBtn",
            title: MODEL_LIST_HELP,
            "aria-label": "模型列表",
            onClick: () => setShowModels(true)
          },
          React3.createElement(
            "svg",
            {
              width: 14,
              height: 14,
              viewBox: "0 0 24 24",
              fill: "none",
              stroke: "currentColor",
              strokeWidth: 2,
              strokeLinecap: "round",
              strokeLinejoin: "round",
              "aria-hidden": "true",
              focusable: "false"
            },
            // 列表图标：三横线 + 左侧圆点
            React3.createElement("path", { d: "M9 6h11" }),
            React3.createElement("path", { d: "M9 12h11" }),
            React3.createElement("path", { d: "M9 18h11" }),
            React3.createElement("path", { d: "M4.5 6h.01" }),
            React3.createElement("path", { d: "M4.5 12h.01" }),
            React3.createElement("path", { d: "M4.5 18h.01" })
          ),
          "模型"
        ),
        // ⚠️ 渠道弹窗**只服务 ZCode**：非 zcode 直接发起登录，与「搬进弹窗」
        //   之前逐字等价。上游 15ccae5 把渠道选择搬进弹窗时丢了这层门控，
        //   于是全部 14 个 provider 点「+ 新建账号」都弹出一个「添加 ZCode 账号」。
        React3.createElement(
          "button",
          {
            className: "dim-jh-btn dim-jh-iconBtn",
            "data-kind": "primary",
            // ⚠️ 2026-10-26 用户要求「新建账号按钮改为图标」：文字 `+ 新建账号`
            //    已收进 title / aria-label。与「删除」「刷新积分」两枚图标按钮
            //    同一套约束（缺任一条都是净损失）：
            //    ① `title` 把动作说全（图标不自解释），且要反映登录进行中；
            //    ② `aria-label` 必须有 —— svg 标了 aria-hidden，否则读屏只念「按钮」；
            //    ③ 加载态没有文字可换 ⇒ title/aria-label 跟着 `creating` 变，并靠
            //       `disabled` 拦住重复点击。
            title: creating ? "正在通过浏览器登录新账号…" : "新建账号：通过浏览器登录一个新的账号并加入账号池。",
            "aria-label": creating ? "正在登录新账号" : "新建账号",
            // ⚠⚠ **必须按 provider 分支**（真实缺陷，Gitee issue IKJLK3 A1/A2/A3）：
            //   这个按钮在**每一个** provider 的面板里都有，而下面的弹窗是
            //   **zCode 专用**的（登录渠道下拉）。原先无条件 `setPendingLogin(false)`，
            //   于是「在 CodeArts 面板点新建账号」弹出的也是「添加 ZCode 账号」，
            //   里面的下拉还不会下发（载荷里没有 `zcodeProvider`），
            //   opencode 则要用户先过一遍 ZCode 弹窗才看到自己的 API key 表单。
            //   ⇒ 判据收在 `newAccountAsksChannel()`：只有 zcode 先问渠道，
            //   其余 provider 点按钮即发起登录。**别把它改回无条件开弹窗。**
            onClick: () => {
              if (newAccountAsksChannel(provider)) setPendingLogin(false);
              else void createAccount();
            },
            disabled: creating
          },
          React3.createElement(
            "svg",
            {
              width: 14,
              height: 14,
              viewBox: "0 0 24 24",
              fill: "none",
              stroke: "currentColor",
              strokeWidth: 2,
              strokeLinecap: "round",
              strokeLinejoin: "round",
              "aria-hidden": "true",
              focusable: "false"
            },
            // 人形 + 加号（user-plus）：新建的是「一个账号」，不是「一个文件」
            React3.createElement("path", { d: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" }),
            React3.createElement("circle", { cx: 9, cy: 7, r: 4 }),
            React3.createElement("path", { d: "M19 8v6" }),
            React3.createElement("path", { d: "M22 11h-6" })
          )
        ),
        // ⚠️ **刷新积分排在「+ 新建账号」右边**（用户 2026-10-26 要求
        //    「将刷新积分按钮移动到新建账号右边」）。改前它在「一键领取积分」左侧，
        //    与「新建账号」隔了两个按钮 —— 两者同属「让本页数据变新」的动作，
        //    挨在一起比夹在领取/重测中间更顺手。
        //    ⚠️ 它必须仍在 minimaxintl 的「国际站分流设置」之前：那个是排障入口。
        canLoadCredits ? React3.createElement(
          "button",
          {
            className: "dim-jh-btn dim-jh-iconBtn",
            "data-loading": creditsLoading ? "true" : void 0,
            title: creditsLoading ? "正在查询本页全部账号的剩余积分…" : "刷新积分：重新查询本页全部账号的剩余积分（Credits Balance）。余额由服务端实时计算，点此可强制回源刷新（绕过 120 秒缓存）。",
            "aria-label": creditsLoading ? "正在查询积分" : "刷新积分",
            disabled: creditsLoading,
            onClick: () => void loadCredits(true)
          },
          React3.createElement(
            "svg",
            {
              width: 14,
              height: 14,
              viewBox: "0 0 24 24",
              fill: "none",
              stroke: "currentColor",
              strokeWidth: 2,
              strokeLinecap: "round",
              strokeLinejoin: "round",
              "aria-hidden": "true",
              focusable: "false"
            },
            // 环形箭头：缺口圆 + 端点箭头（顺时针方向）
            React3.createElement("path", { d: "M21 12a9 9 0 1 1-3.2-6.9" }),
            React3.createElement("path", { d: "M21 3v5h-5" })
          )
        ) : null,
        /**
         * ⚠️ **只给 MiniMax 国际版**（issue IKMEVG）：它的数据面
         * `agent.minimax.io` 按**出口 IP 国别**把中国大陆来源 307 到中国站，
         * 于是大陆网络下国际站账号永远拿不到数据面（与 token 有效性无关）。
         * 这里给一个入口让用户填海外 IP 绕开该分流。
         *
         * ⚠️ 其它 provider 一律不渲染（多一个永远无效的按钮只会让用户困惑）。
         *
         * ⚠️ **位置必须在「+ 新建账号」之后**（2026-10-17 用户要求
         * 「minimax国际版的新建账号放在国际站分流之前」）：新建账号是**主操作**，
         * 分流设置是**排障用的次要入口** —— 次要项排在主操作前面会让用户
         * 先看到「分流设置」而不是「怎么加账号」。
         */
        provider === "minimaxintl" ? React3.createElement("button", {
          className: "dim-jh-btn",
          "data-kind": minimaxXff !== "" ? "primary" : void 0,
          title: `MiniMax 国际站的服务器会按**出口 IP 所在国家**决定把你路由到哪个站：中国大陆 IP 会被 307 重定向到中国站，表现为「余额查询失败 / 模型不可用」。

在此填写一个**海外 IP**（如 8.8.8.8）即可让请求被判为海外来源、留在国际站。
留空 = 不伪造来源（推荐先用代理改变出口 IP，那是更正当的方式）。

当前：${minimaxXff === "" ? "未设置" : minimaxXff}`,
          onClick: () => setShowMinimaxXff(true)
        }, minimaxXff !== "" ? "国际站分流：已绕过" : "国际站分流设置") : null,
        // ★ 预选对话框（用户 2026-10-03：从按钮旁搬到弹窗里）
        //
        // ⚠ 内容按 provider 分支：zcode 问**登录渠道**，accio 问**登录区域**
        //   （两者都收在 `newAccountAsksChannel` 的白名单里）。
        //
        // ⚠ `newAccountAsksChannel(provider)` 这道是**防御性**的：按钮已经分支过，
        //   正常路径下不在白名单的 provider 永远不会把 `pendingLogin` 置为「开」。
        //   但状态是活的（用户切 provider 时本面板会重新挂载，理论上仍可能
        //   残留一帧），漏掉它就会退回 issue 里那个「非 zcode 弹出 ZCode 窗」的形态。
        //
        // ⚠ 类名 `dim-jh-zcDialog*` 名字里带 zc，但它**已是通用弹窗样式**
        //   （见 `jet-hub-styles.js`），**不是** zCode 专用标记。
        //   曾想改名，但样式表一起动、收益仅是可读性，故保留名字。
        //
        // ⚠ 本弹窗原先有**两个入口**（这里与官方模型卡片里的 ZCode 账号区）；后者
        //   已随 Gitee issue IKJLHQ 整体移除（它占用的 provider-card 槽 key 与第三方
        //   pi-ai 扩展互斥，机制见 index.js 文件头）—— 现在只剩本处一个入口。
        pendingLogin === void 0 || !newAccountAsksChannel(provider) ? null : React3.createElement(
          "div",
          {
            className: "dim-jh-zcDialogMask",
            onClick: () => setPendingLogin(void 0)
          },
          React3.createElement(
            "div",
            {
              className: "dim-jh-zcDialog",
              onClick: (event) => event.stopPropagation()
            },
            React3.createElement(
              "h3",
              { className: "dim-jh-zcDialogTitle" },
              // ⚠ 弹窗服务四个 provider（zcode / accio / astudio / autoclaw），
              //   各问各的东西：渠道 / 区域 / AStudio 登录方式 / AutoClaw 登录方式。
              astudioDialog ? "添加 AStudio 账号" : autoclawDialog ? "添加 AutoClaw 账号" : accioDialog ? "添加 Accio 账号" : "添加 ZCode 账号"
            ),
            React3.createElement(
              "p",
              { className: "dim-jh-zcDialogHint" },
              astudioDialog ? "支持导入本机桌面端已登录会话，或在浏览器中打开三合一登录页（支持手机短信/账号密码/微信扫码）。" : autoclawDialog ? "请选择登录方式：可直接读取本机已安装并登录的桌面端凭据，或使用手机短信验证码快速登录。" : accioDialog ? "Accio 的登录页按区域分域名，且区域由服务端按账号下发 —— 登录前无法自动判断。请选择该账号所属的区域，否则会打开打不开的登录页。" : "选择登录渠道后才会打开对应的认证页面。两个渠道的授权页与凭据各自独立，"
            ),
            accioDialog || astudioDialog || autoclawDialog ? null : React3.createElement(
              "p",
              { className: "dim-jh-zcDialogHint" },
              "可用 z.ai（国际）登录另一个账号。"
            ),
            React3.createElement(
              "label",
              { className: "dim-jh-zcProvider" },
              astudioDialog ? "登录方式" : autoclawDialog ? "登录方式" : accioDialog ? "登录区域" : "登录渠道"
              // ⚠️⚠️ **原生 `<select>` 已整体删除**（2026-10-17 审计 P2 修复，
              //    本次合并 astudio 侧时一并采纳 —— astudio 侧原本还留着第四个死 select）。
              //   原先此处有**四个**各自带 `style:{display:'none'}` 的 `<select>`
              //   （astudioLoginMethod / autoclawMode / accioRegion / zcodeProvider），
              //   功能已由下方**单选卡片组**接管（Windows/Electron 下原生下拉经常点不开）。
              //   ⇒ 那四个是纯**死 DOM**：不可见、其 `onChange` 永不触发，
              //     却仍渲染出 `<option>` 并把 state 挂在上面 ——
              //     既是维护陷阱（改 options 会让人误以为生效），
              //     也是「一份状态两套 UI 判据」这种本仓库红线形态。
              //   ⚠️ 守卫已同步改写：`tests/unit/new-account-dialog.spec.ts`
              //     里原先断言 `value: accioRegion` / `onChange: …target.value`
              //     （原生 select 专属形态）的那几条，现在锁的是**卡片组**的
              //     `onClick: () => setXxx(opt.value)` —— 否则删掉死 DOM
              //     会让守卫变成「保护一个不存在的东西」。
              // ⚠️ **label 自身到此闭合**（2026-10-17 审计 P2 修复）：
              //   删掉原先那个 `<select>`（第三个子参数）后，`label` 的
              //   `createElement(` 只剩两个参数 ⇒ 必须补这个右括号，
              //   否则 esbuild 报 `Expected ")" but found ";"`。
              //   ⚠️ 这类语法错误**单测查不出来**（本仓库 client 守卫多为
              //   源码文本断言，不做解析）⇒ 改完本文件**必须**跑
              //   `pnpm build:client`，见 AGENTS.md 的「单测只读源码文本」那条。
            ),
            // 彻底解决 Windows/Electron 下原生 <select> 下拉框经常点不开的恶心 bug：使用 100% 可靠的 DOM 单选卡片组
            React3.createElement(
              "div",
              {
                style: {
                  display: "flex",
                  flexDirection: "column",
                  gap: "8px",
                  margin: "8px 0 16px"
                }
              },
              astudioDialog ? [
                { value: "local", label: "⚡ 一键导入本机桌面端凭据", desc: "需已在 AStudio 桌面端登录，自动读取本地会话" },
                { value: "web", label: "🌐 网页三合一快捷登录", desc: "在浏览器载体页中登录，支持手机短信/账号密码/微信扫码，免依赖桌面端" }
              ].map((opt) => {
                const active = astudioLoginMethod === opt.value;
                return React3.createElement(
                  "div",
                  {
                    key: opt.value,
                    onClick: () => setAstudioLoginMethod(opt.value),
                    style: {
                      display: "flex",
                      alignItems: "center",
                      gap: "10px",
                      padding: "10px 14px",
                      borderRadius: "6px",
                      border: active ? "1.5px solid var(--dsw-alias-primary, #0284c7)" : "1px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.25))",
                      background: active ? "var(--dsw-alias-primary-tint, rgba(2, 132, 199, 0.1))" : "var(--dsw-alias-bg-layer-2, transparent)",
                      cursor: "pointer",
                      transition: "all 0.15s ease",
                      userSelect: "none"
                    }
                  },
                  React3.createElement("div", {
                    style: {
                      width: "14px",
                      height: "14px",
                      borderRadius: "50%",
                      border: active ? "4px solid var(--dsw-alias-primary, #0284c7)" : "1.5px solid var(--dsw-alias-border-l2, #8b949e)",
                      boxSizing: "border-box",
                      flexShrink: 0,
                      background: active ? "#fff" : "transparent"
                    }
                  }),
                  React3.createElement(
                    "div",
                    { style: { display: "flex", flexDirection: "column" } },
                    React3.createElement("span", {
                      style: {
                        fontSize: "13px",
                        fontWeight: active ? 600 : 400,
                        color: "var(--dsw-alias-label-primary, inherit)"
                      }
                    }, opt.label),
                    React3.createElement("span", {
                      style: {
                        fontSize: "11px",
                        color: "var(--dsw-alias-label-tertiary, #888)",
                        marginTop: "2px"
                      }
                    }, opt.desc)
                  )
                );
              }) : accioDialog ? [
                { value: "cn", label: "🇨🇳 中国版（www.accio-ai.com）", desc: "适用于 Accio 国内站点账号" },
                { value: "global", label: "🌐 国际版（zh.accio.com）", desc: "适用于 Accio 国际站点账号" }
              ].map((opt) => {
                const active = accioRegion === opt.value;
                return React3.createElement(
                  "div",
                  {
                    key: opt.value,
                    onClick: () => setAccioRegion(opt.value),
                    style: {
                      display: "flex",
                      alignItems: "center",
                      gap: "10px",
                      padding: "10px 14px",
                      borderRadius: "6px",
                      border: active ? "1.5px solid var(--dsw-alias-primary, #0284c7)" : "1px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.25))",
                      background: active ? "var(--dsw-alias-primary-tint, rgba(2, 132, 199, 0.1))" : "var(--dsw-alias-bg-layer-2, transparent)",
                      cursor: "pointer",
                      transition: "all 0.15s ease",
                      userSelect: "none"
                    }
                  },
                  React3.createElement("div", {
                    style: {
                      width: "14px",
                      height: "14px",
                      borderRadius: "50%",
                      border: active ? "4px solid var(--dsw-alias-primary, #0284c7)" : "1.5px solid var(--dsw-alias-border-l2, #8b949e)",
                      boxSizing: "border-box",
                      flexShrink: 0,
                      background: active ? "#fff" : "transparent"
                    }
                  }),
                  React3.createElement(
                    "div",
                    { style: { display: "flex", flexDirection: "column" } },
                    React3.createElement("span", {
                      style: {
                        fontSize: "13px",
                        fontWeight: active ? 600 : 400,
                        color: "var(--dsw-alias-label-primary, inherit)"
                      }
                    }, opt.label),
                    React3.createElement("span", {
                      style: {
                        fontSize: "11px",
                        color: "var(--dsw-alias-label-tertiary, #888)",
                        marginTop: "2px"
                      }
                    }, opt.desc)
                  )
                );
              }) : autoclawDialog ? [
                { value: "local", label: "⚡ 一键导入本机桌面端凭据", desc: "需已在 AutoClaw 桌面端登录，自动秒级解密" },
                // ⚠️ 国际版**不渲染**这条：它的账号是邮箱 + Z.ai OAuth 创建的、
                //    `phone` 为 null、无绑手机端点 ⇒ 短信必然失败（详见
                //    `autoclawSmsAvailable` 的注释）。
                ...autoclawSmsAvailable ? [{ value: "sms", label: "📱 手机验证码快速登录", desc: "免安装桌面端，支持输入任意手机号登录" }] : []
              ].map((opt) => {
                const active = autoclawMode === opt.value;
                return React3.createElement(
                  "div",
                  {
                    key: opt.value,
                    onClick: () => setAutoclawMode(opt.value),
                    style: {
                      display: "flex",
                      alignItems: "center",
                      gap: "10px",
                      padding: "10px 14px",
                      borderRadius: "6px",
                      border: active ? "1.5px solid var(--dsw-alias-primary, #0284c7)" : "1px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.25))",
                      background: active ? "var(--dsw-alias-primary-tint, rgba(2, 132, 199, 0.1))" : "var(--dsw-alias-bg-layer-2, transparent)",
                      cursor: "pointer",
                      transition: "all 0.15s ease",
                      userSelect: "none"
                    }
                  },
                  React3.createElement("div", {
                    style: {
                      width: "14px",
                      height: "14px",
                      borderRadius: "50%",
                      border: active ? "4px solid var(--dsw-alias-primary, #0284c7)" : "1.5px solid var(--dsw-alias-border-l2, #8b949e)",
                      boxSizing: "border-box",
                      flexShrink: 0,
                      background: active ? "#fff" : "transparent"
                    }
                  }),
                  React3.createElement(
                    "div",
                    { style: { display: "flex", flexDirection: "column" } },
                    React3.createElement("span", {
                      style: {
                        fontSize: "13px",
                        fontWeight: active ? 600 : 400,
                        color: "var(--dsw-alias-label-primary, inherit)"
                      }
                    }, opt.label),
                    React3.createElement("span", {
                      style: {
                        fontSize: "11px",
                        color: "var(--dsw-alias-label-tertiary, #888)",
                        marginTop: "2px"
                      }
                    }, opt.desc)
                  )
                );
              }) : [
                { value: "bigmodel", label: "🇨🇳 BigModel（智谱开放平台，国内）", desc: "适用于 open.bigmodel.cn 国内平台账号" },
                { value: "zai", label: "🌐 z.ai（chat.z.ai，国际版）", desc: "适用于 z.ai 国际版账号" }
              ].map((opt) => {
                const active = zcodeProvider === opt.value;
                return React3.createElement(
                  "div",
                  {
                    key: opt.value,
                    onClick: () => setZcodeProvider(opt.value),
                    style: {
                      display: "flex",
                      alignItems: "center",
                      gap: "10px",
                      padding: "10px 14px",
                      borderRadius: "6px",
                      border: active ? "1.5px solid var(--dsw-alias-primary, #0284c7)" : "1px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.25))",
                      background: active ? "var(--dsw-alias-primary-tint, rgba(2, 132, 199, 0.1))" : "var(--dsw-alias-bg-layer-2, transparent)",
                      cursor: "pointer",
                      transition: "all 0.15s ease",
                      userSelect: "none"
                    }
                  },
                  React3.createElement("div", {
                    style: {
                      width: "14px",
                      height: "14px",
                      borderRadius: "50%",
                      border: active ? "4px solid var(--dsw-alias-primary, #0284c7)" : "1.5px solid var(--dsw-alias-border-l2, #8b949e)",
                      boxSizing: "border-box",
                      flexShrink: 0,
                      background: active ? "#fff" : "transparent"
                    }
                  }),
                  React3.createElement(
                    "div",
                    { style: { display: "flex", flexDirection: "column" } },
                    React3.createElement("span", {
                      style: {
                        fontSize: "13px",
                        fontWeight: active ? 600 : 400,
                        color: "var(--dsw-alias-label-primary, inherit)"
                      }
                    }, opt.label),
                    React3.createElement("span", {
                      style: {
                        fontSize: "11px",
                        color: "var(--dsw-alias-label-tertiary, #888)",
                        marginTop: "2px"
                      }
                    }, opt.desc)
                  )
                );
              })
            ),
            React3.createElement(
              "div",
              { className: "dim-jh-zcDialogActions" },
              React3.createElement("button", {
                className: "dim-jh-btn",
                onClick: () => setPendingLogin(void 0)
              }, "取消"),
              React3.createElement(
                "button",
                {
                  className: "dim-jh-btn",
                  "data-kind": "primary",
                  onClick: () => {
                    setPendingLogin(void 0);
                    void createAccount();
                  }
                  // ⚠ 两家（astudio / autoclaw）都在「本机导入」档时改成导入语义文案，
                  //    其余档都是打开认证页。两个 provider 各判各的，不可合并。
                },
                astudioDialog && astudioLoginMethod === "local" || autoclawDialog && autoclawMode === "local" ? "确定并导入本地账号" : "确定并打开认证页"
              )
            )
          )
        )
      )
    ),
    // ⚠️ 上面三个右括号缺一不可（2026-10-26 修）：第一个关 zcDialogMask、
    //    第二个关 .dim-jh-headerActions、**第三个关 .dim-jh-panelHead**。
    //    此前只有两个 ⇒ panelHead 一直没闭合，把补偿卡片 / 账号列表 / 全部弹窗
    //    都圈成了它的 flex 子项，于是补偿卡片（flex: 0 1 auto）被挤到按钮组
    //    同一行的最右侧（用户报障「为什么最右侧显示的是补偿积分已领取」）。
    // ⚠️ panelHead 现在有 9 个子项（2026-10-26 第二次改）：标题 / 6 条状态提示 /
    //    排序提示三元 / 按钮组。结构由 tests/unit/jet-hub-structure-ast.spec.ts
    //    用 AST 守着 —— 文本切片断言在括号错位时**全部通过**，只有 AST 能发现。
    //    ⚠️ 本段（section 的直接子节点）**不得**再出现任何 .dim-jh-probeNotice：
    //    它们一律属于 panelHead，出现在这里就会落到按钮行下方。
    phase === "loading" ? React3.createElement("div", { className: "dim-jh-empty" }, "正在读取账号列表…") : phase === "error" ? React3.createElement(
      "div",
      { className: "dim-jh-empty", role: "alert" },
      React3.createElement("p", null, error),
      React3.createElement("button", { className: "dim-jh-btn", onClick: loadAccounts }, "重新读取")
    ) : accounts.length === 0 ? React3.createElement(
      "div",
      { className: "dim-jh-empty" },
      // ⚠️ opencode 的「新建」是**粘贴 API key**、不是浏览器登录，
      // 空态文案必须跟着变 —— 否则用户会去找一个根本不存在的登录页。
      provider === "opencode" ? React3.createElement(
        "div",
        null,
        React3.createElement(
          "p",
          null,
          "尚未添加账号。免费模型无需账号即可使用；添加自己的 API key 可启用付费模型，并为每个账号配置独立出口。"
        ),
        React3.createElement(
          "p",
          { className: "dim-jh-hint" },
          "API key 在 opencode.ai/console/account 生成（旧 key 形如 sk-…，新 key 形如 oc_sk_…）"
        )
      ) : React3.createElement(
        "div",
        null,
        React3.createElement("p", null, "尚未配置账号"),
        React3.createElement("p", null, '点击"+ 新建账号"进行浏览器登录。')
      )
    ) : React3.createElement(
      "div",
      { className: "dim-jh-accountList" },
      // ⚠️ **必须有 className**（2026-10-21 修）：本行的父级是
      // `.dim-jh-panelHead`（column flex），而它原先带 `align-items: flex-start`
      // ⇒ 无类名的 div 作为 flex item 会**收缩到内容宽度** —— 只有单个账号时
      // 卡片缩成 ~257px 的窄条（多账号时被那句排序提示撑宽，所以看起来正常）。
      // `.dim-jh-accountList` 用 `align-self: stretch` 强制满宽，与账号数量无关。
      // ⚠️ **根因已另修**（`jet-hub-styles.js` 的 `.dim-jh-panelHead` 去掉了
      // `align-items: flex-start` ⇒ 全部子项 stretch）⇒ 本条规则现在是冗余兜底。
      // ⚠️ 注释里原先写的「654px 长的排序提示」是**错的**（2026-10-21 实测：
      // 那句是两段拼接、共 100 字符、12px 字号 ⇒ max-content **约 1200px**）。
      // ⚠️ opencode 专属策略提示：必须说清「多账号 ≠ 多额度」——
      // 匿名通道按出口 IP 限流，同一出口下的多个账号共用一份额度。
      // 不解释的话，用户加了 5 个号却只看到一份配额，会以为功能坏了。
      provider === "opencode" ? React3.createElement(
        "p",
        { className: "dim-jh-hint" },
        "免费模型在所有通道间自动轮换，收费模型仅「API key 账号」可用。匿名通道无需 key，可添加多条、各自配代理；注意额度按「出口 IP」计算 —— 多条通道共用一个出口不会增加额度，分别配不同代理才会各自获得独立额度。"
      ) : null,
      // ⚠️ 排序提示**已挪到 `.dim-jh-panelHead` 里**（用户 2026-10-26
      //    「将按钮行合并到文案行最右侧」）—— 它必须与按钮组同父级
      //    才能排到同一行。**不要**搬回这里：搬回来会立刻变回三行。
      reorderError ? React3.createElement("div", {
        className: "dim-jh-probeNotice",
        "data-tone": "warn",
        role: "alert"
      }, React3.createElement("div", null, `顺序保存失败：${reorderError}`)) : null,
      accounts.map((account, index) => React3.createElement(AccountCard, {
        key: account.id,
        account,
        index,
        // ⚠️ `provider` 必须传进来：积分行的**池名分桶**要按 provider
        // 决定另一个池的标签（Loomy 是「永久」、Raccoon 是「长期」）。
        // 漏传会在渲染时抛 `ReferenceError: provider is not defined`
        // 并让整个 Jet Hub 设置页崩成白屏（真实事故，2026-09-29）。
        provider,
        busy: probeBusy !== null,
        credits: credits[account.id],
        creditsLoading: creditsLoading && credits[account.id] === void 0,
        // ⚠️ accio **不再**关掉通用积分行（2026-10-13 改）：
        // 用户报障原文「accio 的显示和别的 provider 没统一，例如 loomy 的」。
        // 现改为与 loomy 同形 —— 卡片里就是积分行，三类桶由
        // `CreditBalanceRow` 的 `formatNamedPoolLine` 逐池列出，
        // 倒计时作为同一行内的一个附注（见那里的注释）。
        showCredits: canLoadCredits,
        // 账号名 hover 列资源包：只有余额真由多个包构成的 provider 才挂
        // （loomy 的池是我们合成的、无到期字段，列出来会把「每日赠送」
        // 标成长期 —— 恰好说反）。
        showPackageList: supportsCreditPackageList(provider),
        // 「临时 / 长期」分桶的窗口天数（buddy 系 + TRAE + LobsterAI 才有值）。
        windowDays: expiryWindowDays,
        // 卡片级「重测 / 重置」：只对会返回限流错误的 provider 渲染。
        showRateLimitActions: supportsRateLimit(provider),
        onToggle: toggleAccount,
        onDelete: deleteAccount,
        onRetest: (id) => void runLimitAction("retest", id),
        onReset: (id) => void runLimitAction("reset", id),
        // ⚠️ 「测试」用**独立**的能力位（`supportsAccountTest`）与独立的
        // props 存在性开关，不能挂在 `showRateLimitActions` 上：Gemini
        // 恰好只登记了测试、没登记重测（它的限流是配额窗口制，重测无意义），
        // 绑一起就会二选一地消失一个按钮。
        onTest: supportsAccountTest(provider) ? (id) => void runTestAction(id) : void 0,
        // ⚠️ 仅 opencode：这两个回调只在该 provider 下传，
        // AccountCard 靠「props 存在性」决定是否渲染按钮。
        ...provider === "opencode" ? {
          onOpenProxy: (id, current) => setProxyModal({ provider, accountId: id, current }),
          onRotateFingerprint: (id) => void rotateFingerprint(id)
        } : {},
        // ⚠️ **Gemini 也要「代理」按钮**（Gitee issue IKLTZ2）：它的全部端点
        // 都在墙外，而插件进程**不读系统代理** ⇒ 没出口就恒连不上。
        // ⚠️ 与 opencode **刻意分成两个回调**而不是共用：两者读不同的池字段
        //（`geminiProxy` / `opencodeProxy`）、调不同的端点前缀、共用会让
        // 「清掉 Gemini 的代理」连带清掉 opencode 的出口配置。
        ...provider === "gemini" ? {
          onOpenProxy: (id, current) => setProxyModal({ provider, accountId: id, current })
        } : {},
        // ⚠️ **Qoder 也要「代理」按钮**（真实报障 2026-10-21）：它是唯一
        // 有墙外端点却**没有**代理入口的渠道 —— 国际版
        // `openapi.qoder.sh` 被 SNI 阻断（TCP 能连、TLS 握手被丢），
        // 表现为「转十秒然后 fetch failed」，而中国版直连 160ms 就通。
        // ⚠️ 两站**都要传**：中国版虽然通常直连就通，但同样需要
        // 「配了代理却查不到自己的出口」时的可见性；弹窗内部按
        // `provider` 分站给文案与探测目标。
        ...provider === "qoder" || provider === "qodercn" ? {
          onOpenProxy: (id, current) => setProxyModal({ provider, accountId: id, current })
        } : {},
        // ⚠️ **MiniMax 国际站也要「代理」按钮**：`agent.minimax.io` 按出口
        // IP 国别分流，大陆来源会被 307 到中国站 ⇒ 与「凭据失效」同形的
        // 401。给它配一个海外出口是根治手段（既有的 X-Forwarded-For
        // 只是声明来源 IP，上游不认即失效）。
        // ⚠️ 同样**刻意分成独立回调**：它读的是 `minimaxIntlProxy` 字段、
        // 调 `minimaxintl.*` 端点，与上面两家共用会互相清掉配置。
        ...provider === "minimaxintl" ? {
          onOpenProxy: (id, current) => setProxyModal({ provider, accountId: id, current })
        } : {},
        // ⚠️ **本 fork 独有**（modelscope，2026-10-17）：编辑访问令牌。
        // 同样只在该 provider 下传，靠「props 存在性」决定是否渲染按钮。
        ...provider === "modelscope" ? {
          onEditModelscopeKey: (id, masked) => setKeyEditModal({
            accountId: id,
            currentMasked: masked
          })
        } : {},
        // 新手任务（仅 Loomy）：一次性 10000 分，每号只能领一次。
        // 与「一键领取积分」（每日签到）是**不同**的操作，故独立按钮。
        onClaimOnboarding: canClaimOnboarding ? (id) => void claimOnboarding(id) : void 0,
        onboardingBusy: onboardingLoading,
        // 提交顺序期间禁用拖拽，避免并发提交互相覆盖。
        drag: reordering ? { enabled: false } : dragPropsFor(account, index)
      }))
    ),
    // 模型列表以 modal 渲染：它是覆盖层，放在账号区之后只是组件树的书写顺序，
    // 实际靠 fixed 定位浮在整个面板之上，不再挤占账号池的版面。
    showModels ? React3.createElement(ModelListPanel, {
      provider,
      rpcCall,
      onClose: () => setShowModels(false)
    }) : null,
    // 「订阅额度」弹窗同样以覆盖层渲染（不挤占账号池版面）。
    // 不复用 ModelListPanel 的 provider 形参：额度端点当前只认 Cline，
    // 由 `canShowSubscriptionQuota` 门控按钮，面板内部固定传 'cline'。
    showQuota ? React3.createElement(ClineQuotaPanel, {
      rpcCall,
      onClose: () => setShowQuota(false)
    }) : null,
    // MiniMax 国际站分流设置弹窗（issue IKMEVG）：覆盖层，独立 state。
    showMinimaxXff ? React3.createElement(MinimaxXffPanel, {
      rpcCall,
      value: minimaxXff,
      onSaved: (next) => setMinimaxXff(next),
      onClose: () => setShowMinimaxXff(false)
    }) : null,
    // 出口代理弹窗（仅 opencode）：覆盖层，与上面两个弹窗各自独立 state，
    // 同时打开也只是叠加，不会互相顶掉。
    //
    // ⚠️⚠️ **必须用 `React.createElement(组件, props)`，不能直接调用函数**
    // （真实事故 2026-10-02）：这两个弹窗内部有 `useState`，若在
    // ProviderPanel 的渲染过程中**直接函数调用**，它们的 hook 会被算进
    // ProviderPanel —— 于是「打开弹窗」与「关闭弹窗」两次渲染的 hook 数量
    // 不同，React 抛 #310（"Rendered more hooks than during the previous render"），
    // 整个设置页崩成白屏。仓库其它弹窗（ModelListPanel / BackupPanel /
    // ClineQuotaPanel）都是 `createElement` 形式，正是这个原因。
    proxyModal ? React3.createElement(proxyModalComponent(proxyModal.provider), {
      // ⚠️ 传最小 ctx 门面而不是整个面板：弹窗只需要 rpc，
      // 这样它在单测/复用时不必拖上整个 ProviderPanel 的依赖。
      ctx: { rpc: (payload) => rpcCall(payload.method, payload.payload) },
      accountId: proxyModal.accountId,
      current: proxyModal.current,
      // ⚠️ 只有 Qoder 弹窗读这一项（它两站文案与探测目标不同）。
      // 其余组件解构时忽略多余的 props，故统一透传不影响它们。
      provider: proxyModal.provider,
      onClose: () => setProxyModal(null)
    }) : null,
    // 「添加 opencode 账号」弹窗：自绘而非 window.prompt ——
    // DSH 客户端沙箱里 prompt() 直接抛 `prompt() is not supported`（真机报障）。
    keyModal && keyModal.provider !== "modelscope" ? React3.createElement(OpencodeKeyModal, {
      error: keyModal.error,
      busy: creating,
      inputRef: keyInputRef,
      onSubmit: (value) => void submitOpencodeKey(value),
      onSubmitAnonymous: () => void submitAnonymous(),
      onClose: () => setKeyModal(null)
    }) : null,
    // ⚠️ **本 fork 独有**（魔搭）：与上面共用 `keyModal` 状态与 `keyInputRef`
    //    （两个弹窗都是单例、互斥显示），但**按 provider 分派** —— 本仓库约定
    //    「通用面板里的按钮与弹窗必须按 provider 分支」，两家的表单字段不同。
    //    ⚠️ 必须用 `React.createElement` 而非直接调用组件函数：直接调用会把
    //    组件的 hook 算进 ProviderPanel（该文件头记录过 hook #310 事故）。
    keyModal && keyModal.provider === "modelscope" ? React3.createElement(ModelscopeKeyModal, {
      error: keyModal.error,
      busy: creating,
      inputRef: keyInputRef,
      onSubmit: (value) => void submitModelscopeKey(value),
      onClose: () => setKeyModal(null)
    }) : null,
    // ⚠️ **本 fork 独有**（魔搭）：「编辑访问令牌」弹窗（独立 state + 独立 ref）。
    // ⚠️ 必须用 `React.createElement` 而非直接调用组件函数：直接调用会把组件的
    // hook 算进 ProviderPanel（该文件头记录过 hook #310 事故，整个设置页白屏）。
    keyEditModal ? React3.createElement(ModelscopeKeyEditModal, {
      error: keyEditModal.error || "",
      busy: creating,
      currentMasked: keyEditModal.currentMasked || "",
      inputRef: keyEditInputRef,
      onSubmit: (value) => void submitModelscopeKeyEdit(value),
      onClose: () => setKeyEditModal(null)
    }) : null
  );
}
function BackupPanel({ rpcCall, onImported }) {
  const [dialog, setDialog] = React3.useState(null);
  const [encrypt, setEncrypt] = React3.useState(true);
  const [pass1, setPass1] = React3.useState("");
  const [pass2, setPass2] = React3.useState("");
  const [importFile, setImportFile] = React3.useState(null);
  const [importPass, setImportPass] = React3.useState("");
  const [backupStatus, setBackupStatus] = React3.useState(null);
  const [confirmStep, setConfirmStep] = React3.useState(false);
  const [decryptedPayload, setDecryptedPayload] = React3.useState(null);
  const [busy, setBusy] = React3.useState(false);
  const [notice, setNotice] = React3.useState(null);
  const [exportIds, setExportIds] = React3.useState(null);
  const [importMode, setImportMode] = React3.useState("replace");
  const [importIds, setImportIds] = React3.useState(null);
  const fileRef = React3.useRef(null);
  const mounted = React3.useRef(true);
  React3.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const closeDialog = () => {
    if (!mounted.current) return;
    setDialog(null);
    setNotice(null);
    setBusy(false);
    setEncrypt(true);
    setPass1("");
    setPass2("");
    setImportFile(null);
    setImportPass("");
    setBackupStatus(null);
    setConfirmStep(false);
    setDecryptedPayload(null);
    setExportIds(null);
    setImportMode("replace");
    setImportIds(null);
  };
  const safeNotice = (next) => {
    if (mounted.current) setNotice(next);
  };
  const openExportDialog = async () => {
    setDialog("export");
    setNotice(null);
    setExportIds(null);
    try {
      const status = await rpcCall("backup.status", {});
      if (mounted.current) setBackupStatus(status || null);
    } catch (caught) {
      console.warn("[jet-hub] backup.status failed:", caught);
    }
  };
  const doExport = async () => {
    if (encrypt && pass1.length === 0) {
      safeNotice({ tone: "warn", text: "请设置备份口令" });
      return;
    }
    if (encrypt && pass1 !== pass2) {
      safeNotice({ tone: "warn", text: "两次输入的口令不一致" });
      return;
    }
    const exportIdList = exportIds === null ? null : Array.from(exportIds);
    if (exportIdList !== null && exportIdList.length === 0) {
      safeNotice({ tone: "warn", text: "请至少勾选一个账号，或选择「导出全部」" });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const res = await rpcCall("backup.export", exportIdList === null ? {} : { accountIds: exportIdList });
      const payload = res.payload;
      const warnings = res.warnings || [];
      const stamp = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10).replace(/-/g, "");
      const single = payload.accounts.length === 1 ? `-${payload.accounts[0].id}` : "";
      let data = payload;
      let filename = `dsh-codearts-backup${single}-${stamp}.json`;
      if (encrypt) {
        data = await encryptBackup(payload, pass1);
        filename = `dsh-codearts-backup${single}-${stamp}.enc.json`;
      }
      downloadJson(filename, data);
      const extra = warnings.length > 0 ? `，${warnings.length} 个账号凭据缺失（已跳过）` : "";
      safeNotice({ tone: "ok", text: `已导出 ${payload.accounts.length} 个账号${encrypt ? "（已加密）" : "（明文）"}${extra}` });
    } catch (caught) {
      console.error("[jet-hub] backup export failed:", caught);
      safeNotice({ tone: "error", text: `导出失败：${caught?.message || "未知错误"}` });
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const onFileSelected = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    safeNotice(null);
    try {
      const text = await readFileAsText(file);
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        safeNotice({ tone: "error", text: `${file.name} 不是有效的 JSON 备份文件` });
        return;
      }
      if (!mounted.current) return;
      if (looksLikeForeignAccountList(parsed)) {
        const converted = convertForeignAccounts(parsed);
        if (converted === null) {
          safeNotice({ tone: "error", text: `${file.name} 无法识别为账号列表` });
          return;
        }
        setImportFile({
          name: file.name,
          encrypted: false,
          parsed: converted.payload,
          converted: {
            count: converted.accounts.length,
            warnings: converted.warnings,
            providers: converted.providers
          }
        });
        setDialog("import");
        setImportPass("");
        setDecryptedPayload(converted.payload);
        setImportMode("merge");
        setImportIds(null);
        setConfirmStep(true);
        return;
      }
      setImportFile({ name: file.name, encrypted: isEncryptedBackup(parsed), parsed });
      setDialog("import");
      setImportPass("");
      setImportMode("replace");
      setImportIds(null);
      try {
        const status = await rpcCall("backup.status", {});
        if (mounted.current) setBackupStatus(status || null);
      } catch (caught) {
        console.warn("[jet-hub] backup.status failed:", caught);
      }
    } catch (caught) {
      console.error("[jet-hub] read backup file failed:", caught);
      safeNotice({ tone: "error", text: `读取文件失败：${caught?.message || "未知错误"}` });
    }
  };
  const stepImport = async () => {
    if (!importFile) return;
    if (importFile.encrypted) {
      if (importPass.length === 0) {
        safeNotice({ tone: "warn", text: "请输入备份口令" });
        return;
      }
      setBusy(true);
      setNotice(null);
      try {
        const payload = await decryptBackup(importFile.parsed, importPass);
        if (!mounted.current) return;
        setDecryptedPayload(payload);
      } catch (caught) {
        console.error("[jet-hub] backup decrypt failed:", caught);
        safeNotice({ tone: "error", text: "解密失败：口令错误或备份文件已被篡改" });
        setBusy(false);
        return;
      }
      setBusy(false);
    } else {
      setDecryptedPayload(importFile.parsed);
    }
    setConfirmStep(true);
    setNotice(null);
  };
  const confirmImport = async () => {
    const payload = decryptedPayload;
    if (!payload) return;
    setBusy(true);
    setNotice(null);
    try {
      const allBackupIds = describeBackupAccounts(payload).map((entry2) => entry2.id);
      const targetIds = importIds === null ? allBackupIds : Array.from(importIds);
      if (importMode === "merge" && targetIds.length === 0) {
        safeNotice({ tone: "warn", text: "请至少勾选一个要导入的账号" });
        setBusy(false);
        return;
      }
      const outgoing = importMode === "merge" ? trimBackupPayload(payload, targetIds) : payload;
      const res = await rpcCall("backup.import", importMode === "merge" ? { payload: outgoing, mode: "merge" } : { payload: outgoing });
      const parts = importMode === "merge" ? [`新增 ${res.accountsImported ?? 0} 个账号`] : [`已导入 ${res.accountsImported} 个账号`];
      parts.push(`${res.credentialsImported} 条凭据`);
      if (importMode === "merge" && Array.isArray(res.accountsSkipped) && res.accountsSkipped.length > 0) {
        parts.push(`${res.accountsSkipped.length} 个账号已存在（已跳过，未覆盖）`);
      }
      if (res.skipped.length > 0) parts.push(`${res.skipped.length} 条凭据跳过`);
      if (res.expiredAccounts > 0) {
        parts.push(`${res.expiredAccounts} 个凭据已过期（失效账号需重新登录）`);
      }
      if (res.missingCredentials > 0) {
        parts.push(`${res.missingCredentials} 个账号凭据缺失（需重新登录）`);
      }
      onImported?.();
      safeNotice({ tone: "ok", text: parts.join("，") });
    } catch (caught) {
      console.error("[jet-hub] backup import failed:", caught);
      safeNotice({ tone: "error", text: `导入失败：${caught?.message || "未知错误"}` });
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const renderAccountPicker = (entries, ids, setIds, emptyHint) => {
    if (!Array.isArray(entries) || entries.length === 0) {
      return React3.createElement("p", { className: "dim-jh-modalHint" }, emptyHint);
    }
    const allSelected = ids === null;
    const toggleOne = (id) => {
      const base = new Set(ids === null ? entries.map((entry2) => entry2.id) : ids);
      if (base.has(id)) base.delete(id);
      else base.add(id);
      setIds(base);
    };
    return React3.createElement(
      "div",
      { className: "dim-jh-accountPick" },
      React3.createElement(
        "label",
        { className: "dim-jh-checkRow" },
        React3.createElement("input", {
          type: "checkbox",
          checked: allSelected,
          onChange: (event) => setIds(event.target.checked ? null : /* @__PURE__ */ new Set())
        }),
        `全部账号（${entries.length} 个）`
      ),
      React3.createElement(
        "div",
        { className: "dim-jh-accountPickList" },
        entries.map((entry2) => React3.createElement(
          "label",
          {
            key: entry2.id,
            className: "dim-jh-checkRow dim-jh-accountPickRow"
          },
          React3.createElement("input", {
            type: "checkbox",
            // 「全部」态下每条都显示为选中，用户一取消某条就自动落到逐条模式。
            checked: allSelected || ids.has(entry2.id),
            onChange: () => toggleOne(entry2.id)
          }),
          React3.createElement(
            "span",
            { className: "dim-jh-accountPickName" },
            entry2.nickname || entry2.id,
            React3.createElement(
              "span",
              { className: "dim-jh-accountPickMeta" },
              `${entry2.provider}${entry2.enabled === false ? " · 已停用" : ""}`
            )
          )
        ))
      )
    );
  };
  const renderDialog = () => {
    const isExport = dialog === "export";
    const title = isExport ? "导出备份" : "导入备份";
    const subtitle = isExport ? "全部或选中的账号密钥与凭据" : importFile?.name || "";
    const body = isExport ? React3.createElement(
      React3.Fragment,
      null,
      React3.createElement(
        "p",
        { className: "dim-jh-modalHint" },
        "备份文件包含账号的密钥与 refresh_token，请",
        React3.createElement("strong", { className: "dim-jh-emph-warn" }, "妥善保管"),
        "。"
      ),
      React3.createElement(
        "p",
        { className: "dim-jh-modalHint" },
        "备份是导出时刻的凭据快照：refresh_token 会随续期轮换或过期，建议导出后尽快迁移，导入后失效的账号需重新登录。"
      ),
      renderAccountPicker(
        backupStatus?.accountList,
        exportIds,
        setExportIds,
        "读取账号列表失败，将导出全部账号。"
      ),
      React3.createElement(
        "label",
        { className: "dim-jh-checkRow" },
        React3.createElement("input", {
          type: "checkbox",
          checked: encrypt,
          onChange: (event) => setEncrypt(event.target.checked)
        }),
        "加密备份文件（推荐）"
      ),
      encrypt ? React3.createElement(
        "div",
        { className: "dim-jh-formRows" },
        React3.createElement("input", {
          className: "dim-jh-input",
          type: "password",
          placeholder: "备份口令（用于解密，请牢记）",
          value: pass1,
          onChange: (event) => setPass1(event.target.value)
        }),
        React3.createElement("input", {
          className: "dim-jh-input",
          type: "password",
          placeholder: "再次输入口令",
          value: pass2,
          onChange: (event) => setPass2(event.target.value)
        })
      ) : null
    ) : !isExport && confirmStep ? (
      // 导入确认页（应用内二次确认）：模式选择 + 覆盖警告 / 追加说明
      React3.createElement(
        React3.Fragment,
        null,
        // 第三方账号列表的转换摘要：让用户先确认「识别到了几条、都是谁」，
        // 再决定导入。没有这段提示时，用户会怀疑文件没被读进去。
        importFile?.converted ? React3.createElement(
          React3.Fragment,
          null,
          React3.createElement(
            "p",
            { className: "dim-jh-modalHint" },
            "已自动识别为",
            React3.createElement("strong", { className: "dim-jh-emph-warn" }, "第三方账号列表"),
            "并转换为插件格式：共 ",
            React3.createElement("strong", { className: "dim-jh-emph-warn" }, `${importFile.converted.count}`),
            " 个账号",
            importFile.converted.providers?.length > 0 ? `（${importFile.converted.providers.join("、")}）` : "",
            "。"
          ),
          importFile.converted.warnings?.length > 0 ? React3.createElement(
            "p",
            { className: "dim-jh-modalHint" },
            `${importFile.converted.warnings.length} 条记录被跳过：`,
            importFile.converted.warnings.slice(0, 3).join("；"),
            importFile.converted.warnings.length > 3 ? " …" : ""
          ) : null
        ) : null,
        React3.createElement(
          "div",
          { className: "dim-jh-modePick" },
          React3.createElement(
            "label",
            { className: "dim-jh-checkRow" },
            React3.createElement("input", {
              type: "radio",
              name: "dim-jh-import-mode",
              checked: importMode === "replace",
              onChange: () => setImportMode("replace")
            }),
            "整体还原（覆盖当前全部账号）"
          ),
          React3.createElement(
            "label",
            { className: "dim-jh-checkRow" },
            React3.createElement("input", {
              type: "radio",
              name: "dim-jh-import-mode",
              checked: importMode === "merge",
              onChange: () => setImportMode("merge")
            }),
            "单独导入（只增加账号，不覆盖现有账号）"
          )
        ),
        importMode === "replace" ? React3.createElement(
          React3.Fragment,
          null,
          React3.createElement(
            "p",
            { className: "dim-jh-modalHint" },
            "导入将",
            React3.createElement("strong", { className: "dim-jh-emph-danger" }, "覆盖"),
            "当前全部账号与模型开关（共 ",
            React3.createElement("strong", { className: "dim-jh-emph-warn" }, `${decryptedPayload?.accounts?.length ?? 0}`),
            " 个账号），且",
            React3.createElement("strong", { className: "dim-jh-emph-danger" }, "不可撤销"),
            "。"
          ),
          backupStatus?.withoutExpiry > 0 ? React3.createElement(
            "p",
            { className: "dim-jh-modalHint" },
            "当前有 ",
            React3.createElement("strong", { className: "dim-jh-emph-warn" }, `${backupStatus.withoutExpiry}`),
            " 个账号缺少有效期信息（可能是版本切换后自动恢复的），导入将",
            React3.createElement("strong", { className: "dim-jh-emph-warn" }, "整体覆盖"),
            "它们。"
          ) : null
        ) : React3.createElement(
          React3.Fragment,
          null,
          React3.createElement(
            "p",
            { className: "dim-jh-modalHint" },
            "只把选中的账号",
            React3.createElement("strong", { className: "dim-jh-emph-warn" }, "追加"),
            "到当前账号池：同 id 的账号",
            React3.createElement("strong", { className: "dim-jh-emph-warn" }, "自动跳过、不会被覆盖"),
            "，现有账号、模型开关与锁定状态都不受影响。"
          ),
          renderAccountPicker(
            describeBackupAccounts(decryptedPayload),
            importIds,
            setImportIds,
            "该备份文件里没有账号。"
          )
        )
      )
    ) : importFile?.encrypted ? React3.createElement(
      React3.Fragment,
      null,
      React3.createElement(
        "p",
        { className: "dim-jh-modalHint" },
        "该备份已加密，请输入导出时设置的口令。"
      ),
      React3.createElement("input", {
        className: "dim-jh-input",
        type: "password",
        placeholder: "备份口令",
        value: importPass,
        onChange: (event) => setImportPass(event.target.value)
      })
    ) : React3.createElement(
      "p",
      { className: "dim-jh-modalHint" },
      "该备份为明文文件，点「下一步」后选择导入方式（整体还原或单独导入）。"
    );
    return React3.createElement(
      "div",
      {
        className: "dim-jh-modalOverlay",
        onClick: (event) => {
          if (event.target === event.currentTarget) closeDialog();
        }
      },
      React3.createElement(
        "div",
        {
          className: "dim-jh-modal",
          role: "dialog",
          "aria-modal": "true",
          "aria-label": title
        },
        React3.createElement(
          "div",
          { className: "dim-jh-modalHead" },
          React3.createElement(
            "div",
            { className: "dim-jh-modalTitle" },
            React3.createElement("strong", null, title),
            subtitle.length > 0 ? React3.createElement("span", { className: "dim-jh-modalSubtitle" }, subtitle) : null
          ),
          React3.createElement(
            "div",
            { className: "dim-jh-modelPanelActions" },
            React3.createElement("button", {
              className: "dim-jh-btn",
              onClick: closeDialog
            }, "关闭")
          )
        ),
        React3.createElement(
          "div",
          { className: "dim-jh-modalBody" },
          body,
          notice ? React3.createElement("div", {
            className: "dim-jh-probeNotice",
            "data-tone": notice.tone,
            role: notice.tone === "error" ? "alert" : "status"
          }, React3.createElement("div", null, notice.text)) : null,
          React3.createElement(
            "div",
            { className: "dim-jh-modalActions" },
            isExport ? React3.createElement("button", {
              className: "dim-jh-btn",
              "data-kind": "primary",
              disabled: busy,
              onClick: () => void doExport()
            }, busy ? "生成中…" : "生成备份文件") : confirmStep ? React3.createElement(
              React3.Fragment,
              null,
              React3.createElement("button", {
                className: "dim-jh-btn",
                disabled: busy,
                onClick: () => {
                  setConfirmStep(false);
                  setNotice(null);
                }
              }, "返回"),
              React3.createElement("button", {
                className: "dim-jh-btn",
                "data-kind": "primary",
                disabled: busy,
                onClick: () => void confirmImport()
              }, busy ? "导入中…" : "确认导入")
            ) : React3.createElement("button", {
              className: "dim-jh-btn",
              "data-kind": "primary",
              disabled: busy,
              onClick: () => void stepImport()
            }, busy ? "处理中…" : "下一步")
          )
        )
      )
    );
  };
  return React3.createElement(
    React3.Fragment,
    null,
    React3.createElement("button", {
      className: "dim-jh-btn",
      title: "导出账号的密钥与凭据（全部或勾选其中几个），便于迁移或单独搬一个账号。",
      onClick: () => void openExportDialog()
    }, "备份"),
    React3.createElement("button", {
      className: "dim-jh-btn",
      title: "从备份文件导入账号：可选「整体还原（会覆盖当前全部账号）」或「单独导入（只增加账号，不覆盖）」。",
      onClick: () => fileRef.current?.click()
    }, "恢复"),
    React3.createElement("input", {
      ref: fileRef,
      type: "file",
      accept: ".json,application/json",
      style: { display: "none" },
      onChange: onFileSelected
    }),
    dialog !== null ? renderDialog() : null
  );
}
function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1e3);
}
function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}
function providerRowSummary(row) {
  if (row.models === null && row.accounts === null) return "状态尚未读取";
  return row.accounts ? `账号 ${row.accounts.total ?? 0}（启用 ${row.accounts.enabled ?? 0}）` : "账号 —";
}
function ProviderSwitchPanel({ providers, statuses, statusFailed, busyIds, onToggle, onReload, onClose, order, onCommitOrder, reordering, notice, rpcCall }) {
  React3.useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  const [draggingId, setDraggingId] = React3.useState(null);
  const [dropTargetId, setDropTargetId] = React3.useState(null);
  const [dropPosition, setDropPosition] = React3.useState("before");
  const [view, setView] = React3.useState("switches");
  const rows = providerSwitchRows(providers, statuses, order);
  const summary = providerToggleSummary(providers, statuses);
  const countText = summary.known ? `共 ${summary.total} 个，已打开 ${summary.open}，已关闭 ${summary.closed}` : statusFailed ? "状态读取失败" : "正在读取状态…";
  const dragEnabled = (rows.filter((row) => row.checked).length >= 2 || rows.filter((row) => !row.checked).length >= 2) && busyIds.size === 0 && !reordering;
  const dragPropsFor = (row) => {
    if (!dragEnabled) return { enabled: false };
    return {
      enabled: true,
      isDragging: draggingId === row.id,
      isDropTarget: dropTargetId === row.id && draggingId !== null && draggingId !== row.id,
      dropPosition,
      onDragStart: (event) => {
        setDraggingId(row.id);
        try {
          event.dataTransfer.setData("text/plain", row.id);
        } catch {
        }
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      },
      onDragEnd: () => {
        setDraggingId(null);
        setDropTargetId(null);
      },
      onDragOver: (event) => {
        if (draggingId === null || draggingId === row.id) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        if (dropTargetId !== row.id) setDropTargetId(row.id);
        const rect = event.currentTarget?.getBoundingClientRect?.();
        const next = dropPositionFromPointer(event.clientY, rect);
        if (next !== dropPosition) setDropPosition(next);
      },
      onDrop: (event) => {
        event.preventDefault();
        const sourceId = draggingId;
        setDraggingId(null);
        setDropTargetId(null);
        if (sourceId === null || sourceId === row.id) return;
        const openIds = rows.filter((r) => r.checked).map((r) => r.id);
        const closedIds = rows.filter((r) => !r.checked).map((r) => r.id);
        const next = nextProviderOrderAfterGroupDrop(
          openIds,
          closedIds,
          sourceId,
          row.id,
          dropPosition,
          order
        );
        if (next !== null) void onCommitOrder(next);
      }
    };
  };
  return React3.createElement(
    "div",
    {
      // 遮罩层：垂直居中（2026-10-26 起全仓弹窗统一居中，`--top` 修饰类已删除）。
      className: "dim-jh-modalOverlay",
      onClick: (event) => {
        if (event.target === event.currentTarget) onClose();
      }
    },
    React3.createElement(
      "div",
      {
        className: "dim-jh-modal",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": "供应商开关"
      },
      React3.createElement(
        "div",
        { className: "dim-jh-modalHead" },
        React3.createElement(
          "div",
          { className: "dim-jh-modalTitle" },
          React3.createElement("strong", null, view === "models" ? "供应商模型列表" : "供应商开关"),
          React3.createElement(
            "span",
            { className: "dim-jh-modelPanelCount" },
            view === "models" ? "跨供应商统一管理" : countText
          )
        ),
        React3.createElement(
          "div",
          { className: "dim-jh-modelPanelActions" },
          // 两屏共用一个弹窗（见上面 `view` 的注释）。复用 `.dim-jh-modelStatusFilter`
          // 那套 `[data-active="true"]` 高亮样式，不新增样式类。
          React3.createElement(
            "div",
            {
              className: "dim-jh-modelStatusFilter",
              role: "group",
              "aria-label": "弹窗视图"
            },
            [["switches", "开关"], ["models", "模型列表"]].map(([value, label]) => React3.createElement("button", {
              key: value,
              className: "dim-jh-btn",
              "data-active": view === value ? "true" : "false",
              "aria-pressed": view === value ? "true" : "false",
              title: value === "models" ? "在同一个弹窗里管理全部供应商的模型开关（按需读取目录，不一次拉全部）" : "逐个打开/关闭供应商",
              onClick: () => setView(value)
            }, label))
          ),
          React3.createElement("button", {
            className: "dim-jh-btn",
            title: "重新读取各供应商的模型数与账号数。",
            onClick: () => void onReload()
          }, "刷新"),
          React3.createElement("button", {
            className: "dim-jh-btn",
            "data-kind": "primary",
            onClick: onClose
          }, "完成")
        )
      ),
      view === "models" ? null : React3.createElement(
        "p",
        { className: "dim-jh-modalHint" },
        "关闭一个供应商 = 关闭它的全部模型（从对话框的模型选择里移除）并停用它的全部账号；打开则恢复。关闭前会再确认一次。没有可关闭模型的供应商会被禁用（服务端也会拒绝）。拖动可自定义顺序（顺序只保存在本机）；已打开与已关闭各自排序，组间先后不变。"
      ),
      // ⚠️ 供应商相关的提示必须在**这里**（弹窗内）显示，不能只挂在页面层：
      // 拖拽与开关切换都发生在弹窗打开期间，而弹窗遮罩是 fixed + z-index 3000，
      // 页面层的 notice 会被它整个盖住 —— 用户只会看到「操作没生效，却什么提示都没有」。
      // ⚠️ 弹窗开着时**显示全部** notice（含 toggleProvider 的结果/失败提示）——
      // 它们此刻在页面层同样被遮住，只按 inModal 过滤会让切换结果一样消失。
      // 弹窗关闭即不挂载、页面层那条照旧渲染，两边不会重复出现。
      // 复用既有 `.dim-jh-probeNotice` + `.dim-jh-modal .dim-jh-probeNotice` 样式，不新增样式。
      notice ? React3.createElement("div", {
        className: "dim-jh-probeNotice",
        "data-tone": notice.tone,
        role: notice.tone === "error" ? "alert" : "status"
      }, React3.createElement("div", null, notice.text)) : null,
      React3.createElement(
        "div",
        { className: "dim-jh-modalBody" },
        view === "models" ? React3.createElement(ModelCenterPanel, { providers, rpcCall, statuses }) : React3.createElement(
          "div",
          { className: "dim-jh-modelList" },
          rows.map((row) => {
            const busy = busyIds.has(row.id);
            const action = row.checked ? "关闭" : "打开";
            const drag = dragPropsFor(row);
            return React3.createElement(
              "label",
              {
                key: row.id,
                className: "dim-jh-modelRow",
                // 与模型列表同语义：`data-disabled` 表示**这一项已被关闭**（整行淡出），
                // 不是「这行点不动」—— 点不动由下面 input 的 disabled 表达。
                "data-disabled": row.checked ? "false" : "true",
                // 拖拽排序（与账号卡片同款视觉语言）：源行淡出、落点行画插入线。
                draggable: drag.enabled ? "true" : void 0,
                onDragStart: drag.onDragStart,
                onDragEnd: drag.onDragEnd,
                onDragOver: drag.onDragOver,
                onDrop: drag.onDrop,
                "data-dragging": drag.isDragging ? "true" : void 0,
                "data-dropBefore": drag.isDropTarget && drag.dropPosition !== "after" ? "true" : void 0,
                "data-dropAfter": drag.isDropTarget && drag.dropPosition === "after" ? "true" : void 0,
                title: row.disabled ? row.reason : `${action}「${row.label}」：${action}它的全部模型并${row.checked ? "停用" : "启用"}全部账号`
              },
              drag.enabled ? React3.createElement("span", {
                className: "dim-jh-dragHandle",
                title: "拖动以调整顺序（顺序只保存在本机）",
                "aria-hidden": "true",
                // ⚠️ 行容器是 <label>：点柄的 click 会沿 label 激活开关。preventDefault
                // 掐掉这条激活路径 —— 拖柄不是开关，点了不该有开关反应（拖拽本身
                // 不经过 click，互不影响）。
                onClick: (event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }
              }, "⠿") : null,
              // ⚠️ 供应商图标：左栏 rail 里一直有（同一个 `ProviderLogo`），
              //    但这个**供应商弹窗**里的同一批清单从来没有 —— 两处列的是同一份
              //    PROVIDERS，一有一无，用户在弹窗里只能靠读名字认供应商。
              //    图标走 `row.id`（就是 provider id），与 `data-provider` 同源。
              React3.createElement(ProviderLogo, { provider: row.id }),
              React3.createElement(
                "span",
                { className: "dim-jh-modelInfo" },
                React3.createElement("strong", { className: "dim-jh-modelName" }, row.label),
                React3.createElement("code", { className: "dim-jh-modelId" }, providerRowSummary(row))
              ),
              React3.createElement("input", {
                type: "checkbox",
                className: "dim-jh-switch",
                role: "switch",
                checked: row.checked,
                // busy 只锁被点的那一行：状态是服务端推导的，锁整表会让用户以为全挂了。
                disabled: row.disabled || busy,
                "aria-label": `${action} ${row.label}`,
                onChange: () => void onToggle(row.id, !row.checked)
              })
            );
          })
        )
      )
    )
  );
}
function ModelCenterPanel({ providers, rpcCall, statuses }) {
  const [states, setStates] = React3.useState({});
  const [query, setQuery] = React3.useState("");
  const [statusFilter, setStatusFilter] = React3.useState("all");
  const [openIds, setOpenIds] = React3.useState({});
  const [busyIds, setBusyIds] = React3.useState(() => /* @__PURE__ */ new Set());
  const [providerBusy, setProviderBusy] = React3.useState(() => /* @__PURE__ */ new Set());
  const [toggleError, setToggleError] = React3.useState("");
  const [toggleWarnings, setToggleWarnings] = React3.useState([]);
  const [loadingAll, setLoadingAll] = React3.useState(false);
  const mounted = React3.useRef(true);
  React3.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const loadProvider = React3.useCallback(async (providerId) => {
    setStates((prev) => {
      if (prev[providerId]?.phase === "ready") return prev;
      return { ...prev, [providerId]: { phase: "loading", models: [], error: "" } };
    });
    try {
      const result = await rpcCall("model.list", { provider: providerId });
      if (!mounted.current) return;
      setStates((prev) => ({
        ...prev,
        [providerId]: {
          phase: "ready",
          // 服务端下发的是**未过滤全量**（含被关掉的和已下架的），这里原样收下：
          // 用过滤后的目录回填会让被关过的模型连开关一起消失（只能改 settings.yaml 才能救回）。
          models: Array.isArray(result?.models) ? result.models : [],
          error: ""
        }
      }));
    } catch (error) {
      if (!mounted.current) return;
      setStates((prev) => ({
        ...prev,
        [providerId]: { phase: "error", models: [], error: error?.message || String(error) }
      }));
    }
  }, [rpcCall]);
  const filtering = isFilterActive({ query, status: statusFilter });
  const sections = visibleCenterSections(providers, states, { query, status: statusFilter });
  const totals = centerTotals(providers, states);
  const pending = centerPendingProviderIds(providers, states);
  const providerCount = Array.isArray(providers) ? providers.length : 0;
  const isOpen = (providerId) => {
    if (Object.prototype.hasOwnProperty.call(openIds, providerId)) return openIds[providerId] === true;
    return filtering && states[providerId]?.phase === "ready";
  };
  React3.useEffect(() => {
    for (const section of sections) {
      if (section.phase !== "idle") continue;
      if (!isOpen(section.id)) continue;
      void loadProvider(section.id);
    }
  }, [sections, openIds, filtering, loadProvider, states]);
  const busyKey = (providerId, modelId) => `${providerId}::${modelId}`;
  const resetFilters = () => {
    setQuery("");
    setStatusFilter("all");
  };
  const toggleSection = (providerId) => {
    setOpenIds((prev) => ({ ...prev, [providerId]: !isOpen(providerId) }));
  };
  const toggleModel = async (providerId, modelId, disabled) => {
    setToggleError("");
    setToggleWarnings([]);
    const key = busyKey(providerId, modelId);
    setBusyIds((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
    try {
      const result = await rpcCall("model.setDisabled", { provider: providerId, modelId, disabled });
      if (!mounted.current) return;
      setToggleWarnings(Array.isArray(result?.warnings) ? result.warnings : []);
      setStates((prev) => {
        const state = prev[providerId];
        if (state === void 0 || state.phase !== "ready") return prev;
        return {
          ...prev,
          [providerId]: {
            ...state,
            models: state.models.map((model) => model.id === modelId ? { ...model, disabled } : model)
          }
        };
      });
    } catch (error) {
      if (mounted.current) setToggleError(`「${modelId}」切换失败：${error?.message || String(error)}`);
    } finally {
      if (mounted.current) {
        setBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    }
  };
  const restoreModel = async (providerId, modelId) => {
    setToggleError("");
    const key = busyKey(providerId, modelId);
    setBusyIds((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
    try {
      await rpcCall("model.clearDead", { provider: providerId, modelId });
      await loadProvider(providerId);
    } catch (error) {
      if (mounted.current) setToggleError(`「${modelId}」恢复失败：${error?.message || String(error)}`);
    } finally {
      if (mounted.current) {
        setBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    }
  };
  const setProviderAll = async (providerId, label, disabled) => {
    if (disabled && !confirm(`确认关闭「${label}」的全部模型？它们会从对话框的模型选择里消失；取消则不做任何变更。`)) return;
    setToggleError("");
    setToggleWarnings([]);
    setProviderBusy((prev) => {
      const next = new Set(prev);
      next.add(providerId);
      return next;
    });
    try {
      const result = await rpcCall("model.setAllDisabled", {
        provider: providerId,
        disabled,
        closeProvider: false
      });
      if (mounted.current) setToggleWarnings(Array.isArray(result?.warnings) ? result.warnings : []);
      await loadProvider(providerId);
    } catch (error) {
      if (mounted.current) setToggleError(`批量切换「${label}」失败：${error?.message || String(error)}`);
    } finally {
      if (mounted.current) {
        setProviderBusy((prev) => {
          const next = new Set(prev);
          next.delete(providerId);
          return next;
        });
      }
    }
  };
  const loadAll = async () => {
    const queue = centerPendingProviderIds(providers, states);
    if (queue.length === 0) return;
    setLoadingAll(true);
    const concurrency = 3;
    let cursor = 0;
    const worker = async () => {
      while (cursor < queue.length) {
        const providerId = queue[cursor];
        cursor += 1;
        await loadProvider(providerId);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()));
    if (mounted.current) setLoadingAll(false);
  };
  const renderSection = (section) => {
    const opened = isOpen(section.id);
    const sectionBusy = providerBusy.has(section.id);
    const providerClosed = statuses?.[section.id]?.closed === true;
    const phrase = section.phase === "error" ? "读取失败" : !section.loaded ? section.phase === "loading" ? "正在读取…" : "未读取" : `${section.summary.total} 个 · 已关闭 ${section.summary.disabled}` + (section.summary.dead > 0 ? ` · 已下架 ${section.summary.dead}` : "");
    const countText = providerClosed ? `${phrase}（该供应商已关闭）` : phrase;
    const bulk = centerBulkState(section.models);
    const allDisabled = section.loaded && bulk.allDisabled;
    const noneDisabled = section.loaded && bulk.noneDisabled;
    return React3.createElement(
      "div",
      { key: section.id, className: "dim-jh-modelGroup" },
      React3.createElement(
        "div",
        { className: "dim-jh-modelGroupHead" },
        React3.createElement("button", {
          className: "dim-jh-modelGroupToggle",
          "aria-expanded": opened ? "true" : "false",
          title: opened ? "收起该供应商的模型" : "展开并读取该供应商的模型列表",
          onClick: () => toggleSection(section.id)
        }, `${opened ? "▾" : "▸"} ${section.label}`),
        React3.createElement("span", { className: "dim-jh-modelGroupCount" }, countText),
        React3.createElement("button", {
          className: "dim-jh-btn dim-jh-modelGroupBtn",
          disabled: !section.loaded || sectionBusy || noneDisabled,
          title: noneDisabled ? "该供应商没有已关闭的模型" : "打开该供应商的全部模型（含之前关闭的）",
          onClick: () => void setProviderAll(section.id, section.label, false)
        }, sectionBusy ? "处理中…" : "全开"),
        React3.createElement("button", {
          className: "dim-jh-btn dim-jh-modelGroupBtn",
          disabled: !section.loaded || sectionBusy || allDisabled,
          title: allDisabled ? "该供应商的模型已全部关闭" : "关闭该供应商的全部模型",
          onClick: () => void setProviderAll(section.id, section.label, true)
        }, sectionBusy ? "处理中…" : "全关")
      ),
      opened ? React3.createElement(
        "div",
        { className: "dim-jh-modelGroupBody" },
        section.phase === "error" ? React3.createElement(
          "div",
          { className: "dim-jh-empty" },
          React3.createElement("p", null, states[section.id]?.error || "读取该供应商的模型列表失败。"),
          React3.createElement("button", {
            className: "dim-jh-btn",
            onClick: () => void loadProvider(section.id)
          }, "重新读取")
        ) : !section.loaded ? React3.createElement("p", { className: "dim-jh-modalHint" }, "正在读取该供应商的模型列表…") : section.summary.total === 0 ? React3.createElement("p", { className: "dim-jh-modalHint" }, "该 Provider 当前没有可用的模型。") : section.models.length === 0 ? React3.createElement(
          "div",
          { className: "dim-jh-empty" },
          React3.createElement("p", null, "没有符合当前搜索与筛选条件的模型。"),
          React3.createElement("button", { className: "dim-jh-btn", onClick: resetFilters }, "清空筛选")
        ) : section.models.map((model) => React3.createElement(ModelToggle, {
          key: model.id,
          // 模型中心**横跨全部供应商**，故图标必须按**分组所属**
          // 的那家取（`section.id`）。这里没有外层 `provider`
          // 可用 —— 也不能用当前选中的供应商，那会让每一行都
          // 顶着同一枚图标。
          provider: section.id,
          model,
          busy: sectionBusy || busyIds.has(busyKey(section.id, model.id)),
          onToggle: (modelId, disabled) => void toggleModel(section.id, modelId, disabled),
          onRestore: (modelId) => void restoreModel(section.id, modelId)
        }))
      ) : null
    );
  };
  return React3.createElement(
    "div",
    null,
    React3.createElement(
      "div",
      { className: "dim-jh-modelFilterBar" },
      React3.createElement("input", {
        type: "search",
        className: "dim-jh-input dim-jh-modelSearch",
        placeholder: "搜索供应商、模型名或 id…",
        "aria-label": "搜索供应商或模型",
        value: query,
        onChange: (event) => setQuery(event.target.value)
      }),
      React3.createElement(
        "div",
        {
          className: "dim-jh-modelStatusFilter",
          role: "group",
          "aria-label": "按模型开关状态筛选"
        },
        [["all", "全部"], ["enabled", "已打开"], ["disabled", "已关闭"]].map(([value, label]) => React3.createElement("button", {
          key: value,
          className: "dim-jh-btn",
          "data-active": statusFilter === value ? "true" : "false",
          "aria-pressed": statusFilter === value ? "true" : "false",
          onClick: () => setStatusFilter(value)
        }, label))
      ),
      filtering ? React3.createElement("button", { className: "dim-jh-btn", onClick: resetFilters }, "清空筛选") : null,
      React3.createElement("button", {
        className: "dim-jh-btn",
        title: "读取所有还没读过的供应商目录（并发 3 个，避免同时打爆上游）。",
        disabled: loadingAll || pending.length === 0,
        onClick: () => void loadAll()
      }, loadingAll ? "读取中…" : `加载全部${pending.length > 0 ? `（${pending.length}）` : ""}`)
    ),
    React3.createElement(
      "p",
      { className: "dim-jh-modalHint" },
      `已读取 ${totals.loaded} / ${providerCount} 家` + (totals.loaded === 0 ? "。展开某一家，或点「加载全部」。" : `：共 ${totals.total} 个模型，已关闭 ${totals.disabled} 个。`) + "关闭开关后该模型不再出现在对话框的模型选择里；「已下架」的模型是上游移除的，可用「重新显示」恢复。未读取的供应商不参与搜索，点「加载全部」补齐。"
    ),
    toggleError ? React3.createElement("div", {
      className: "dim-jh-probeNotice",
      "data-tone": "error",
      role: "alert"
    }, React3.createElement("div", null, toggleError)) : null,
    // `warn` 必须是这个拼写：写成 `warning` 会静默落成中性色（`data-tone` 是枚举）。
    toggleWarnings.length > 0 ? React3.createElement("div", {
      className: "dim-jh-probeNotice",
      "data-tone": "warn",
      role: "status"
    }, React3.createElement("div", null, toggleWarnings.join("；"))) : null,
    React3.createElement(
      "div",
      { className: "dim-jh-modelList" },
      sections.length === 0 ? React3.createElement(
        "div",
        { className: "dim-jh-empty" },
        React3.createElement("p", null, "没有符合当前搜索与筛选条件的供应商。"),
        React3.createElement("button", { className: "dim-jh-btn", onClick: resetFilters }, "清空筛选")
      ) : sections.map((section) => renderSection(section))
    )
  );
}
function GatewayModelRow({ model }) {
  const badge = modelCapabilityBadge(model);
  return React3.createElement(
    "div",
    {
      className: "dim-jh-gatewayModelRow",
      // tooltip = 完整 ID（可直接选中复制）+ 展示名，截图/复制时信息不丢。
      title: `${model.id}
${model.name || ""}`.trim()
    },
    React3.createElement("code", { className: "dim-jh-modelId" }, gatewayModelKeyOf(model)),
    React3.createElement("span", { className: "dim-jh-modelName" }, model.name || model.id),
    badge ? React3.createElement("span", { className: "dim-jh-modelBadge", title: "该模型接受图片输入。" }, badge) : null
  );
}
function GatewayEffortRow({ row }) {
  return React3.createElement(
    "div",
    {
      className: "dim-jh-effortRow",
      title: `${row.id}
真实档位：${row.declared}
客户端该填：${row.fill}`
    },
    React3.createElement(
      "div",
      { className: "dim-jh-effortHead" },
      // 卡片头已写明供应商，行内显示去掉前缀的名字；完整 id 在 tooltip 与复制里。
      React3.createElement("code", { className: "dim-jh-effortModel" }, gatewayModelKeyOf(row)),
      row.lossy ? React3.createElement("span", {
        className: "dim-jh-modelBadge",
        title: "该模型的档位名与 OpenAI 客户端不同名：照 DSH 界面上的名字填，网关会按强度就近翻译。"
      }, "需对照") : null
    ),
    React3.createElement(
      "div",
      { className: "dim-jh-effortLine" },
      React3.createElement("span", { className: "dim-jh-effortLabel" }, "真实档位："),
      row.declared
    ),
    React3.createElement(
      "div",
      { className: "dim-jh-effortLine" },
      React3.createElement("span", { className: "dim-jh-effortLabel" }, "客户端该填："),
      row.fill
    )
  );
}
function GatewayCards({ cards, renderRow, isExpanded, onToggle, onCopy, isCopied, foldSuffix, foldLabel, copyNoun }) {
  return React3.createElement(
    "div",
    { className: "dim-jh-gatewayCards", style: { marginTop: "6px" } },
    cards.map((card) => {
      const expanded = isExpanded(card.provider);
      const label = gatewayCardLabel(card.provider, providerLabel);
      return React3.createElement(
        "div",
        {
          // ⚠️ 供应商 key 拿不到时用 `__unknown__`：`key: ''` 会让 React 报警并可能丢行。
          key: card.provider === "" ? "__unknown__" : card.provider,
          className: "dim-jh-gatewayCard"
        },
        React3.createElement(
          "div",
          { className: "dim-jh-gatewayCardHead" },
          React3.createElement(
            "button",
            {
              className: "dim-jh-gatewayCardToggle",
              "aria-expanded": expanded ? "true" : "false",
              // tooltip 里给出**原始 provider key**：卡片标题是展示名，
              // 而用户要复制进配置的是 ID 里的那个 key，两者可能不同。
              title: card.provider === "" ? "这些条目没有回传供应商字段（上游数据异常），仍照实列出。" : `供应商 key：${card.provider}（模型 ID 的前缀就是它）`,
              onClick: () => onToggle(card.provider)
            },
            `${expanded ? "▾" : "▸"} `,
            // ⚠️ 图标放在**按钮内部**（不是按钮旁边）：标题与图标要作为一个整体
            //    被点击/换行。放外面时窄屏换行会把图标甩到上一行去。
            //    `card.provider` 可能是空串（上游没回传供应商字段，卡片标题回落
            //    到兜底名）—— `ProviderLogo` 对未知 id 返回 null，正好不留空位。
            React3.createElement(ProviderLogo, { provider: card.provider }),
            ` ${label}`
          ),
          React3.createElement(
            "span",
            { className: "dim-jh-gatewayCardCount" },
            card.counts.fold > 0 && foldLabel !== "" ? `${card.counts.total} ${foldSuffix} · ${card.counts.fold} 个${foldLabel}` : `${card.counts.total} ${foldSuffix}`
          ),
          React3.createElement("button", {
            className: "dim-jh-btn dim-jh-gatewayCardBtn",
            title: `只复制「${label}」这一家的 ${card.counts.total} ${copyNoun}（每行一个完整 ID）。`,
            onClick: () => onCopy(card)
          }, isCopied(card.provider) ? "已复制 ✓" : "复制本组")
        ),
        expanded ? React3.createElement(
          "div",
          { className: "dim-jh-gatewayCardBody" },
          card.entries.map((entry2, index) => React3.createElement(
            React3.Fragment,
            { key: `${card.provider}#${entry2.id}#${index}` },
            renderRow(entry2)
          ))
        ) : null
      );
    })
  );
}
function GatewayPanel({ status, busy, notice, onToggle, onToggleAllowLan, onReload, onClose }) {
  const [copied, setCopied] = React3.useState(false);
  const [revealed, setRevealed] = React3.useState(false);
  const [modelsOpen, setModelsOpen] = React3.useState(false);
  const [effortsOpen, setEffortsOpen] = React3.useState(false);
  const [modelsQuery, setModelsQuery] = React3.useState("");
  const [effortsQuery, setEffortsQuery] = React3.useState("");
  const [effortsCopied, setEffortsCopied] = React3.useState(false);
  const [idsCopied, setIdsCopied] = React3.useState(false);
  const [modelCardToggles, setModelCardToggles] = React3.useState({});
  const [effortCardToggles, setEffortCardToggles] = React3.useState({});
  const [copiedModelCard, setCopiedModelCard] = React3.useState(null);
  const [copiedEffortCard, setCopiedEffortCard] = React3.useState(null);
  const apiKey = status?.apiKey ?? null;
  const models = status?.models ?? [];
  const modelsFiltering = isFilterActive({ query: modelsQuery });
  const visibleModels = filterModels(models, { query: modelsQuery });
  const modelCards = groupGatewayModels(visibleModels);
  const effortRows = gatewayEffortRows(models);
  const visibleEffortRows = filterEffortRows(effortRows, effortsQuery);
  const effortsFiltering = isFilterActive({ query: effortsQuery });
  const effortCards = groupGatewayEntries(visibleEffortRows, (row) => row.lossy);
  React3.useEffect(() => {
    setCopied(false);
    setRevealed(false);
  }, [status?.apiKey?.value]);
  React3.useEffect(() => {
    setIdsCopied(false);
    setCopiedModelCard(null);
  }, [models.length, modelsQuery]);
  React3.useEffect(() => {
    setEffortsCopied(false);
    setCopiedEffortCard(null);
  }, [models.length, effortsQuery]);
  React3.useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  const handleCopy = async () => {
    if (!apiKey) return;
    const ok = await copyToClipboard(apiKey.value);
    if (ok) {
      setCopied(true);
      return;
    }
    setRevealed(true);
    setCopied(false);
  };
  const handleCopyModelIds = async () => {
    const text = formatModelIdList(visibleModels);
    if (!text) return;
    const ok = await copyToClipboard(text);
    setIdsCopied(ok);
    if (!ok) setModelsOpen(true);
  };
  const handleCopyCardIds = async (card) => {
    const text = formatModelIdList(card.entries);
    if (!text) return;
    const ok = await copyToClipboard(text);
    setCopiedModelCard(ok ? card.provider : null);
    if (!ok) setModelsOpen(true);
  };
  const handleCopyEfforts = async () => {
    const text = gatewayEffortsText(visibleEffortRows);
    if (!text) return;
    const ok = await copyToClipboard(text);
    setEffortsCopied(ok);
    if (!ok) setEffortsOpen(true);
  };
  const handleCopyCardEfforts = async (card) => {
    const text = gatewayEffortsText(card.entries);
    if (!text) return;
    const ok = await copyToClipboard(text);
    setCopiedEffortCard(ok ? card.provider : null);
    if (!ok) setEffortsOpen(true);
  };
  const disabled = gatewaySwitchDisabled(status);
  const action = status?.enabled ? "关闭" : "打开";
  const allowLanDisabled = gatewayAllowLanSwitchDisabled(status);
  const allowLanAction = status?.allowLan ? "关闭" : "打开";
  return React3.createElement(
    "div",
    {
      className: "dim-jh-modalOverlay",
      onClick: (event) => {
        if (event.target === event.currentTarget) onClose();
      }
    },
    React3.createElement(
      "div",
      {
        className: "dim-jh-modal dim-jh-gatewayModal",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": "本机 OpenAI 网关"
      },
      React3.createElement(
        "div",
        { className: "dim-jh-modalHead" },
        React3.createElement(
          "div",
          { className: "dim-jh-modalTitle" },
          React3.createElement("strong", null, "本机 OpenAI 网关")
        ),
        React3.createElement(
          "div",
          { className: "dim-jh-modelPanelActions" },
          React3.createElement("button", {
            className: "dim-jh-btn",
            title: "重新读取网关状态。",
            onClick: () => void onReload()
          }, "刷新"),
          React3.createElement("button", {
            className: "dim-jh-btn",
            "data-kind": "primary",
            onClick: onClose
          }, "完成")
        )
      ),
      React3.createElement(
        "div",
        { className: "dim-jh-modalBody" },
        // ── 第 1 段：开关与连接信息 ──
        // ⚠️ 用户 2026-10-04 要求把三段用**可见的分段**区分开（原话：「这三坨字全混在
        // 一起有点难看清」）。做法是每段包一个 .dim-jh-gatewaySection：
        // 段与段之间用上边框 + 更大的间距分开，段内保持紧凑。
        // ⚠️ 不要用「给每段加不同底色」：弹窗会被截图，色块在深色主题下还要另配一套 token。
        React3.createElement(
          "div",
          { className: "dim-jh-gatewaySection" },
          React3.createElement(
            "label",
            { className: "dim-jh-modelRow" },
            React3.createElement(
              "span",
              { className: "dim-jh-modelInfo" },
              React3.createElement("strong", { className: "dim-jh-modelName" }, "启用本机网关"),
              // ⚠️ 用户 2026-10-04 要求这句只留「在 127.0.0.1 监听，供客户端调用」——
              // 原先列了 Pi / Continue / Cline / OpenCode 四个客户端名，在窄面板下折成两行
              // 且把「打开/关闭」那个动作词挤到很后面。客户端列举属于 README 的内容。
              // ⚠️ **地址必须是动态的**（issue IKL7UN）：host 现在可配（容器化部署下
              // 就是容器桥接 IP），写死 127.0.0.1 会让用户照着抄一个从容器外连不上的
              // 地址 —— 而那正是 issue 报告者踩的坑。未在监听时退回「本机」这一定性
              // 说法（与 gatewayEndpoint 返回 '' 的既有取舍同源：不编造具体地址）。
              React3.createElement(
                "code",
                { className: "dim-jh-modelId" },
                status?.address ? `在 ${status.address.host} 监听，供客户端调用` : "在本机监听，供客户端调用"
              )
            ),
            React3.createElement("input", {
              type: "checkbox",
              className: "dim-jh-switch",
              role: "switch",
              checked: status?.enabled === true,
              // 被 env 停用时禁用而非「点了没反应」：让用户做一次明知无效的操作更困惑。
              disabled: disabled || busy,
              "aria-label": action + "本机网关",
              onChange: () => void onToggle(!(status?.enabled === true))
            })
          ),
          // ── 「允许局域网访问」开关（2026-10-20）──
          // ⚠️ 与主开关同一行结构，但**语义不同**：它改变的是监听地址（127.0.0.1 ↔
          // 0.0.0.0），翻动会触发服务端关闭旧实例并重建换绑；env 显式给了
          // DSH_OPENAI_GATEWAY_HOST 时被禁用（那一刻翻动无效，禁用并说明原因）。
          React3.createElement(
            "label",
            { className: "dim-jh-modelRow" },
            React3.createElement(
              "span",
              { className: "dim-jh-modelInfo" },
              React3.createElement("strong", { className: "dim-jh-modelName" }, "允许局域网访问"),
              React3.createElement(
                "code",
                { className: "dim-jh-modelId" },
                "打开后监听 0.0.0.0，同一局域网的设备可凭 API Key 访问"
              )
            ),
            React3.createElement("input", {
              type: "checkbox",
              className: "dim-jh-switch",
              role: "switch",
              checked: status?.allowLan === true,
              disabled: allowLanDisabled || busy,
              "aria-label": allowLanAction + "「允许局域网访问」",
              onChange: () => void onToggleAllowLan(!(status?.allowLan === true))
            })
          ),
          gatewayAllowLanHint(status) ? React3.createElement("p", {
            key: "allow-lan-hint",
            className: "dim-jh-modalHint dim-jh-gatewayLine"
          }, gatewayAllowLanHint(status)) : null,
          gatewayStatusLines(status).map((line, index) => (
            // ⚠️ 顶部三行是同一段话，用更紧的 .dim-jh-gatewayLine（再叠上弹窗级的
            // 6px 会显得像三段互不相干的内容）。
            React3.createElement("p", {
              key: `status-${index}`,
              className: "dim-jh-modalHint dim-jh-gatewayLine"
            }, line)
          )),
          // 凭据区：默认**不**渲染明文（设置页会被截图/录屏/投屏）。点「复制」直接
          // 进剪贴板；复制失败（无 Clipboard API、非用户手势、权限被拒）则退回显示
          // 明文供手动选中 —— 绝不能变成「点了没反应」。
          //
          // ⚠️ 用户 2026-10-04 要求精简：原先是一行「鉴权用 Authorization: Bearer
          // <网关 API Key>。」+ 下面一排按钮，现改为「API KEY：」与两个按钮**同一行**。
          // Bearer 那半句没丢 —— 它移到了 CC Switch 之外的客户端需要的信息里，见 README
          // 的「鉴权使用」；面板上只留用户真正要抄的两个东西（地址、密钥）。
          apiKey ? React3.createElement(
            "div",
            { className: "dim-jh-gatewayKeyRow", style: { marginTop: "6px" } },
            React3.createElement("span", { className: "dim-jh-modalHint dim-jh-gatewayKeyLabel" }, "API KEY："),
            React3.createElement("button", {
              className: "dim-jh-btn",
              "data-kind": "primary",
              title: "把密钥复制到剪贴板。明文会进入剪贴板历史，注意别在不信任的机器上这么做。",
              onClick: () => void handleCopy()
            }, copied ? "已复制 ✓" : "复制密钥"),
            revealed ? React3.createElement("code", {
              className: "dim-jh-modelId",
              style: { userSelect: "all" }
            }, apiKey.value) : React3.createElement("button", {
              className: "dim-jh-btn",
              title: "自动复制不可用时用它显示明文，供手动选中。",
              onClick: () => setRevealed(true)
            }, "显示明文")
          ) : React3.createElement(
            "p",
            { className: "dim-jh-modalHint" },
            "API KEY：尚未生成（启用网关时会自动创建）。"
          ),
          // ⚠️ 只有拿到密钥时才补这一行来源说明：`apiKey` 为空时上面那句
          // 「尚未生成（启用网关时会自动创建）」已经把事情说完，而
          // `gatewayApiKeyHint(null)` 说的是同一件事 —— 两句并排就是冗余，
          // 与本次「精简臃肿」的目标正好相反。
          apiKey ? React3.createElement("p", { className: "dim-jh-modalHint" }, gatewayApiKeyHint(apiKey)) : null
        ),
        // ── 第 2 段：模型目录 ──
        // 存在的理由：有些 agent（ZCode 等）**不会**主动扫 `/v1/models`，要靠用户
        // 手工把 ID 填进配置。而该端点需要 Bearer 头，浏览器地址栏直接打开只会得到
        // 401 —— 所以清单必须出现在设置页里。
        React3.createElement(
          "div",
          { className: "dim-jh-gatewaySection" },
          React3.createElement(
            "p",
            { className: "dim-jh-gatewaySectionTitle" },
            React3.createElement("strong", null, "模型 ID（可用的完整清单）")
          ),
          React3.createElement("p", { className: "dim-jh-modalHint" }, gatewayModelsHint(models, status?.modelsSource)),
          // ⚠️ `dim-jh-gatewayActions` 是给「下方四个按钮压成与密钥行同款小号」用的钩子
          // （见 jet-hub-styles.js 里与 .dim-jh-gatewayKeyRow 合并的那条规则）。
          // 不能直接改 .dim-jh-modelPanelActions .dim-jh-btn —— 那个类在页头、模型面板、
          // 卡片头等 8 处都在用，改它会把无关页面一起改小。
          React3.createElement(
            "div",
            { className: "dim-jh-modelPanelActions dim-jh-gatewayActions", style: { marginTop: "4px" } },
            React3.createElement("button", {
              className: "dim-jh-btn",
              "data-kind": "primary",
              disabled: visibleModels.length === 0,
              title: "把模型 ID 每行一个复制到剪贴板（每行一个完整 ID；有搜索词时只复制筛出来的那些）。",
              onClick: () => void handleCopyModelIds()
            }, idsCopied ? "已复制 ✓" : `复制全部 ${visibleModels.length} 个 ID`),
            React3.createElement("button", {
              className: "dim-jh-btn",
              "aria-expanded": modelsOpen ? "true" : "false",
              onClick: () => {
                if (modelsOpen) setModelsQuery("");
                setModelsOpen((open) => !open);
              }
            }, modelsOpen ? "收起清单" : "展开清单")
          ),
          modelsOpen ? React3.createElement(
            React3.Fragment,
            null,
            React3.createElement(
              "div",
              { className: "dim-jh-modelFilterBar" },
              React3.createElement("input", {
                type: "search",
                className: "dim-jh-input dim-jh-modelSearch",
                placeholder: "搜索模型 ID 或展示名…",
                value: modelsQuery,
                "aria-label": "搜索模型 ID",
                onChange: (event) => setModelsQuery(event.target.value)
              }),
              modelsFiltering ? React3.createElement("button", {
                className: "dim-jh-btn",
                title: "清空搜索词，恢复完整清单。",
                onClick: () => setModelsQuery("")
              }, "清空搜索") : null
            ),
            visibleModels.length === 0 ? React3.createElement("div", { className: "dim-jh-gatewayEmpty" }, gatewayModelsEmptyHint(modelsQuery)) : React3.createElement(GatewayCards, {
              cards: modelCards,
              renderRow: (model) => React3.createElement(GatewayModelRow, { model }),
              isExpanded: (provider) => gatewayCardExpanded(
                modelCards.find((card) => card.provider === provider),
                // 有搜索词时一律展开：命中结果藏在折叠卡里，用户会以为「搜不到」。
                { toggled: modelCardToggles[provider], searching: modelsFiltering }
              ),
              onToggle: (provider) => setModelCardToggles((prev) => ({
                ...prev,
                [provider]: !gatewayCardExpanded(
                  modelCards.find((card) => card.provider === provider),
                  { toggled: prev[provider], searching: modelsFiltering }
                )
              })),
              onCopy: (card) => void handleCopyCardIds(card),
              isCopied: (provider) => copiedModelCard === provider,
              foldSuffix: "个模型",
              foldLabel: "可发图片",
              copyNoun: "个完整模型 ID"
            })
          ) : null
        ),
        // ── 第 3 段：思考档位对照表 ──
        // 存在的理由：各 provider 的档位 id 是**上游私有值**（TRAE 的 light/extra_high、
        // LobsterAI 的 xhigh（界面上叫 Max）、Cline 的 max（界面上叫 Extra）），而走
        // OpenAI 协议的客户端只有固定 8 档词汇，表达不出这些私有值。用户照 DSH 界面上
        // 的名字填进 CC Switch/Codex，撞 400 且两端都看不出原因。
        // 网关现在按强度自动翻译（填错不再失败），但**精确对应**只有一列答案 —— 就是这里。
        //
        // ⚠️ 数据只含**已开启**的模型（来自适配器 listModels 的黑名单过滤），
        // 故与对话框里的模型选择器同源。
        React3.createElement(
          "div",
          { className: "dim-jh-gatewaySection" },
          React3.createElement(
            "p",
            { className: "dim-jh-gatewaySectionTitle" },
            React3.createElement("strong", null, "思考档位对照表")
          ),
          // ⚠️ 说明**一行一个 p**（与弹窗顶部 gatewayStatusLines 同款做法）。
          // 用户 2026-10-04 第三次报障：这两句原先拼成一整段交给浏览器断行，
          // 于是品牌名被从中间切开 —— 前一行结尾是「CC」、下一行开头是「Switch」。
          // 两句本就各说一件事，各占一行既不会断开品牌名，也更好读。
          gatewayEffortsHintLines(models).map((line, index) => React3.createElement("p", {
            key: `efforts-hint-${index}`,
            className: "dim-jh-modalHint dim-jh-gatewayLine"
          }, line)),
          // ⚠️ 用户 2026-10-04 要求这两个按钮**互换位置**，与模型清单那段保持一致
          //（那边是「复制全部 …」在前、「展开清单」在后）。顺序统一后，
          // 三段里的按钮位置可预期，用户不必每段重新找。
          React3.createElement(
            "div",
            { className: "dim-jh-modelPanelActions dim-jh-gatewayActions", style: { marginTop: "4px" } },
            // 复制的是**当前筛出来的那些行**：用户搜完再复制，拿到的正是屏幕上看到的内容。
            effortRows.length > 0 ? React3.createElement("button", {
              className: "dim-jh-btn",
              "data-kind": "primary",
              title: "把对照表（含真实档位与该填的值）复制到剪贴板。有搜索词时只复制筛出来的行。",
              onClick: () => void handleCopyEfforts()
            }, effortsCopied ? "已复制 ✓" : `复制对照表（${visibleEffortRows.length} 行）`) : null,
            React3.createElement("button", {
              className: "dim-jh-btn",
              "aria-expanded": effortsOpen ? "true" : "false",
              // 没有模型声明档位时禁用而非「点了没反应」：展开一张空表毫无意义。
              disabled: effortRows.length === 0,
              onClick: () => {
                if (effortsOpen) setEffortsQuery("");
                setEffortsOpen((open) => !open);
              }
            }, effortsOpen ? "收起对照表" : `展开对照表（${effortRows.length} 行）`)
          ),
          effortsOpen ? React3.createElement(
            React3.Fragment,
            null,
            // 搜索：对照表本身要能按**档位名**查（「哪些渠道有 xhigh？」「界面上的 Max 是哪个 id？」
            // —— 后者是用户真踩过的坑）。故判据比模型清单的搜索多匹配档位名，
            // 但「空搜索词 = 未搜索」的约定与它共用同一份实现（model-filter.js）。
            //
            // ⚠️ 用户 2026-10-04 要求它**展开后才可用**（原先挂在展开区之外，收起时也在占位）。
            effortRows.length > 0 ? React3.createElement(
              "div",
              { className: "dim-jh-modelFilterBar" },
              React3.createElement("input", {
                type: "search",
                className: "dim-jh-input dim-jh-modelSearch",
                placeholder: "搜索模型 id、展示名或档位名（如 xhigh / Max / Extra）…",
                value: effortsQuery,
                "aria-label": "搜索思考档位",
                onChange: (event) => setEffortsQuery(event.target.value)
              }),
              effortsFiltering ? React3.createElement("button", {
                className: "dim-jh-btn",
                title: "清空搜索词，恢复完整对照表。",
                onClick: () => setEffortsQuery("")
              }, "清空搜索") : null
            ) : null,
            visibleEffortRows.length === 0 ? React3.createElement("div", { className: "dim-jh-effortEmpty" }, gatewayEffortsEmptyHint(effortsQuery)) : React3.createElement(GatewayCards, {
              cards: effortCards,
              renderRow: (row) => React3.createElement(GatewayEffortRow, { row }),
              isExpanded: (provider) => gatewayCardExpanded(
                effortCards.find((card) => card.provider === provider),
                // ⚠️ 有搜索词时一律展开：命中结果藏在折叠卡里，用户会以为「搜不到」
                // （与 `model-groups.js` 的同一取舍）。
                { toggled: effortCardToggles[provider], searching: effortsFiltering }
              ),
              onToggle: (provider) => setEffortCardToggles((prev) => ({
                ...prev,
                [provider]: !gatewayCardExpanded(
                  effortCards.find((card) => card.provider === provider),
                  { toggled: prev[provider], searching: effortsFiltering }
                )
              })),
              onCopy: (card) => void handleCopyCardEfforts(card),
              isCopied: (provider) => copiedEffortCard === provider,
              foldSuffix: "个可选档位",
              foldLabel: "需对照",
              copyNoun: "个模型的档位对照"
            })
          ) : null
        ),
        // ── 网关弹窗脚注 ──
        // ⚠️ 这段是**安全声明**，随着 host 可配（issue IKL7UN）它必须跟着实际监听
        // 地址变化 —— 写死「只绑定 127.0.0.1」在容器部署下是错误陈述（详见
        // `gatewayFootnote` 的注释）。
        React3.createElement(
          "p",
          { className: "dim-jh-modalHint dim-jh-gatewayFootnote" },
          gatewayFootnote(status)
        ),
        notice ? React3.createElement("div", {
          className: "dim-jh-probeNotice",
          "data-tone": notice.tone,
          role: notice.tone === "error" ? "alert" : "status",
          style: { marginTop: "10px" }
        }, React3.createElement("div", null, notice.text)) : null
      )
    )
  );
}
var AGG_WIRED_CHANNEL_IDS = [
  "buddy",
  "workbuddy",
  "loomy",
  "codearts",
  "zcode",
  "lobsterai",
  "trae",
  "accio",
  "officeace",
  "modelscope",
  "autoclaw",
  "autoclawintl",
  "qoder",
  "qodercn",
  "astudio",
  "minimax",
  "minimaxintl"
];
var AGG_EXPIRY_REPROBE_MS = 2 * 60 * 1e3;
function AggregatePanel({ rpcCall }) {
  const [models, setModels] = React3.useState(null);
  const [rejections, setRejections] = React3.useState({});
  const [busy, setBusy] = React3.useState(false);
  const [notice, setNotice] = React3.useState(null);
  const [expanded, setExpanded] = React3.useState({});
  const [orderMode, setOrderMode] = React3.useState("expiry");
  const [pendingOrder, setPendingOrder] = React3.useState({});
  const [orderBusy, setOrderBusy] = React3.useState({});
  const [rejectBusy, setRejectBusy] = React3.useState(false);
  const [lastProbeAt, setLastProbeAt] = React3.useState(null);
  const load = React3.useCallback(async (force = false, options = {}) => {
    setBusy(true);
    try {
      const res = await rpcCall("aggregate.catalog", { force });
      const models2 = res?.models ?? [];
      setModels(models2);
      setOrderMode(res?.orderMode === "manual" ? "manual" : "expiry");
      setRejections(rejectionsFromCatalog(models2));
      setPendingOrder({});
      if (options.keepNotice !== true) setNotice(null);
    } catch (caught) {
      setNotice(`读取聚合目录失败：${caught?.message ?? String(caught)}`);
    } finally {
      setBusy(false);
    }
  }, [rpcCall]);
  React3.useEffect(() => {
    void load();
  }, [load]);
  const onToggleCandidate = React3.useCallback(async (model, candidate) => {
    const { rpc, payload } = candidateToggleAction(model.canonicalId, candidate, {
      // ⚠️ 传**回退后**的三态：老宿主（响应无 `state`）下按终端的拒绝表判，
      //    于是只会发出老宿主认识的 `aggregate.setRejected`（它没有 `setAllowed` 端点）。
      state: candidateStateOf(model.canonicalId, candidate, rejections)
    });
    if (rpc === "aggregate.setRejected") {
      setRejections((prev) => toggleRejection(
        prev,
        model.canonicalId,
        candidate.provider,
        candidate.realId,
        payload.rejected
      ));
    }
    try {
      await rpcCall(rpc, payload);
      await load(true, { keepNotice: true });
      setNotice(null);
    } catch (caught) {
      setNotice(`保存失败：${caught?.message ?? String(caught)}`);
      await load(false, { keepNotice: true });
    }
  }, [rpcCall, load]);
  const [expiryOrder, setExpiryOrder] = React3.useState(null);
  const [expiryBusy, setExpiryBusy] = React3.useState(false);
  const onSortByExpiry = React3.useCallback(async () => {
    setExpiryBusy(true);
    try {
      const res = await rpcCall("aggregate.expiryOrder", { force: true });
      setExpiryOrder(res?.order ?? {});
      setLastProbeAt(Date.now());
      setNotice(null);
    } catch (caught) {
      setNotice(`读取临期顺序失败：${caught?.message ?? String(caught)}`);
    } finally {
      setExpiryBusy(false);
    }
  }, [rpcCall]);
  const onSelectOrderMode = React3.useCallback(async (mode) => {
    if (mode === orderMode) {
      await onSortByExpiry();
      return;
    }
    try {
      const res = await rpcCall("aggregate.setOrderMode", { mode });
      setOrderMode(res?.orderMode === "manual" ? "manual" : "expiry");
      setNotice(null);
      await load(true);
      if (mode === "expiry") await onSortByExpiry();
    } catch (caught) {
      setNotice(`切换排序方式失败：${caught?.message ?? String(caught)}`);
    }
  }, [orderMode, rpcCall, load, onSortByExpiry]);
  React3.useEffect(() => startExpiryReprobe({
    orderMode,
    intervalMs: AGG_EXPIRY_REPROBE_MS,
    isHidden: () => typeof document !== "undefined" && document.hidden === true,
    probe: () => {
      void onSortByExpiry();
    }
  }), [orderMode, onSortByExpiry]);
  const onRejectNonExpiring = React3.useCallback(async () => {
    setRejectBusy(true);
    try {
      const res = await rpcCall("aggregate.rejectNonExpiring", {});
      const cleared = typeof res?.cleared === "number" ? res.cleared : 0;
      setNotice(cleared === 0 ? "没有需要恢复的候选：无临期积分的渠道本来就都在「默认不参与」状态。" : `已把 ${cleared} 条候选恢复为「默认不参与轮换」。`);
      await load(true, { keepNotice: true });
    } catch (caught) {
      setNotice(`恢复默认失败：${caught?.message ?? String(caught)}`);
    } finally {
      setRejectBusy(false);
    }
  }, [rpcCall, load]);
  const orderOf = (model) => pendingOrder[model.canonicalId] ?? model.order ?? [];
  const commitOrder = React3.useCallback(async (model, participating) => {
    if (orderBusy[model.canonicalId] === true) return;
    setOrderBusy((prev) => ({ ...prev, [model.canonicalId]: true }));
    try {
      const order = pendingOrderFromRoster(participating);
      const res = await rpcCall("aggregate.setOrder", { canonicalId: model.canonicalId, order });
      setPendingOrder((prev) => ({ ...prev, [model.canonicalId]: res?.order ?? [] }));
      setNotice(null);
    } catch (caught) {
      setNotice(`保存顺序失败：${caught?.message ?? String(caught)}`);
      setPendingOrder((prev) => {
        const next = { ...prev };
        delete next[model.canonicalId];
        return next;
      });
    } finally {
      setOrderBusy((prev) => ({ ...prev, [model.canonicalId]: false }));
    }
  }, [orderBusy, rpcCall]);
  const dragKeyRef = React3.useRef(null);
  const renderCandidate = (model, candidate, options = {}) => {
    const canonicalId = model.canonicalId;
    const resolvedState = { state: candidateStateOf(canonicalId, candidate, rejections) };
    const state = describeCandidateState(candidate, resolvedState);
    const expiry = expiryOrder === null ? void 0 : expiryOrder[candidate.provider];
    const inactive = candidateStateOf(canonicalId, candidate, rejections) !== "allowed";
    const draggable = options.draggable === true;
    return React3.createElement(
      "div",
      {
        className: "dim-jh-aggCandidate" + (inactive ? " dim-jh-aggCandidateRejected" : "") + (options.dragOver === true ? " dim-jh-aggDragOver" : ""),
        key: `${candidate.provider}\0${candidate.realId}`,
        // ⚠️ 只有**参与轮换**的候选可拖（见 `rotationRosterOf` 的说明）。
        draggable,
        onDragStart: draggable ? (event) => {
          dragKeyRef.current = candidateKeyOf(candidate);
          try {
            event.dataTransfer.setData("text/plain", candidateKeyOf(candidate));
          } catch {
          }
          if (event?.dataTransfer !== void 0) event.dataTransfer.effectAllowed = "move";
        } : void 0,
        // ⚠️ `onDragEnd` 必须清引用：拖到无效区域（或按 Esc 取消）时不会有 `drop`，
        //    残留的 `dragKeyRef` 会让**下一次** hover 到别的行时被当成「正在拖」而 preventDefault。
        onDragEnd: draggable ? () => {
          dragKeyRef.current = null;
        } : void 0,
        onDragOver: draggable ? (event) => {
          if (dragKeyRef.current === null) return;
          event.preventDefault();
          if (event?.dataTransfer !== void 0) event.dataTransfer.dropEffect = "move";
        } : void 0,
        onDrop: draggable ? (event) => {
          event.preventDefault();
          const from = dragKeyRef.current;
          dragKeyRef.current = null;
          if (from === null) return;
          const next = moveCandidateTo(orderOf(model), from, options.index);
          setPendingOrder((prev) => ({ ...prev, [canonicalId]: next }));
          const byKey = new Map((model.candidates ?? []).map((c) => [candidateKeyOf(c), c]));
          const participatingNext = next.map((key) => byKey.get(key)).filter((c) => c !== void 0);
          for (const candidate2 of model.candidates ?? []) {
            if (candidateStateOf(canonicalId, candidate2, rejections) !== "allowed") continue;
            const key = candidateKeyOf(candidate2);
            if (!next.includes(key)) participatingNext.push(candidate2);
          }
          void commitOrder(model, participatingNext);
        } : void 0
      },
      // ⚠️ 拖动手柄**显式**给出（HTML5 拖动的一个已知可用性坑）：
      //    整行可拖时用户不知道能拖；且手柄能承载 title 说明「拖到哪」。
      draggable ? React3.createElement("span", {
        className: "dim-jh-aggDragHandle",
        title: "按住拖动以调整这个模型的候选顺序",
        "aria-hidden": "true"
      }, "⠿") : null,
      // ⚠️ 供应商图标（用户 2026-10-26：「给所有页面供应商和模型左侧 + 供应商图标」）。
      //    聚合页的候选行此前只写「渠道名 · 模型 id」（`candidateRowLabel`），
      //    整列同一种字色；而这一页恰恰是**逐条比较渠道**的地方（同一个模型在
      //    buddy / codearts / lobsterai / loomy / … 各有一条候选），认渠道却只能
      //    读名字。图标在这里的信息量比其它列表更大。
      //    `candidate.provider` 就是渠道 id，与 `candidateRowLabel` 用的是同一个值。
      React3.createElement(ProviderLogo, { provider: candidate.provider }),
      React3.createElement(
        "span",
        { className: "dim-jh-aggCandidateLabel" },
        candidateRowLabel(candidate)
      ),
      // ⚠️ 只有探测过才显示到期提示 —— 否则显示「到期未知」会让用户以为查过了。
      expiry === void 0 ? null : React3.createElement("span", {
        className: "dim-jh-aggCandidateExpiry",
        title: "按临期排序时算出的到期时刻"
      }, expiryLabel(expiry)),
      // ⚠️⚠️ **不再渲染「无临期积分 · 未参与」这段文字**（用户 2026-10-16 验收要求）：
      //    「图1红框中的内容可以不用显示」。未参与的状态由**整行淡化**
      //   （`dim-jh-aggCandidateRejected`）与开关本身的文案表达，行里再挂一遍是冗余。
      //    ⚠️ 开关按钮**保留**它的文案与 title（那是三态的**唯一**出口，
      //    去掉用户就无从知道该点还是不点）。
      // ⚠️ 上移 / 下移按钮**已删除**（用户明确要求：「我们不应该有上下箭头就是应该
      //    鼠标拖动」）。键盘可达性由开关与展开区承担；拖动走 HTML5 drag（已修
      //    `setData` 那一处，见 `onDragStart`）。
      React3.createElement("button", {
        type: "button",
        className: "dim-jh-aggToggle" + (state.pressed ? "" : " dim-jh-aggToggleOff"),
        // ⚠️ 语义是「**参与**轮换」的正向开关：打开 = 允许用这个渠道（规格 §7.1 的原话）。
        // ⚠️ 文案与 title 来自纯函数（三态 + 「已打开的未接入渠道排在最后」的说明）。
        "aria-pressed": String(state.pressed),
        title: state.title,
        onClick: () => {
          void onToggleCandidate(model, candidate);
        }
      }, state.label)
    );
  };
  const renderModel = (model) => {
    const open = expanded[model.canonicalId] === true;
    const manual = orderMode === "manual";
    const rankMap = manual ? new Map(orderOf(model).map((key, index) => [key, index])) : null;
    const expiryOf = (provider) => expiryOrder === null ? void 0 : expiryOrder[provider];
    const { participating, inactive } = rotationRosterOf(model, rankMap, expiryOf, rejections);
    const candidates = manual ? participating : expiryOrder === null ? model.candidates : sortCandidatesByExpiry(model.candidates.map((c) => ({
      ...c,
      expiry: expiryOrder[c.provider]
    })));
    const blocker = rotationBlockerOf(model, rejections);
    const blockerNode = blocker === "all-rejected" ? React3.createElement("span", {
      className: "dim-jh-aggAllRejected",
      title: "你把该模型的全部候选都关了「参与轮换」——请求会如实报「没有任何可用候选」。若想恢复，展开后在子列表里重新打开至少一条。"
    }, "全部被拒") : blocker === "all-default" ? React3.createElement("span", {
      className: "dim-jh-aggAllRejected",
      title: "该模型的候选都来自没有临期积分折算的渠道，默认不参与轮换。展开后可以逐条手工打开（打开后它们排在所有能算出临期的候选之后）。在打开之前，这个模型不会出现在模型选择器里。"
    }, "无临期全拒") : blocker === "mixed" ? React3.createElement("span", {
      className: "dim-jh-aggAllRejected",
      title: "候选全部未参与轮换：其中一部分是你拒绝的、一部分是没有临期积分折算默认不参与的。展开后可以逐条处理。"
    }, "均未参与") : null;
    return React3.createElement(
      "div",
      { className: "dim-jh-aggModel", key: model.canonicalId },
      React3.createElement(
        "button",
        {
          type: "button",
          className: "dim-jh-aggModelHead",
          "aria-expanded": String(open),
          onClick: () => setExpanded((prev) => ({ ...prev, [model.canonicalId]: !open }))
        },
        React3.createElement(
          "span",
          { className: "dim-jh-aggModelName" },
          model.name || model.canonicalId
        ),
        // ⚠️⚠️ **不再渲染「N 个渠道 · 按渠道名/按临期/按手工」这段 meta**
        //（用户 2026-10-16 验收要求：「图1红框中的内容可以不用显示」）。
        //   当前处于哪种排序模式由**顶部 toggle 的高亮段**表达（那是权威且唯一），
        //   模型头再挂一遍是冗余；「N 个渠道」用户展开就看得见。
        //   ⚠️ 候选**数量**信息并未丢失：展开后「未参与轮换（K）」那一段仍带计数，
        //   而参与数量 = 展开后的可拖行数。
        blockerNode,
        React3.createElement("span", { className: "dim-jh-aggChevron" }, open ? "▾" : "▸")
      ),
      open ? React3.createElement(
        "div",
        { className: "dim-jh-aggCandidates" },
        candidates.map((candidate, index) => renderCandidate(model, candidate, {
          draggable: manual,
          index,
          last: index === candidates.length - 1
        })),
        // ── 未参与段（仅手工模式）──
        // ⚠️ **「保存顺序」按钮已删除**（用户验收 2026-10-16）：拖动现在
        //    **松手即提交**（见 `onDrop`），那个按钮既多余、又会让人以为
        //    「不点就不会保存」（真实缺陷：原先不点就真的不保存 ⇒
        //     关窗再开顺序就丢了）。交互与本仓库另两处拖动统一。
        manual && inactive.length > 0 ? React3.createElement(
          "div",
          { className: "dim-jh-aggInactiveSection" },
          React3.createElement(
            "span",
            { className: "dim-jh-aggInactiveTitle" },
            `未参与轮换（${inactive.length}）`
          ),
          inactive.map((candidate) => renderCandidate(model, candidate))
        ) : null
      ) : null
    );
  };
  const sortedModels = sortModelsForPanel(models ?? []);
  const probedAgoText = lastProbeAt === null ? "" : (() => {
    const minutes = Math.floor((Date.now() - lastProbeAt) / 6e4);
    return minutes < 1 ? "刚刚" : `${minutes} 分钟前`;
  })();
  return React3.createElement(
    "div",
    {
      className: "dim-jh-aggPanel"
    },
    // ── 说明区 ──
    React3.createElement(
      "section",
      { className: "dim-jh-aggIntro" },
      React3.createElement("h2", { className: "dim-jh-aggTitle" }, "聚合"),
      React3.createElement(
        "p",
        { className: "dim-jh-aggIntroLine" },
        "把同一个模型在各渠道的条目聚合成一个名字，请求时按「积分最快作废」自动选渠道。"
      ),
      React3.createElement(
        "p",
        { className: "dim-jh-aggIntroLine" },
        "三层开关互不影响：关渠道（各渠道自己的面板）、关模型（模型选择器）、以及本页子列表里逐条控制某个候选是否参与轮换（只影响这一个模型）。"
      ),
      React3.createElement(
        "p",
        { className: "dim-jh-aggIntroWarn" },
        "本 provider 无需登录、没有账号池；积分与限流由各渠道自己管理。"
      ),
      // ⚠️ 文案必须**说真话**（2026-10-15 改写）：未接入折算的渠道现在**也出现在目录里**
      //    且可逐条手工打开，故不能再写「不参与轮换（仍可直连使用）」那句 ——
      //    它会让用户以为这里做什么都没用。
      React3.createElement(
        "p",
        { className: "dim-jh-aggIntroLine" },
        "没有临期积分折算的渠道**默认不参与轮换**（它们现在也出现在目录里，展开模型后可以逐条手工打开）。"
      ),
      // ⚠️ 这一句是**必须**的：手工打开的未接入候选与「无临期积分」的已接入候选
      //    都是 `NEVER` ⇒ 它们排在能算出临期的候选**之后**。用户看到「我明明手工打开了
      //    却排在最后」时，若面板从没说过这件事，就会以为是缺陷。
      React3.createElement(
        "p",
        { className: "dim-jh-aggIntroLine" },
        "「按手工排序」模式下可以拖动候选调整顺序。手工打开的「无临期积分」候选排在所有能算出临期的候选之后（两者没有可比较的到期时间），这种混合顺序是正常的、不是缺陷。"
      )
    ),
    // ── 工具行 ──
    // ⚠️⚠️ **顺序：按钮在前、计数在后**（用户 2026-10-16 第三次验收：
    //    「43 个聚合模型应该显示在按钮下面」）。
    //    原先计数在最前 ⇒ 它占掉第一行的一个位置。⇒ 现在按钮先排，计数放**最后**
    //    并由 CSS 的 flex-basis: 100% 强制换行 ⇒ 恒定显示在按钮**下面**。
    React3.createElement(
      "div",
      { className: "dim-jh-aggToolbar" },
      // ⚠️⚠️ 排序模式改成**单个切换按钮**（用户 2026-10-16 验收要求：
      //    「图2的排序按手工还是按临期应该是一个按钮的点击切换（就像解锁永久积分和
      //     锁定永久积分一样）」）。
      //    形态照 `permanentLockCopy` 那个按钮：按钮文字说**当前状态**，点击切到另一种，
      //    变化与代价放 `title`；激活态（按手工）用 `data-kind='primary'` 区分。
      //    ⚠️ 原来的两段式 `dim-jh-aggSegmented` 已删除 —— 两段在窄面板下各占一列，
      //    会把工具行挤成竖排（同一个验收截图里的现象）。
      // ⚠️⚠️ **必须用 `.dim-jh-btn`**（用户 2026-10-16 第二次验收：
      //    「拒绝非临期和切换排序为什么还是没有按按钮样式（图2）显示」）。
      //    根因：我原先给聚合工具栏用的是自造的 `.dim-jh-aggRefresh`（圆角 6px、**无背景色**、
      //    `primary` 只是描边变蓝），而全站按钮的标准类 `.dim-jh-btn` 是
      //    圆角 8px + 有底色 + hover 变蓝 + `primary` = **实心蓝底白字**（图2 那个
      //    「解锁永久积分」正是它）⇒ 两套样式看起来不像同一个 UI。
      //    ⇒ 排序切换与「拒绝非临期」「刷新」全部改用 `.dim-jh-btn`，
      //      激活态沿用 `data-kind='primary'`（与「锁定永久积分」**逐字同一形态**）。
      React3.createElement("button", {
        type: "button",
        className: "dim-jh-btn",
        "data-kind": orderMode === "manual" ? "primary" : void 0,
        disabled: expiryBusy,
        "aria-pressed": String(orderMode === "manual"),
        title: orderMode === "manual" ? "当前按**你手工拖动的顺序**轮换。点此切回「按临期」——临期序每 2 分钟自动重查一次（会打上游请求）；手工序不受影响、仍各自保存。" : "当前按**积分最快作废**的顺序轮换（每 2 分钟自动重查一次，会打上游请求）。点此切到「按手工」——展开模型后可拖动候选调整顺序，两种顺序分别保存、互不覆盖。",
        onClick: () => {
          void onSelectOrderMode(orderMode === "manual" ? "expiry" : "manual");
        }
      }, expiryBusy ? "查询中…" : orderMode === "manual" ? "排序：按手工" : `排序：按临期${lastProbeAt !== null ? ` · ${probedAgoText}` : ""}`),
      // ⚠️ 一键「拒绝非临期」：把未接入折算渠道的手工打开恢复为「默认不参与」。
      //    它**不弹确认**（可逆、且逐条还能再打开）—— 但文案必须区分
      //    「恢复了 N 条」与「本来就没打开」（见 `onRejectNonExpiring`）。
      React3.createElement("button", {
        type: "button",
        className: "dim-jh-btn",
        disabled: rejectBusy,
        title: "把所有没有临期积分折算的渠道恢复为「默认不参与轮换」的初始状态（它们仍留在聚合目录里，可随时逐条手工打开；已接入折算的渠道不受影响）",
        onClick: () => {
          void onRejectNonExpiring();
        }
      }, rejectBusy ? "处理中…" : "拒绝非临期"),
      React3.createElement("button", {
        type: "button",
        className: "dim-jh-btn",
        disabled: busy,
        // ⚠️ **显式刷新必须传 `true`**（绕过宿主侧 60 秒目录缓存）——
        //    否则按钮实际是「读缓存」，用户改了渠道模型后点刷新看不到变化。
        title: "重新读取各渠道的模型目录（绕过 60 秒缓存）",
        onClick: () => {
          void load(true);
        }
      }, busy ? "刷新中…" : "刷新"),
      // ⚠️ 计数**放最后**（见工具行开头的注释）：CSS 的 flex-basis: 100% 让它
      //    恒定换行到按钮**下一行**（用户要求「应该显示在按钮下面」）。
      React3.createElement(
        "span",
        { className: "dim-jh-aggCount" },
        models === null ? "读取中…" : `${models.length} 个聚合模型`
      )
    ),
    notice !== null ? React3.createElement("div", { className: "dim-jh-aggNotice" }, notice) : null,
    // ── 空态 ──
    // ⚠️ 文案**不得写死渠道数量**（那类快照必然腐坏，仓库既有教训：接入 accio/officeace
    //    后手抄名单没人回头改，只登那两家的用户会看到「请先登录」这句错话）。
    //    这里从 `AGG_WIRED_CHANNEL_IDS` 现查 `providerLabel()` —— id 名单的集合相等
    //    由用例锁死；**名字不抄**（registry 是唯一真相源）⇒ 改名 / 新增均零改动。
    // ⚠️ 2026-10-15 补上「或手工打开」这条出路：未接入渠道的账号**不会**让模型自动
    //    进轮换，用户若只登录了那几家，看到的仍是空态 —— 必须告诉他第二步做什么。
    models !== null && models.length === 0 ? React3.createElement(
      "div",
      { className: "dim-jh-aggEmpty" },
      "当前没有可聚合的模型：请先在至少一个已接入临期折算的渠道（" + AGG_WIRED_CHANNEL_IDS.map((id) => providerLabel(id)).join(" / ") + "）登录账号；或者登录其它渠道后，在本页展开模型、把候选逐条手工打开。"
    ) : null,
    // ── 模型列表（**平铺**，全局按候选渠道数降序；不再有厂商分组标题）──
    sortedModels.map((model) => renderModel(model)),
    // ── 页脚说明 ──
    React3.createElement(
      "footer",
      { className: "dim-jh-aggFooter" },
      React3.createElement(
        "p",
        null,
        "为什么没有签到 / 重置 / 新建账号按钮：本 provider 不持有账号与积分。"
      ),
      React3.createElement(
        "p",
        null,
        "候选如何得出：字面推导（id / name 双通道）+ 显式映射补丁。"
      ),
      React3.createElement(
        "p",
        null,
        "如何核查：展开任一模型，逐条看渠道与真实 modelId；不同意就关掉那一行。"
      )
    )
  );
}
function JetHubPage({ rpcCall }) {
  const [selected, setSelected] = React3.useState(PROVIDERS[0].id);
  const [version, setVersion] = React3.useState(0);
  const [checkinBusy, setCheckinBusy] = React3.useState(false);
  const [checkinNotice, setCheckinNotice] = React3.useState(null);
  const [providerStatuses, setProviderStatuses] = React3.useState(null);
  const [providerStatusFailed, setProviderStatusFailed] = React3.useState(false);
  const [showProviderSwitches, setShowProviderSwitches] = React3.useState(false);
  const [providerBusy, setProviderBusy] = React3.useState(() => /* @__PURE__ */ new Set());
  const [providerOrder, setProviderOrder] = React3.useState(null);
  const [providerReordering, setProviderReordering] = React3.useState(false);
  const reorderLockRef = React3.useRef(false);
  const [providerNotice, setProviderNotice] = React3.useState(null);
  const [showGateway, setShowGateway] = React3.useState(false);
  const [gatewayStatus, setGatewayStatus] = React3.useState(null);
  const [gatewayBusy, setGatewayBusy] = React3.useState(false);
  const [gatewayNotice, setGatewayNotice] = React3.useState(null);
  const [showTokenLedger, setShowTokenLedger] = React3.useState(false);
  const mounted = React3.useRef(true);
  React3.useEffect(() => () => {
    mounted.current = false;
  }, []);
  const loadGatewayStatus = React3.useCallback(async () => {
    try {
      const res = await rpcCall("gateway.getEnabled", {});
      if (!mounted.current) return;
      setGatewayStatus(res);
    } catch (caught) {
      console.error("[jet-hub] read gateway status failed:", caught);
      if (!mounted.current) return;
      setGatewayStatus(null);
      setGatewayNotice({ tone: "error", text: "读取网关状态失败：" + (caught?.message || "未知错误") });
    }
  }, [rpcCall]);
  React3.useEffect(() => {
    void loadGatewayStatus();
  }, [loadGatewayStatus]);
  const toggleGatewayAllowLan = React3.useCallback(async (nextAllowLan) => {
    setGatewayBusy(true);
    setGatewayNotice(null);
    try {
      const res = await rpcCall("gateway.setAllowLan", { allowLan: nextAllowLan });
      if (!mounted.current) return;
      setGatewayStatus(res);
      setGatewayNotice({ tone: "ok", text: gatewayAllowLanToggleNotice(res, nextAllowLan) });
    } catch (caught) {
      console.error("[jet-hub] toggle gateway allowLan failed:", caught);
      if (!mounted.current) return;
      setGatewayNotice({ tone: "error", text: "操作失败：" + (caught?.message || "未知错误") });
      await loadGatewayStatus();
    } finally {
      if (mounted.current) setGatewayBusy(false);
    }
  }, [rpcCall, loadGatewayStatus]);
  const toggleGateway = React3.useCallback(async (nextEnabled) => {
    setGatewayBusy(true);
    setGatewayNotice(null);
    try {
      const res = await rpcCall("gateway.setEnabled", { enabled: nextEnabled });
      if (!mounted.current) return;
      setGatewayStatus(res);
      setGatewayNotice({ tone: "ok", text: gatewayToggleNotice(res, nextEnabled) });
    } catch (caught) {
      console.error("[jet-hub] toggle gateway failed:", caught);
      if (!mounted.current) return;
      setGatewayNotice({ tone: "error", text: "操作失败：" + (caught?.message || "未知错误") });
      await loadGatewayStatus();
    } finally {
      if (mounted.current) setGatewayBusy(false);
    }
  }, [rpcCall, loadGatewayStatus]);
  const loadProviderStatuses = React3.useCallback(async () => {
    try {
      const res = await rpcCall("provider.status", { providers: PROVIDERS.map((p) => p.id) });
      if (!mounted.current) return;
      setProviderStatuses(res?.statuses || {});
      setProviderStatusFailed(false);
    } catch (caught) {
      console.error("[jet-hub] load provider statuses failed:", caught);
      if (!mounted.current) return;
      setProviderStatuses(null);
      setProviderStatusFailed(true);
      setProviderNotice({
        tone: "warn",
        text: `供应商开关状态读取失败（${caught?.message || "未知错误"}），已按原顺序显示供应商；账号管理不受影响。`
      });
    }
  }, [rpcCall]);
  React3.useEffect(() => {
    mounted.current = true;
    void loadProviderStatuses();
  }, [loadProviderStatuses]);
  const loadProviderOrder = React3.useCallback(async () => {
    try {
      const res = await rpcCall("provider.getOrder", {});
      if (!mounted.current) return;
      setProviderOrder(Array.isArray(res?.order) && res.order.length > 0 ? res.order : null);
    } catch (caught) {
      console.error("[jet-hub] load provider order failed:", caught);
      if (!mounted.current) return;
      setProviderOrder(null);
    }
  }, [rpcCall]);
  React3.useEffect(() => {
    void loadProviderOrder();
  }, [loadProviderOrder]);
  const providerTouchedRef = React3.useRef(false);
  React3.useEffect(() => {
    if (providerTouchedRef.current) return;
    if (!Array.isArray(providerOrder) || providerOrder.length === 0) return;
    const firstUsable = providerOrder.find((id) => providerStatuses === null || providerStatuses?.[id]?.closed !== true) ?? providerOrder[0];
    if (typeof firstUsable === "string" && firstUsable !== selected && PROVIDERS.some((p) => p.id === firstUsable)) {
      setSelected(firstUsable);
      setVersion((v) => v + 1);
    }
  }, [providerOrder, providerStatuses, selected]);
  const commitProviderOrder = React3.useCallback(async (next) => {
    if (!Array.isArray(next)) return;
    if (reorderLockRef.current) return;
    reorderLockRef.current = true;
    setProviderReordering(true);
    setProviderNotice((prev) => prev && prev.inModal ? null : prev);
    try {
      await rpcCall("provider.setOrder", { order: next });
      if (!mounted.current) return;
      setProviderOrder(next);
    } catch (caught) {
      console.error("[jet-hub] commit provider order failed:", caught);
      if (!mounted.current) return;
      setProviderNotice({
        tone: "error",
        text: "保存排序失败：" + (caught?.message || "未知错误") + "。界面顺序保持不变，可重试拖动。",
        // ⚠️ 必须由**弹窗内**呈现：拖拽必然发生在弹窗打开期间，而弹窗遮罩是
        // fixed + z-index 3000，页面层的 notice 会被它整个盖住（用户看不到失败）。
        inModal: true
      });
      await loadProviderOrder();
    } finally {
      reorderLockRef.current = false;
      if (mounted.current) setProviderReordering(false);
    }
  }, [rpcCall, loadProviderOrder]);
  const selectProvider = (id) => {
    providerTouchedRef.current = true;
    setSelected(id);
    setVersion((v) => v + 1);
  };
  const toggleProvider = async (providerId, enabled) => {
    const label = PROVIDERS.find((p) => p.id === providerId)?.label || providerId;
    const status = providerStatuses?.[providerId];
    if (!enabled) {
      const models = status?.models?.total ?? 0;
      const accounts = status?.accounts?.enabled ?? 0;
      const ok = confirm(
        `确认关闭「${label}」？

将关闭它的 ${models} 个模型（从对话框的模型选择里移除），并停用它的 ${accounts} 个启用账号。

取消则不做任何变更。`
      );
      if (!ok) return;
    }
    setProviderBusy((prev) => new Set(prev).add(providerId));
    setProviderNotice(null);
    try {
      const res = await rpcCall("provider.setEnabled", { provider: providerId, enabled });
      if (!mounted.current) return;
      setProviderNotice({
        tone: "ok",
        text: `${label}：${summarizeProviderToggle(enabled, res)}`
      });
      await loadProviderStatuses();
      if (mounted.current) setVersion((v) => v + 1);
    } catch (caught) {
      console.error("[jet-hub] toggle provider failed:", caught);
      if (!mounted.current) return;
      setProviderNotice({
        tone: "error",
        text: `${label} 操作失败：${caught?.message || "未知错误"}`
      });
    } finally {
      if (mounted.current) {
        setProviderBusy((prev) => {
          const next = new Set(prev);
          next.delete(providerId);
          return next;
        });
      }
    }
  };
  const checkinAll = async () => {
    setCheckinBusy(true);
    setCheckinNotice(null);
    const parts = [];
    const notes = [];
    const totalByUnit = { token: 0, credit: 0 };
    let failed = 0;
    for (const provider of checkinProviders()) {
      const label = PROVIDERS.find((p) => p.id === provider)?.label || provider;
      try {
        const res = await rpcCall("credits.claimAll", { provider });
        const s = res?.summary || {};
        const bits = [];
        if (s.claimed > 0) {
          const byUnit = s.totalByUnit || { credit: s.totalCredit, token: 0 };
          totalByUnit.credit += Number(byUnit.credit) || 0;
          totalByUnit.token += Number(byUnit.token) || 0;
          const amount = formatClaimGains(byUnit);
          if (amount !== null) bits.push(amount);
        }
        if (s.alreadyClaimed > 0) bits.push(`${s.alreadyClaimed} 个今日已领`);
        if (s.inactive > 0) bits.push(`${s.inactive} 个暂无活动`);
        if (s.failed > 0) {
          failed += s.failed;
          const reason = (res?.results || []).map((item) => item?.outcome?.message).find((msg) => typeof msg === "string" && msg.length > 0);
          bits.push(`${s.failed} 个失败${reason ? `（${reason}）` : ""}`);
        }
        parts.push(`${label} ${bits.length > 0 ? bits.join("，") : "无账号"}`);
        for (const item of res?.results || []) {
          const outcome = item?.outcome || {};
          if (outcome.actionRequired !== true) continue;
          const msg = outcome.message;
          if (typeof msg !== "string" || msg.length === 0) continue;
          if (!notes.includes(msg)) notes.push(msg);
        }
      } catch (caught) {
        failed += 1;
        parts.push(`${label} 失败（${caught?.message || "未知原因"}）`);
      }
      if (!mounted.current) return;
    }
    if (!mounted.current) return;
    const totalAmount = formatClaimGains(totalByUnit);
    setCheckinNotice({
      // 有待用户处理的提示时用 warn 色调，让那条提示更显眼
      tone: failed > 0 || notes.length > 0 ? "warn" : "ok",
      text: parts.length > 0 ? `一键签到：${parts.join("，")}${totalAmount === null ? "" : `（共 ${totalAmount}）`}` : "一键签到：没有可领取的渠道",
      notes
    });
    setCheckinBusy(false);
    setVersion((v) => v + 1);
  };
  const renderProviderRow = (p) => {
    const closed = providerStatuses?.[p.id]?.closed === true;
    return React3.createElement(
      "div",
      { className: "dim-jh-providerRow", key: p.id, "data-provider": p.id },
      React3.createElement(
        "button",
        {
          type: "button",
          role: "tab",
          className: "dim-jh-provider",
          "aria-selected": p.id === selected,
          // 标题带上关闭状态：行本身已经没有开关，用户得知道去哪儿打开它。
          // ⚠️ 按钮名是「供应商」（页头），文案要与它一致，否则用户找不到。
          title: closed ? `${p.label}（已关闭，可在页头「供应商」按钮里打开）` : p.label,
          onClick: () => selectProvider(p.id)
        },
        React3.createElement(ProviderLogo, { provider: p.id }),
        // ⚠️ 这里给 label 加了 `dim-jh-providerLabel` —— 该类在样式表里**早已定义**
        // （含 min-width: 0 与省略号），但此前从未被任何 JS 使用，故真实界面上长
        // 供应商名一直在**折行**。加上它可把折行改为单行省略号（实测：rail 243px 时
        // 只有 WorkBuddy 一行超宽 21px），且列表总高不变（384px）；若不加，行高会
        // 从 48px 被顶到 58px、总高 424px。这是一处左侧的可见变化，已在交付说明中注明。
        React3.createElement(
          "span",
          { className: "dim-jh-providerLabel" },
          React3.createElement("strong", null, p.label)
        )
      )
    );
  };
  const renderRail = () => {
    if (providerStatuses === null) {
      return PROVIDERS.map((p) => renderProviderRow(p));
    }
    const { open, closed } = groupProviders(PROVIDERS, providerStatuses);
    const group = (title, list, key) => React3.createElement(
      "div",
      { className: "dim-jh-railGroup", key },
      React3.createElement("div", { className: "dim-jh-railGroupTitle" }, title),
      list.map((p) => renderProviderRow(p))
    );
    return [
      // ⚠️ 第三个实参 = **声明顺序**（注册表全量 id）。传它才能让
      // `providerOrder` 里缺失的**新增** provider 落回它该在的位置，
      // 而不是被缀到末尾（真实缺陷，2026-10-17 用户报障
      // 「minimax 国际版的顺序应该在中国版下面」）。
      group(
        `已打开 (${open.length})`,
        sortOpenProvidersByOrder(open, providerOrder, PROVIDERS.map((p) => p.id)),
        "open"
      ),
      group(`已关闭 (${closed.length})`, closed, "closed")
    ];
  };
  const providerSummary = providerToggleSummary(PROVIDERS, providerStatuses);
  const [nativeSearchOn, setNativeSearchOn] = React3.useState(true);
  const [nativeSearchBusy, setNativeSearchBusy] = React3.useState(false);
  const [nativeSearchFailed, setNativeSearchFailed] = React3.useState(false);
  const loadNativeSearchStatus = React3.useCallback(async () => {
    try {
      const res = await rpcCall("nativeSearch.getEnabled", {});
      if (!mounted.current) return;
      setNativeSearchOn(res?.enabled !== false);
      setNativeSearchFailed(false);
    } catch (caught) {
      console.error("[jet-hub] load native search status failed:", caught);
      if (!mounted.current) return;
      setNativeSearchOn(true);
      setNativeSearchFailed(true);
    }
  }, [rpcCall]);
  const toggleNativeSearch = React3.useCallback(async (nextEnabled) => {
    setNativeSearchBusy(true);
    try {
      const res = await rpcCall("nativeSearch.setEnabled", { enabled: nextEnabled });
      if (!mounted.current) return;
      setNativeSearchOn(res?.enabled !== false);
      setNativeSearchFailed(false);
    } catch (caught) {
      console.error("[jet-hub] toggle native search failed:", caught);
      if (!mounted.current) return;
      await loadNativeSearchStatus();
    } finally {
      if (mounted.current) setNativeSearchBusy(false);
    }
  }, [rpcCall, loadNativeSearchStatus]);
  React3.useEffect(() => {
    void loadNativeSearchStatus();
  }, [loadNativeSearchStatus]);
  return React3.createElement(
    "section",
    { className: "dim-jh-page", "aria-label": "Jet Hub Provider 设置" },
    // ⚠️ 页头左侧的「Jet Hub」标题块已**整块删除**（用户 2026-10-07 要求：
    // 标题只占宽度、不带任何操作，空间全给按钮行）。这里先后删过两样东西，
    // 都**不要**加回来：
    // ① 副标题「提供商凭据与多账号管理」（.dim-jh-brandDesc）—— 2026-10-06，
    //    因为按钮太多，副标题既显示不全又挤占页头高度；
    // ② 标题本体「Jet Hub」（.dim-jh-brand / .dim-jh-brandName）—— 2026-10-07，
    //    页头一排已有 7 个按钮，标题纯属占位。设置页的语义由本节点的
    //    aria-label 与宿主左侧「Jet Hub」导航项承担，不丢。
    React3.createElement(
      "header",
      { className: "dim-jh-header" },
      React3.createElement(
        "div",
        { className: "dim-jh-headerActions" },
        // 「供应商开关」在页头，而不是左侧每个供应商行尾（!25 的原形态）：
        // 它是破坏性批量操作，与「选择看哪个供应商」这个高频无害动作分开摆放，
        // 误点的可能性归零，也让左侧窄栏回到纯导航。见 `ProviderSwitchPanel`。
        // ⚠️ 按钮文字只写「供应商」（不是「供应商开关」）：页头四个按钮要排成
        // 一排，5 个字会把「关闭」挤到第二行 —— 完整语义由 tooltip 与弹窗标题承担。
        React3.createElement("button", {
          className: "dim-jh-btn",
          title: (providerSummary.known ? "供应商开关：逐个打开/关闭（已打开 " + providerSummary.open + "、已关闭 " + providerSummary.closed + "）。" : "供应商开关：逐个打开/关闭。") + "关闭一个供应商 = 关闭它的全部模型并停用它的全部账号。",
          "aria-haspopup": "dialog",
          "aria-expanded": showProviderSwitches ? "true" : "false",
          onClick: () => {
            setShowGateway(false);
            setShowProviderSwitches(true);
          }
        }, "供应商"),
        // 一键签到在备份/恢复**左侧**（需求指定位置）
        React3.createElement("button", {
          className: "dim-jh-btn",
          title: "依次签到全部支持签到的渠道（CodeBuddy / LobsterAI / CodeArts / Qoder / TRAE）。串行执行以避免触发风控。",
          disabled: checkinBusy,
          onClick: () => void checkinAll()
        }, checkinBusy ? "签到中…" : "一键签到"),
        React3.createElement(BackupPanel, {
          rpcCall,
          // 导入成功会整体替换账号，ProviderPanel 只在挂载时拉列表；
          // 递增版号强制重新挂载，让账号列表与模型目录立即反映新状态。
          onImported: () => setVersion((v) => v + 1)
        }),
        // 本机网关开关。⚠️ 文字刻意只写「网关」（见「供应商」按钮上方的同款
        // 注释）：页头按钮排成一行，长文字会把右端「关闭」挤到第二行。
        React3.createElement("button", {
          className: "dim-jh-btn",
          title: gatewayButtonTitle(gatewayStatus),
          "aria-haspopup": "dialog",
          "aria-expanded": showGateway ? "true" : "false",
          onClick: () => {
            setShowProviderSwitches(false);
            setShowGateway(true);
            setGatewayNotice(null);
            void loadGatewayStatus();
          }
        }, gatewayButtonLabel(gatewayStatus)),
        // 「Token 用量」入口：全 provider 的本地记账（直连/网关分开统计）。
        React3.createElement("button", {
          className: "dim-jh-btn",
          title: "Token 用量：按渠道（直连/网关）、供应商与模型统计本机请求的 token 消耗。",
          "aria-haspopup": "dialog",
          "aria-expanded": showTokenLedger ? "true" : "false",
          onClick: () => {
            setShowProviderSwitches(false);
            setShowGateway(false);
            setShowTokenLedger(true);
          }
        }, "Token 用量"),
        // 「渠道原生搜索」总开关。**取代**了原先这里的「关闭」按钮 ——
        // 关闭设置页仍有右上角 × 与点击空白处两条路径，而那个按钮与外壳的 ×
        // 语义完全重复（用户 2026-10-14 决定）。
        //
        // 语义：开 = 支持原生搜索的渠道（CodeBuddy / WorkBuddy）走自己后端的
        // 搜索接口；关 = 所有渠道一律回官方 DeepSeek 搜索（需要 API Key）。
        React3.createElement(
          "label",
          {
            className: "dim-jh-nativeSearch",
            title: nativeSearchFailed ? "⚠️ 开关状态读取失败，当前显示的是默认值（开启）。点击即可重新提交一次。" : "渠道原生搜索：为支持原生搜索的渠道（CodeBuddy / WorkBuddy）启用其自带搜索。关闭后所有渠道都改用 DeepSeek 官方搜索（需要 DEEPSEEK_API_KEY）。"
          },
          React3.createElement("input", {
            type: "checkbox",
            className: "dim-jh-switch",
            checked: nativeSearchOn,
            // ⚠️ **只**因提交中而禁用：读取失败时不禁用 —— 那会让用户在
            //    唯一一次读取抖动后**彻底失去**自救路径（连切换都点不动），
            //    与网关面板「任何一个附属字段采集失败都不该把用户挡在关掉它
            //    这条自救路径之外」同一取向。
            disabled: nativeSearchBusy,
            onChange: (event) => void toggleNativeSearch(event.target.checked)
          }),
          React3.createElement("span", null, "渠道原生搜索")
        )
      )
    ),
    // 签到结果放在页头下方横跨整宽：页头是 flex 且不换行，塞进去会挤压按钮。
    // `flex: none` 是必需的 —— `dim-jh-page` 是 column flex 且 `dim-jh-layout`
    // 带 `flex: 1`，不锁住的话提示条会被压扁（与 modal 内同款做法）。
    checkinNotice ? React3.createElement(
      "div",
      {
        className: "dim-jh-probeNotice",
        "data-tone": checkinNotice.tone,
        role: checkinNotice.tone === "error" ? "alert" : "status",
        style: { flex: "none", margin: "12px 24px 0" }
      },
      React3.createElement("div", null, checkinNotice.text),
      // 需要用户操作的提示单列成列表（如「请先用 Qoder 官方客户端登录一次」）。
      // 复用既有的 `dim-jh-probeDetails` 样式，不引入新样式。
      (checkinNotice.notes || []).length > 0 ? React3.createElement(
        "ul",
        { className: "dim-jh-probeDetails" },
        checkinNotice.notes.map((note, index) => React3.createElement("li", { key: index }, note))
      ) : null
    ) : null,
    // ⚠️ `inModal` 的提示交给弹窗自己渲染（见 ProviderSwitchPanel）—— 重复渲染
    // 会让同一条错误在遮罩内外各出现一次。
    providerNotice && !providerNotice.inModal ? React3.createElement("div", {
      className: "dim-jh-probeNotice",
      "data-tone": providerNotice.tone,
      role: providerNotice.tone === "error" ? "alert" : "status",
      style: { flex: "none", margin: "12px 24px 0" }
    }, React3.createElement("div", null, providerNotice.text)) : null,
    React3.createElement(
      "div",
      { className: "dim-jh-layout" },
      React3.createElement(
        "nav",
        { className: "dim-jh-rail", role: "tablist", "aria-label": "Provider 导航" },
        renderRail()
      ),
      React3.createElement(
        "main",
        {
          className: "dim-jh-panel",
          role: "tabpanel"
        },
        PROVIDERS.map((p) => p.id === selected ? p.id === "aggregate" ? React3.createElement(AggregatePanel, { key: p.id + "-" + version, rpcCall }) : React3.createElement(ProviderPanel, {
          key: p.id + "-" + version,
          provider: p.id,
          rpcCall
        }) : null)
      )
    ),
    // 「供应商开关」以 modal 渲染：它是覆盖层，放在布局之后只是组件树的书写顺序
    // （与账号面板里的模型列表同款做法）。关闭即不挂载，避免常驻一份开关列表。
    showProviderSwitches ? React3.createElement(ProviderSwitchPanel, {
      providers: PROVIDERS,
      statuses: providerStatuses,
      statusFailed: providerStatusFailed,
      busyIds: providerBusy,
      onToggle: toggleProvider,
      onReload: loadProviderStatuses,
      onClose: () => setShowProviderSwitches(false),
      order: providerOrder,
      onCommitOrder: commitProviderOrder,
      reordering: providerReordering,
      notice: providerNotice,
      // 弹窗的「模型列表」视图要逐家调 `model.list`（服务端只有单 provider 端点）。
      rpcCall
    }) : null,
    // 同款做法：网关开关也是覆盖层，且与「供应商开关」互斥 —— 两者都是
    // `position: fixed` 的全屏弹窗，同时打开会叠在一起、ESC 只关掉后挂载的那个。
    showGateway ? React3.createElement(GatewayPanel, {
      status: gatewayStatus,
      busy: gatewayBusy,
      notice: gatewayNotice,
      onToggle: toggleGateway,
      onToggleAllowLan: toggleGatewayAllowLan,
      onReload: loadGatewayStatus,
      onClose: () => setShowGateway(false)
    }) : null,
    // 「Token 用量」弹窗：同样是覆盖层（createElement 形式 —— 与其它弹窗
    // 同一理由，见 OpencodeProxyModal 上方的 hook 计数事故注释）。
    showTokenLedger ? React3.createElement(TokenLedgerPanel, {
      rpcCall,
      onClose: () => setShowTokenLedger(false)
    }) : null
  );
}

// plugin-src/client/zcode-carrier.js
var CARRIER_PENDING = "__pending__";
var CARRIER_FAILURE = Object.freeze({
  /** 载体页回的不是 200/401/403（被反代改写、端口上跑的是别的东西……）。 */
  unauthenticated: "unauthenticated",
  /** 注入读回的 `location.origin` 与**载体页那条地址**的 origin 不一致。 */
  originMismatch: "origin-mismatch",
  /** 页面挂载了但 `stage` 一直 pending 到预算用尽。 */
  mintTimeout: "mint-timeout",
  /** 页面自己上报了终态失败（`stage` 非 pending/success，带 `error`）。 */
  mintFailed: "mint-failed",
  /** 同源、也加载完了，但文档里没有那个挂载位（被反代改写/返回了别的 HTML）。 */
  notCarrierPage: "not-carrier-page",
  /** 导航层失败（`did-fail-load`）。 */
  loadFailed: "load-failed",
  /** 我们发的状态探针自己都失败了（离线/被拦截）⇒ 与「服务器回了 401」是两回事。 */
  probeFailed: "probe-failed",
  /** 产出来了但供给槽没收（`accepted !== true`：垃圾产物 / 空串 / 异常短）。 */
  slotRejected: "slot-rejected",
  /** 读 guest 表达式这条路整个抛了（guest 失联、被主进程回收、RPC 通道断了）。 */
  roundCrashed: "round-crashed",
  /**
   * ★ server 说「现在没有载体页地址」（`captcha.carrierUrl` 回 `null`）。
   *
   * 两种成因：`DSH_ZCODE_INTERNAL_CARRIER=0`，或候选端口全被占。
   * ⇒ **安静**的一类：这不是故障，不建 guest、不导航、不重试同一轮。
   * 取代了原先那条 `noGuiOrigin`（同源拼地址的那条路已经不存在了）。
   */
  noCarrierUrl: "no-carrier-url",
  /** 租约能拿到但发不出去（主进程不认、配额满）。 */
  acquireFailed: "acquire-failed"
});
var CARRIER_FAILURE_LABELS = Object.freeze({
  [CARRIER_FAILURE.unauthenticated]: "载体页回了 401/403（guest 自己探到的状态码） ⇒ 那条独立端口上的小服务被别的东西占了、或被加了认证；本窗口照旧走外挂 chromium",
  [CARRIER_FAILURE.originMismatch]: "导航后读回的 origin 与载体页地址的 origin 不一致（被重定向出去了） ⇒ 先确认那条回环端口上的服务还是我们起的那一个（有人抢占 / 端口被复用）",
  [CARRIER_FAILURE.mintTimeout]: "载体页一直在 pending ⇒ SDK 那段没跑完（网络拉不到 JS、被 CSP 拦、或页面被降级成人工验证）",
  [CARRIER_FAILURE.mintFailed]: "载体页自己报了终态失败（下面带 stage 与 error）",
  [CARRIER_FAILURE.notCarrierPage]: "同源也加载完了，但文档里没有载体页的挂载位 ⇒ 返回的不是那一页 HTML",
  [CARRIER_FAILURE.loadFailed]: "导航本身失败（did-fail-load，下面带 errorCode/description）",
  [CARRIER_FAILURE.probeFailed]: "状态码探针自己发不出去（服务已关 / 被拦）⇒ 与「服务器明确回了状态码」不是一回事",
  [CARRIER_FAILURE.slotRejected]: "param 已产出但供给槽没收（server 判不合格：垃圾产物 / 空串 / 异常短）",
  [CARRIER_FAILURE.roundCrashed]: "这一轮整条路抛了（guest 失联 / RPC 通道断）⇒ 已回收 guest，下轮重建",
  [CARRIER_FAILURE.noCarrierUrl]: "server 说现在没有载体页地址（DSH_ZCODE_INTERNAL_CARRIER=0 或候选端口全被占） ⇒ 这是「安静」的一类，不是故障；本窗口照旧走外挂 chromium",
  [CARRIER_FAILURE.acquireFailed]: "主进程没给出租约（acquire 抛错或形状不对）⇒ 内部载体在此桌面壳不可用"
});
var DEFAULT_CARRIER_TIMING = Object.freeze({
  /** 需求位心跳。必须明显小于 server 侧 `DEFAULT_CARRIER_WAIT_MS`（1.5s），否则那趟有界等待总是先超时。 */
  demandPollMs: 700,
  /** 读 `stage` 的间隔。 */
  mintPollMs: 400,
  /**
   * 一轮产出的预算：12s，**故意压在 20s 时效之下**（再算上下面读数超时的最坏余量共 16s）。
   * 载体页自己那两层超时（SDK 注入 ≤25s、无感验证 ≤60s）都比这里大 —— 等它们跑完只会得到
   * 一发登记时就已超龄的 param，所以到 12s 就判 mint-timeout、换 guest 重来。
   * ⚠ 连带后果（别当成可调参数）：param 的**可用窗口 ≈ 20s − 本轮耗时**。
   *   将来实测出真实时效，该动的是 `PARAM_MAX_AGE_MS`（server 那一份），不是放大这里的预算
   *   —— 放大只会让更多「到手即超龄」的轮次白跑一遍。
   */
  mintTimeoutMs: 12e3,
  /** 导航与起 guest 的超时也算在 `mintTimeoutMs` 之内（锚点在导航之前）⇒ 必须更小才有意义。 */
  navigateTimeoutMs: 8e3,
  domReadyTimeoutMs: 8e3,
  /**
   * 单次 `executeJavaScript` 的兜底（guest 卡住时不能把整轮钉死 —— 这条链历史上挂死过一次）。
   * ⚠ 取 4s：它构成超时判定的**最坏余量**（真正不能越过 `PARAM_MAX_AGE_MS` 的是
   *   `mintTimeoutMs + evaluateTimeoutMs`），由 G 组那条不变式锁着。
   */
  evaluateTimeoutMs: 4e3,
  successCooldownMs: 25e3,
  failureCooldownMs: 3e3
});
var CARRIER_WORKSPACE_KEY = "zcode-captcha-carrier";
var LOG_PREFIX = "[jet-hub] zcode 内部载体";
var LOG_EVERY_REPEAT = 10;
var CARRIER_STATE_EXPRESSION = [
  "(() => {",
  "  const carrier = globalThis.__zcodeCaptcha;",
  '  const mounted = carrier !== null && typeof carrier === "object";',
  "  return JSON.stringify({",
  "    origin: location.origin,",
  "    href: String(location.href).slice(0, 240),",
  "    title: String(document.title).slice(0, 80),",
  "    mounted,",
  '    stage: mounted ? String(carrier.stage === undefined ? "" : carrier.stage) : "",',
  '    param: mounted && typeof carrier.param === "string" ? carrier.param : "",',
  '    error: mounted && typeof carrier.error === "string" ? carrier.error.slice(0, 400) : "",',
  "    interactive: mounted && carrier.interactive === true,",
  "  });",
  "})()"
].join("\n");
function buildProbeExpression(target) {
  return [
    "(async () => {",
    "  try {",
    `    const response = await fetch(${JSON.stringify(target)}, { credentials: "omit", cache: "no-store" });`,
    "    return String(response.status);",
    "  } catch (error) {",
    '    return "-1";',
    "  }",
    "})()"
  ].join("\n");
}
function readDesktopBridge(carrier) {
  const browser = carrier?.protocolVersion === 1 ? carrier?.browser : void 0;
  if (browser === null || typeof browser !== "object") return void 0;
  if (typeof browser.acquire !== "function") return void 0;
  return browser;
}
function classifyCarrierOutcome(observed = {}) {
  const {
    expectedOrigin,
    origin,
    mounted,
    stage,
    loadFailed,
    probeStatus,
    timedOut
  } = observed;
  if (loadFailed === true) return CARRIER_FAILURE.loadFailed;
  if (typeof origin !== "string" || origin.length === 0) {
    return timedOut === true ? CARRIER_FAILURE.mintTimeout : CARRIER_PENDING;
  }
  if (origin !== expectedOrigin) return CARRIER_FAILURE.originMismatch;
  if (stage === "success") return null;
  if (mounted !== true) {
    if (probeStatus === 401 || probeStatus === 403) return CARRIER_FAILURE.unauthenticated;
    if (typeof probeStatus !== "number" || probeStatus === 0) {
      return timedOut === true ? CARRIER_FAILURE.probeFailed : CARRIER_PENDING;
    }
    if (probeStatus < 0) return CARRIER_FAILURE.probeFailed;
    return CARRIER_FAILURE.notCarrierPage;
  }
  if (typeof stage === "string" && stage.length > 0 && stage !== "pending") {
    return CARRIER_FAILURE.mintFailed;
  }
  return timedOut === true ? CARRIER_FAILURE.mintTimeout : CARRIER_PENDING;
}
function buildContributePayload({ param, mintStartedAt, now, interactive }) {
  const elapsed = Math.round(Number(now()) - Number(mintStartedAt));
  const elapsedMs = Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
  return { param, elapsedMs, interactive: interactive === true };
}
function textOf(error) {
  if (error === null || error === void 0) return "未知错误";
  if (typeof error === "string") return error;
  return String(error.message ?? error);
}
function defaultLog(level, message) {
  const sink = typeof console !== "undefined" ? console[level] ?? console.log : void 0;
  if (typeof sink === "function") sink.call(console, message);
}
function startCarrierContribution(options = {}) {
  const log = typeof options.log === "function" ? options.log : defaultLog;
  const desktop = options.desktop === void 0 ? globalThis.dshDesktop : options.desktop;
  const bridge = readDesktopBridge(desktop);
  if (bridge === void 0) return () => {
  };
  const rpcCall = options.rpcCall;
  if (typeof rpcCall !== "function") {
    log("warn", `${LOG_PREFIX} 未启动：没有 rpcCall（demand 问不到，产了也没人收）`);
    return () => {
    };
  }
  const doc = options.doc === void 0 ? globalThis.document : options.doc;
  if (doc === null || typeof doc !== "object") {
    log("warn", `${LOG_PREFIX} 未启动：没有 document（webview 元素挂不上去）`);
    return () => {
    };
  }
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const timing = { ...DEFAULT_CARRIER_TIMING, ...options.timing ?? {} };
  let stopped = false;
  let timer = null;
  let running = false;
  let guest = null;
  let lease = null;
  let lastReason = null;
  let repeat = 0;
  const sleep = (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
  function schedule(delayMs) {
    if (stopped) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, delayMs);
  }
  function reportFailure(reason, detail) {
    if (lastReason === reason) repeat += 1;
    else {
      lastReason = reason;
      repeat = 1;
    }
    if (repeat > 1 && repeat % LOG_EVERY_REPEAT !== 0) return;
    const label = CARRIER_FAILURE_LABELS[reason] ?? "未登记的失败分类（这本身就是个缺陷）";
    const tail = repeat > 1 ? `（同类第 ${String(repeat)} 次）` : "";
    log("warn", `${LOG_PREFIX} 本轮未产出：${label} [reason=${reason}]${detail === void 0 || detail === "" ? "" : ` ${detail}`}${tail}`);
  }
  function resetFailureStreak() {
    lastReason = null;
    repeat = 0;
  }
  async function resolveCarrierTarget() {
    const answer = await rpcCall("captcha.carrierUrl", {});
    const raw = answer?.url;
    if (typeof raw !== "string" || raw.length === 0) return null;
    let url;
    try {
      url = new URL(raw);
    } catch (error) {
      return null;
    }
    if (url.protocol !== "http:") return null;
    return { origin: url.origin, target: url.toString() };
  }
  function destroyGuest(note) {
    const element = guest;
    const id = lease;
    guest = null;
    lease = null;
    if (element !== null) {
      try {
        element.remove();
      } catch (error) {
      }
      if (typeof note === "string" && note.length > 0) {
        log("info", `${LOG_PREFIX} ${note}`);
      }
    }
    if (id !== null && id !== void 0 && typeof bridge.release === "function") {
      try {
        Promise.resolve(bridge.release(id)).catch(() => {
        });
      } catch (error) {
      }
    }
  }
  function onGuestReclaimed() {
    destroyGuest("guest 被主进程回收（render-process-gone / destroyed）⇒ 下一轮重建");
  }
  async function ensureGuest() {
    if (stopped) throw new Error("循环已停止");
    if (guest !== null && doc.body?.contains?.(guest) === true) return guest;
    if (guest !== null) destroyGuest();
    let reservation;
    try {
      reservation = await bridge.acquire(CARRIER_WORKSPACE_KEY);
    } catch (error) {
      reportFailure(CARRIER_FAILURE.acquireFailed, textOf(error));
      return null;
    }
    const id = reservation?.lease;
    const partition = reservation?.partition;
    if (typeof id !== "string" || id.length === 0 || typeof partition !== "string" || partition.length === 0) {
      reportFailure(CARRIER_FAILURE.acquireFailed, `租约形状异常：lease=${String(id)} partition=${String(partition)}`);
      if (typeof id === "string" && id.length > 0) {
        Promise.resolve(bridge.release?.(id)).catch(() => {
        });
      }
      return null;
    }
    if (stopped) {
      Promise.resolve(bridge.release?.(id)).catch(() => {
      });
      return null;
    }
    if (doc.body === null || doc.body === void 0) {
      reportFailure(CARRIER_FAILURE.roundCrashed, "GUI 文档还没有 body ⇒ webview 挂不上去");
      Promise.resolve(bridge.release?.(id)).catch(() => {
      });
      return null;
    }
    lease = id;
    const element = doc.createElement("webview");
    element.setAttribute("name", id);
    element.setAttribute("partition", partition);
    element.setAttribute("src", `about:blank#${id}`);
    if (element.style !== void 0 && element.style !== null) {
      Object.assign(element.style, {
        position: "fixed",
        left: "-99999px",
        top: "0",
        width: "420px",
        height: "320px",
        opacity: "0.01",
        pointerEvents: "none",
        zIndex: "-1"
      });
    }
    element.addEventListener("render-process-gone", onGuestReclaimed);
    element.addEventListener("destroyed", onGuestReclaimed);
    guest = element;
    const readySignal = waitForEvent(element, "dom-ready", timing.domReadyTimeoutMs);
    doc.body.append(element);
    const ready = await readySignal;
    if (ready !== true) {
      reportFailure(CARRIER_FAILURE.roundCrashed, `等 dom-ready 超时（${String(timing.domReadyTimeoutMs)}ms 内 guest 没起来）`);
      destroyGuest();
      return null;
    }
    return element;
  }
  function waitForEvent(element, name2, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const cleanup = () => {
        clearTimeout(timerHandle);
        element.removeEventListener(name2, onEvent);
      };
      const onEvent = () => {
        if (done) return;
        done = true;
        cleanup();
        resolve(true);
      };
      const timerHandle = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        resolve(null);
      }, timeoutMs);
      element.addEventListener(name2, onEvent);
    });
  }
  async function navigateGuest(element, url) {
    const outcome = new Promise((resolve) => {
      let done = false;
      const cleanup = () => {
        clearTimeout(timerHandle);
        element.removeEventListener("did-finish-load", onFinish);
        element.removeEventListener("did-fail-load", onFail);
      };
      const finish = (value) => {
        if (done) return;
        done = true;
        cleanup();
        resolve(value);
      };
      const onFinish = () => {
        finish({ ok: true });
      };
      const onFail = (event) => {
        if (event?.isMainFrame === false) return;
        if (event?.errorCode === -3) return;
        finish({
          ok: false,
          errorCode: event?.errorCode,
          errorDescription: String(event?.errorDescription ?? "")
        });
      };
      const timerHandle = setTimeout(() => {
        finish({ ok: false, errorDescription: `导航超时 ${String(timing.navigateTimeoutMs)}ms` });
      }, timing.navigateTimeoutMs);
      element.addEventListener("did-finish-load", onFinish);
      element.addEventListener("did-fail-load", onFail);
    });
    try {
      if (typeof element.loadURL === "function") {
        Promise.resolve(element.loadURL(url)).catch(() => {
        });
      } else {
        element.setAttribute("src", url);
      }
    } catch (error) {
      return { ok: false, errorDescription: textOf(error) };
    }
    return outcome;
  }
  async function evaluateRaw(element, expression, what) {
    if (typeof element.executeJavaScript !== "function") {
      throw new Error(`${what}：这个 guest 不支持 executeJavaScript`);
    }
    const running$ = Promise.resolve(element.executeJavaScript(expression)).then((value) => ({ kind: "value", value }), (error) => ({ kind: "error", error }));
    const settled = await Promise.race([running$, sleep(timing.evaluateTimeoutMs).then(() => ({ kind: "timeout" }))]);
    if (settled.kind === "error") throw settled.error instanceof Error ? settled.error : new Error(textOf(settled.error));
    if (settled.kind === "timeout") throw new Error(`${what} 超时（${String(timing.evaluateTimeoutMs)}ms）`);
    return settled.value;
  }
  async function evaluateJson(element, expression, what) {
    const raw = await evaluateRaw(element, expression, what);
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  }
  function detailOf(state, probeStatus, waitedMs, load) {
    const bits = [];
    if (load?.ok === false) bits.push(`load=${String(load.errorCode ?? "")} ${load.errorDescription || "未知导航失败"}`);
    if (typeof probeStatus === "number" && probeStatus !== 0) bits.push(`status=${String(probeStatus)}`);
    bits.push(`origin=${String(state.origin ?? "")}`);
    if (typeof state.href === "string" && state.href.length > 0) bits.push(`href=${state.href}`);
    if (typeof state.title === "string" && state.title.length > 0) bits.push(`title="${state.title}"`);
    bits.push(`mounted=${String(state.mounted === true)}`);
    bits.push(`stage=${String(state.stage ?? "")}`);
    if (typeof state.error === "string" && state.error.length > 0) bits.push(`pageError=${state.error}`);
    bits.push(`waitedMs=${String(waitedMs)}`);
    return bits.join(" ");
  }
  async function produceOnce() {
    const carrier = await resolveCarrierTarget();
    if (carrier === null) {
      reportFailure(CARRIER_FAILURE.noCarrierUrl, "captcha.carrierUrl 回 null（本轮不建 guest、不导航）");
      return false;
    }
    const { origin, target } = carrier;
    const element = await ensureGuest();
    if (element === null || element === void 0) return false;
    const mintStartedAt = now();
    const probeExpression = buildProbeExpression(target);
    const load = await navigateGuest(element, target);
    if (stopped) return false;
    let probeStatus;
    for (; ; ) {
      if (stopped || guest !== element) return false;
      const state = load.ok === true ? await evaluateJson(element, CARRIER_STATE_EXPRESSION, "读载体页状态") : {};
      if (state.mounted !== true && state.origin === origin && probeStatus === void 0) {
        const probed = Number(await evaluateRaw(element, probeExpression, "读载体页状态码"));
        probeStatus = Number.isFinite(probed) ? probed : -1;
      }
      const waitedMs = Math.max(0, now() - mintStartedAt);
      const reason = classifyCarrierOutcome({
        expectedOrigin: origin,
        origin: state.origin,
        mounted: state.mounted,
        stage: state.stage,
        loadFailed: load.ok !== true,
        probeStatus,
        timedOut: waitedMs > timing.mintTimeoutMs
      });
      if (reason === CARRIER_PENDING) {
        await sleep(timing.mintPollMs);
        continue;
      }
      if (reason === null) return await contribute(element, state, mintStartedAt);
      reportFailure(reason, detailOf(state, probeStatus, waitedMs, load));
      if (reason === CARRIER_FAILURE.loadFailed || reason === CARRIER_FAILURE.mintTimeout || reason === CARRIER_FAILURE.mintFailed || reason === CARRIER_FAILURE.notCarrierPage || reason === CARRIER_FAILURE.probeFailed) destroyGuest();
      return false;
    }
  }
  async function contribute(element, state, mintStartedAt) {
    const payload = buildContributePayload({
      param: state.param ?? "",
      mintStartedAt,
      now,
      interactive: state.interactive === true
    });
    if (stopped || guest !== element) return false;
    const result = await rpcCall("captcha.contribute", payload);
    if (result?.accepted === true) {
      resetFailureStreak();
      log("info", `${LOG_PREFIX} 已贡献一个 param：elapsedMs=${String(payload.elapsedMs)}ms（从「本轮开始产」起算，含导航 + SDK + 等待 ⇒ server 拿它反推产出时刻）、paramLen=${String(payload.param.length)} 字符${payload.interactive ? "、已被降级成交互式验证（设备信誉预警，已回传 host）" : ""}`);
      return true;
    }
    reportFailure(
      CARRIER_FAILURE.slotRejected,
      `accepted=${String(result?.accepted)} 耗时=${String(payload.elapsedMs)}ms paramLen=${String(payload.param.length)}${payload.interactive ? " interactive=true" : ""}`
    );
    destroyGuest();
    return false;
  }
  async function tick() {
    if (stopped || running) return;
    running = true;
    let nextDelay = timing.demandPollMs;
    try {
      const demand = await rpcCall("captcha.demand", {});
      if (!stopped && demand?.active === true) {
        nextDelay = await produceOnce() ? timing.successCooldownMs : timing.failureCooldownMs;
      } else if (guest !== null) {
        destroyGuest("需求位已落下 ⇒ 归还 webview 租约（不留常驻离屏 renderer）");
      }
    } catch (error) {
      destroyGuest();
      if (!stopped) reportFailure(CARRIER_FAILURE.roundCrashed, textOf(error));
      nextDelay = timing.failureCooldownMs;
    } finally {
      running = false;
    }
    if (!stopped) schedule(nextDelay);
  }
  schedule(timing.demandPollMs);
  return () => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    destroyGuest();
  };
}

// plugin-src/client/usage-badge.js
var React4 = __toESM(require("react"), 1);
var import_react_dom = require("react-dom");

// plugin-src/client/badge-model.js
var BADGE_PREFERENCES = Object.freeze(["auto", "subscription", "credits"]);
var DEFAULT_BADGE_PREFERENCE = "auto";
var AGGREGATE_PROVIDER_ID = "aggregate";
var AUTO_PROVIDER_ID = "jet-hub-auto";
function resolveBadgeProvider(provider, active) {
  if (typeof provider !== "string" || provider.length === 0) return null;
  if (provider !== AGGREGATE_PROVIDER_ID) return provider;
  const resolved = typeof active === "object" && active !== null ? active.provider : null;
  if (typeof resolved !== "string" || resolved.length === 0) return null;
  if (resolved === AGGREGATE_PROVIDER_ID) return null;
  return resolved;
}
var BADGE_SEP = " • ";
var HOST_STALE_HINT = "插件宿主未加载最新版本，请重启 DSH 后重试";
function describeBadgeError(error, fallback = "") {
  const message = typeof error?.message === "string" ? error.message : "";
  if (message.includes("unknown method")) return HOST_STALE_HINT;
  if (message.includes("unsupported provider")) return HOST_STALE_HINT;
  return message.length > 0 ? message : fallback;
}
var BADGE_PREFERENCE_LABELS = Object.freeze({
  auto: "自动",
  subscription: "优先订阅",
  credits: "只看积分"
});
function normalizeBadgePreference(value) {
  return BADGE_PREFERENCES.includes(value) ? value : DEFAULT_BADGE_PREFERENCE;
}
function windowPreview(windows, limit = 2) {
  const list = Array.isArray(windows) ? windows : [];
  return quotaWindowsOf(list).slice(0, limit).map(([type, label, win]) => ({ type, label, percent: quotaPercentValue(win?.percentUsed) }));
}
function creditGroupsOf(accounts) {
  const rows = Array.isArray(accounts) ? accounts : [];
  const byUnit = /* @__PURE__ */ new Map();
  let failedCount = 0;
  let okCount = 0;
  for (const row of rows) {
    const balance = row?.balance;
    if (!balance || typeof balance.total !== "number" || !Number.isFinite(balance.total)) {
      failedCount += 1;
      continue;
    }
    okCount += 1;
    const rawUnit = firstUnitOf(balance.packages) ?? "";
    const unit = rawUnit === QUOTA_UNIT ? QUOTA_UNIT : normalizeUnit(rawUnit);
    const group = byUnit.get(unit) ?? { unit, label: unitLabel(unit), total: 0, accountCount: 0 };
    group.total += balance.total;
    group.accountCount += 1;
    if (unit === QUOTA_UNIT) {
      const line = formatQuotaLine(balance.packages, unit);
      group.quotaLines = group.quotaLines ?? [];
      group.quotaRemainings = group.quotaRemainings ?? [];
      group.quotaWindows = group.quotaWindows ?? /* @__PURE__ */ new Map();
      if (line !== null) group.quotaLines.push(line);
      for (const pkg of Array.isArray(balance.packages) ? balance.packages : []) {
        if (!pkg) continue;
        const remaining = pkg.remaining;
        if (typeof remaining !== "number" || !Number.isFinite(remaining)) continue;
        group.quotaRemainings.push(remaining);
        const name2 = pkg.name || "未命名";
        const prev = group.quotaWindows.get(name2);
        if (prev === void 0 || remaining < prev) group.quotaWindows.set(name2, remaining);
      }
    }
    byUnit.set(unit, group);
  }
  const groups = [...byUnit.values()].sort((a, b) => a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0);
  return { groups, failedCount, okCount };
}
function planGroupsOf(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const byKey = /* @__PURE__ */ new Map();
  for (const row of list) {
    const plan = row?.plan;
    if (!plan) continue;
    const unit = normalizeUnit(typeof plan.unit === "string" ? plan.unit : "");
    const key = `${String(plan.name)}\0${unit}`;
    const group = byKey.get(key) ?? {
      name: String(plan.name),
      unit,
      label: unitLabel(unit),
      remaining: 0,
      total: 0,
      accountCount: 0,
      deductionEndTime: void 0
    };
    group.remaining += Number(plan.remaining) || 0;
    group.total += Number(plan.total) || 0;
    group.accountCount += 1;
    const end = typeof plan.deductionEndTime === "number" && Number.isFinite(plan.deductionEndTime) ? plan.deductionEndTime : void 0;
    if (end !== void 0 && (group.deductionEndTime === void 0 || end < group.deductionEndTime)) {
      group.deductionEndTime = end;
    }
    byKey.set(key, group);
  }
  return [...byKey.values()].sort((a, b) => b.remaining - a.remaining);
}
function badgeView(input) {
  const providerLabel2 = String(input?.providerLabel ?? "Jet Hub");
  const preference = normalizeBadgePreference(input?.preference);
  const accounts = Array.isArray(input?.accounts) ? input.accounts : [];
  const subscription = input?.subscription;
  const loading = input?.loading === true;
  const failed = input?.failed === true;
  const placeholder = (mode2, reading2, tone) => ({
    mode: mode2,
    preference,
    name: providerLabel2,
    detail: "",
    reading: reading2,
    text: composeText(providerLabel2, "", reading2),
    tone,
    groups: [],
    planGroups: [],
    windows: [],
    failedCount: 0,
    okCount: 0,
    failureReason: "",
    incompleteNote: ""
  });
  if (loading) return placeholder("loading", "读取中…", "muted");
  if (failed && accounts.length === 0) return placeholder("empty", "用量不可用", "error");
  const { groups, failedCount, okCount } = creditGroupsOf(accounts);
  const windowRows = subscription?.kind === "windows" && Array.isArray(subscription.accounts) ? subscription.accounts : [];
  const windowAccount = windowRows.find((row) => row?.ok === true) ?? windowRows[0];
  const windows = windowAccount === void 0 ? [] : windowPreview(windowAccount.windows);
  const planGroups = subscription?.kind === "plan" ? planGroupsOf(subscription.accounts) : [];
  const failureReason = firstFailureReason(accounts);
  const candidates = preference === "subscription" ? ["windows", "plan", "credits"] : preference === "credits" ? ["credits"] : ["credits", "windows", "plan"];
  const hasContent = {
    credits: groups.length > 0,
    windows: windows.length > 0,
    plan: planGroups.length > 0
  };
  const mode = candidates.find((candidate) => hasContent[candidate]) ?? "empty";
  const { detail, reading } = readingOf({ mode, windows, planGroups, groups, accounts, failedCount });
  const incompleteNote = mode === "credits" && okCount > 0 && failedCount > 0 ? `另有 ${failedCount} 个账号的余额读取失败，未计入合计` : "";
  return {
    mode,
    preference,
    name: providerLabel2,
    detail,
    reading,
    text: composeText(providerLabel2, detail, reading),
    tone: toneOf({ mode, windows, planGroups, groups, accounts }),
    groups,
    planGroups,
    windows,
    failedCount,
    okCount,
    failureReason,
    incompleteNote
  };
}
function composeText(name2, detail, reading) {
  const middle = detail === "" ? "" : `${detail} `;
  return `${name2}${BADGE_SEP}${middle}${reading}`;
}
function readingOf({ mode, windows, planGroups, groups, accounts, failedCount }) {
  if (mode === "windows") {
    const parts = windows.map((win) => `${win.label} ${win.percent}%`);
    return { detail: "", reading: parts.join(" · ") };
  }
  if (mode === "plan") {
    const best = planGroups[0];
    const range = `${formatUnits(best.remaining, best.unit) ?? "?"} / ${formatUnits(best.total, best.unit) ?? "?"}`;
    return { detail: best.name, reading: `${range}${best.label}` };
  }
  if (mode === "credits") {
    const quotaGroup = groups.find((group) => group.unit === QUOTA_UNIT);
    if (quotaGroup !== void 0) {
      const windows2 = quotaGroup.quotaWindows;
      if (windows2 !== void 0 && windows2.size > 0) {
        const parts2 = [...windows2.entries()].map(([name2, remaining]) => `${name2} ${formatQuota(remaining) ?? "?"}`);
        if (parts2.length > 0) return { detail: "", reading: parts2.join(" · ") };
      }
      const lines = quotaGroup.quotaLines ?? [];
      if (lines.length === 0) return { detail: "", reading: "额度不可用" };
      return { detail: "", reading: lines.join(" · ") };
    }
    const parts = groups.map((group) => `${formatUnits(group.total, group.unit) ?? "?"}${group.label}`);
    return { detail: "", reading: parts.join(" · ") };
  }
  return { detail: "", reading: accounts.length > 0 && failedCount > 0 ? "用量不可用" : "未配置启用账号" };
}
function toneOf({ mode, windows, planGroups, groups, accounts }) {
  if (mode === "windows") {
    return quotaTone(Math.max(...windows.map((win) => win.percent)));
  }
  if (mode === "plan") return planGroups[0].remaining > 0 ? "ok" : "warn";
  if (mode === "credits") {
    const quotaGroup = groups.find((group) => group.unit === QUOTA_UNIT);
    if (quotaGroup !== void 0) {
      const remainings = quotaGroup.quotaRemainings ?? [];
      return remainings.length === 0 ? "warn" : quotaTone(100 - Math.min(...remainings));
    }
    return groups.some((group) => group.total > 0) ? "ok" : "warn";
  }
  return accounts.length > 0 ? "error" : "muted";
}
function firstFailureReason(accounts) {
  for (const row of accounts) {
    if (typeof row?.error === "string" && row.error.length > 0) return row.error;
  }
  return "";
}
function firstUnitOf(packages) {
  if (!Array.isArray(packages)) return void 0;
  const hit = packages.find((pkg) => pkg && typeof pkg.unit === "string" && pkg.unit.length > 0);
  return hit === void 0 ? void 0 : hit.unit;
}
function balanceOrder(row) {
  const total = row?.balance?.total;
  return typeof total === "number" && Number.isFinite(total) ? total : Number.NEGATIVE_INFINITY;
}
function orderCreditRows(rows, options = {}) {
  const limit = Number.isFinite(options.limit) ? options.limit : 0;
  const ordered = [...Array.isArray(rows) ? rows : []].sort((a, b) => balanceOrder(b) - balanceOrder(a));
  const hidden = Math.max(0, ordered.length - limit);
  return { shown: options.expanded === true ? ordered : ordered.slice(0, limit), hidden };
}
function autoBadgeName(options = {}) {
  const fallback = typeof options.fallback === "string" ? options.fallback : "";
  const target = options.autoActual;
  if (typeof target !== "object" || target === null || typeof target.provider !== "string" || target.provider.length === 0) {
    return fallback;
  }
  const labelOf = typeof options.providerLabel === "function" ? options.providerLabel : (id) => id;
  const shortName = shortProviderName(labelOf(target.provider)) || target.provider;
  let name2 = `自动 → ${shortName}${typeof target.model === "string" && target.model.length > 0 ? ` ${target.model}` : ""}`;
  const price = options.price;
  if (typeof price === "number" && Number.isFinite(price)) {
    name2 += ` ${price === 0 ? "免费" : `x${price}`}`;
  }
  if (target.viaImageFallback === true) name2 += "（图）";
  const expiryAt = options.expiryAt;
  if (typeof expiryAt === "number" && Number.isFinite(expiryAt)) {
    const text = expiryCountdownText(expiryAt, options.now);
    if (text.length > 0) name2 += ` · ${text}`;
  }
  return name2;
}
function expiryCountdownText(at, now = Date.now()) {
  if (typeof at !== "number") return "";
  const d = new Date(at);
  if (!Number.isFinite(d.getTime())) return "";
  const n = new Date(now);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return `${sameDay ? "今日" : `${d.getMonth() + 1}/${d.getDate()} `}${hm}过期`;
}
function shortProviderName(name2) {
  return String(name2 ?? "").replace(/\s*[（(][^)）]*[)）]\s*/g, "").trim();
}
function creditSectionLabel(groups) {
  const list = Array.isArray(groups) ? groups.filter((g) => g && typeof g.unit === "string") : [];
  const quotaGroup = list.find((g) => g.unit === QUOTA_UNIT);
  if (quotaGroup !== void 0) return unitLabel(quotaGroup.unit);
  if (list.length === 0) return unitLabel(void 0);
  return unitLabel(list[0].unit);
}
function formatUpdatedAt(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return "";
  const at = new Date(value);
  const pad = (part) => String(part).padStart(2, "0");
  return `${at.getFullYear()}/${at.getMonth() + 1}/${at.getDate()} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

// plugin-src/client/usage-badge.js
var POPOVER_ANCHOR_STYLE = Object.freeze({
  position: "absolute",
  right: 0,
  bottom: "calc(100% + 8px)",
  maxHeight: "58vh",
  overflowY: "auto",
  zIndex: 40
});
var NARROW_BREAKPOINT_PX = 720;
function isNarrowViewport() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(`(max-width: ${NARROW_BREAKPOINT_PX}px)`).matches;
}
var NARROW_POPOVER_STYLE = Object.freeze({
  position: "fixed",
  left: 8,
  right: 8,
  top: "auto",
  bottom: "calc(env(safe-area-inset-bottom, 0px) + var(--dsh-composer-height, 152px))",
  width: "auto",
  maxWidth: "none",
  maxHeight: "max(120px, calc(100dvh - 160px))",
  overflowY: "auto",
  zIndex: 1200
});
var COMPOSER_HEIGHT_FALLBACK_PX = 152;
function readComposerHeightPx(anchor) {
  if (typeof window === "undefined" || typeof window.getComputedStyle !== "function") {
    return COMPOSER_HEIGHT_FALLBACK_PX;
  }
  let node = anchor;
  while (node !== null && node !== void 0) {
    const raw = window.getComputedStyle(node).getPropertyValue("--dsh-composer-height").trim();
    if (raw !== "") {
      const parsed = Number.parseFloat(raw);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    node = node.parentElement;
  }
  return COMPOSER_HEIGHT_FALLBACK_PX;
}
var BADGE_POLL_MS = 6e4;
var ACTIVE_PROVIDER_POLL_MS = 5e3;
var CLAIM_NOTICE_MS = 8e3;
var CLAIM_NOTICE_WARN_MS = 2e4;
var CREDITS_COLLAPSED_LIMIT = 5;
var RESOLVE_RETRY_DELAYS = [300, 700, 1500, 2e3];
function UsageBadge(props) {
  const resolveDirectory = props.resolveDirectory;
  const [directory, setDirectory] = React4.useState(null);
  const resolvedRef = React4.useRef(false);
  const snapshotErrorRef = React4.useRef(false);
  React4.useEffect(() => {
    if (typeof resolveDirectory !== "function") return void 0;
    if (resolvedRef.current) return void 0;
    let alive = true;
    const timers = [];
    let attempt = 0;
    const tryResolve = () => {
      if (!alive || resolvedRef.current) return;
      let resolved = null;
      try {
        resolved = resolveDirectory();
      } catch {
        resolved = null;
      }
      if (!alive) return;
      if (resolved !== null && resolved !== void 0 && resolved.store !== void 0) {
        resolvedRef.current = true;
        const store = resolved.store;
        setDirectory(store);
        if (typeof resolved.load === "function") {
          Promise.resolve(resolved.load()).catch((error) => {
            console.warn("[jet-hub usage] 目录 load() 失败，徽标将不显示：", error);
          });
        }
        return;
      }
      attempt += 1;
      if (attempt >= RESOLVE_RETRY_DELAYS.length) {
        console.warn("[jet-hub usage] 目录解析最终失败，徽标不显示");
        return;
      }
      timers.push(setTimeout(tryResolve, RESOLVE_RETRY_DELAYS[attempt - 1]));
    };
    tryResolve();
    return () => {
      alive = false;
      for (const timer of timers) clearTimeout(timer);
    };
  }, [resolveDirectory]);
  const safe = (fn) => () => {
    try {
      return directory ? fn(directory) : void 0;
    } catch (error) {
      if (!snapshotErrorRef.current) {
        snapshotErrorRef.current = true;
        console.warn("[jet-hub usage] 读目录快照失败（store 上应有 getSnapshot）:", error);
      }
      return void 0;
    }
  };
  const state = React4.useSyncExternalStore(
    // ⚠️ 订阅要**真的转发 onChange**（用户切模型时徽标跟着更新）；
    // try/catch 只为把「订阅时才发现抛错」这一类也收进徽标内部。
    (onChange) => {
      if (!directory) return () => {
      };
      try {
        return directory.subscribe(onChange);
      } catch {
        return () => {
        };
      }
    },
    safe((d) => d.getSnapshot()),
    safe((d) => d.getSnapshot())
  );
  let provider = state?.current?.provider;
  const modelId = state?.current?.model;
  const readActiveProvider = props.readActiveProvider;
  const [activeProvider, setActiveProvider] = React4.useState(null);
  const isAggregate = provider === AGGREGATE_PROVIDER_ID;
  React4.useEffect(() => {
    if (!isAggregate || typeof readActiveProvider !== "function") return void 0;
    let alive = true;
    let timer = null;
    const refresh = () => {
      Promise.resolve().then(() => readActiveProvider(modelId)).then((value) => {
        if (!alive) return;
        setActiveProvider(value?.provider ?? null);
      }).catch(() => {
        if (alive) setActiveProvider(null);
      });
    };
    refresh();
    timer = setInterval(refresh, ACTIVE_PROVIDER_POLL_MS);
    return () => {
      alive = false;
      if (timer !== null) clearInterval(timer);
    };
  }, [isAggregate, readActiveProvider, modelId]);
  if (isAggregate) {
    provider = resolveBadgeProvider(provider, activeProvider === null ? null : { provider: activeProvider });
  }
  if (isAggregate && provider === null) {
    return React4.createElement("span", {
      className: "dim-jh-badgePending",
      role: "status",
      title: "聚合（跨渠道）：尚未发出过请求，还不知道会走哪个渠道。发送一条消息后这里会显示实际使用的渠道与积分。"
    }, [
      React4.createElement("span", { key: "dot", className: "dim-jh-badgeDot", "data-tone": "muted" }),
      React4.createElement("span", { key: "text" }, "聚合 · 待首次请求")
    ]);
  }
  if (typeof provider !== "string" || provider.length === 0) return null;
  if (provider === AUTO_PROVIDER_ID) {
    return React4.createElement(UsageBadgeActive, { ...props, provider });
  }
  if (!supportsCreditBalance(provider)) return null;
  return React4.createElement(UsageBadgeActive, { ...props, provider });
}
function UsageBadgeActive(props) {
  const { provider, providerLabel: providerLabel2, readBadge, writePreference, setAutoCheckin, dismissAutoCheckin, claimCredits } = props;
  const label = providerLabel2(provider);
  const [snapshot, setSnapshot] = React4.useState(null);
  const [failed, setFailed] = React4.useState(false);
  const [readError, setReadError] = React4.useState("");
  const [busy, setBusy] = React4.useState(false);
  const [open, setOpen] = React4.useState(false);
  const [preference, setPreference] = React4.useState(null);
  const [prefError, setPrefError] = React4.useState("");
  const [autoError, setAutoError] = React4.useState("");
  const [claiming, setClaiming] = React4.useState(null);
  const [claimProgress, setClaimProgress] = React4.useState(null);
  const [claimNotice, setClaimNotice] = React4.useState(null);
  const [creditsExpanded, setCreditsExpanded] = React4.useState(false);
  const root = React4.useRef(null);
  const popRef = React4.useRef(null);
  const read = React4.useRef(() => {
  });
  const claimInFlightRef = React4.useRef(false);
  React4.useEffect(() => {
    ensureJetHubStyles();
    if (!open) return;
    const element = popRef.current;
    if (element === null) return;
    const position = window.getComputedStyle(element).position;
    if (position !== "absolute" && position !== "fixed") {
      console.warn(`[jet-hub] 浮层定位异常（position=${position}）：会撑高输入区（检查 POPOVER_ANCHOR_STYLE / NARROW_POPOVER_STYLE 是否被改坏）`);
    }
  }, [open]);
  React4.useEffect(() => {
    setSnapshot(null);
    setFailed(false);
    setClaimNotice(null);
    setPrefError("");
    setAutoError("");
    setCreditsExpanded(false);
  }, [provider]);
  React4.useEffect(() => {
    let alive = true;
    let inFlight = false;
    const load = async (options = {}) => {
      if (inFlight) return;
      const force = options.force === true;
      if (options.poll === true && typeof document !== "undefined" && document.visibilityState === "hidden") return;
      inFlight = true;
      if (force) setBusy(true);
      try {
        const value2 = await readBadge(provider, force ? { force: true } : {});
        if (!alive) return;
        if (value2?.provider !== void 0 && value2.provider !== provider) return;
        setSnapshot({ value: value2, at: Date.now() });
        setFailed(false);
        setReadError("");
      } catch (error) {
        if (alive) {
          setFailed(true);
          setReadError(describeBadgeError(error));
        }
      } finally {
        inFlight = false;
        if (alive && force) setBusy(false);
      }
    };
    read.current = () => {
      void load({ force: true });
    };
    void load();
    const timer = setInterval(() => {
      void load({ poll: true });
    }, BADGE_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load({ poll: true });
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      read.current = () => {
      };
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [provider, readBadge]);
  React4.useEffect(() => {
    if (!open) return void 0;
    const onDown = (event) => {
      if (!(event.target instanceof Node)) return;
      const insideRoot = root.current !== null && root.current.contains(event.target);
      const insidePop = popRef.current !== null && popRef.current.contains(event.target);
      if (!insideRoot && !insidePop) setOpen(false);
    };
    const onKey = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  React4.useEffect(() => {
    if (claimNotice === null) return void 0;
    const ms = claimNotice.tone === "warn" ? CLAIM_NOTICE_WARN_MS : CLAIM_NOTICE_MS;
    const timer = setTimeout(() => setClaimNotice(null), ms);
    return () => clearTimeout(timer);
  }, [claimNotice]);
  const value = snapshot?.value;
  const effectivePreference = preference ?? value?.preference ?? "auto";
  const badgeName = autoBadgeName({
    fallback: label,
    autoActual: value?.autoActual,
    price: value?.autoPrice,
    expiryAt: value?.autoExpiryAt,
    providerLabel: providerLabel2
  });
  const view = badgeView({
    providerLabel: badgeName,
    preference: effectivePreference,
    subscription: value?.subscription,
    accounts: value?.accounts ?? [],
    loading: snapshot === null && !failed,
    failed: failed && snapshot === null
  });
  const auto = value?.autoCheckin;
  const onToggleAutoCheckin = async () => {
    if (auto === void 0) return;
    const next = auto.enabled !== true;
    setAutoError("");
    try {
      await setAutoCheckin(next);
      read.current();
      if (next) setTimeout(() => read.current(), 12e3);
    } catch (error) {
      setAutoError(describeBadgeError(error, "自动签到开关保存失败"));
    }
  };
  const onDismissAuto = async () => {
    setAutoError("");
    try {
      await dismissAutoCheckin();
      read.current();
    } catch (error) {
      setAutoError(describeBadgeError(error, "关闭自动签到状态失败"));
    }
  };
  const autoTitle = (() => {
    const what = "自动签到开关";
    if (auto === void 0) return `${what}：状态读取中…`;
    if (auto.enabled !== true) {
      return `${what}（当前：关闭）—— 点击开启后，每天首次启动 DSH 时会自动为全部渠道签到一次`;
    }
    if (auto.running === true) return `${what}（当前：开启，正在执行）—— 串行遍历有账号的渠道，请稍候`;
    const last = auto.lastResult === "" ? "" : `；上次：${auto.lastResult}`;
    if (auto.ranToday === true) return `${what}（当前：开启，今天已完成）${last} —— 点击关闭`;
    return `${what}（当前：开启，今天尚未执行）—— 每天首次启动 DSH 时自动签到${last}；点击关闭`;
  })();
  const autoState = auto === void 0 || auto.enabled !== true ? "off" : auto.ranToday === true ? "done" : "on";
  const withAutoSuffix = (label2) => auto?.enabled === true ? `${label2}（自动）` : label2;
  const onPickPreference = async (next) => {
    setPreference(next);
    setPrefError("");
    try {
      await writePreference(next);
    } catch (error) {
      setPreference(null);
      setPrefError(describeBadgeError(error, "偏好保存失败"));
    }
  };
  const onClaim = async () => {
    if (claimInFlightRef.current) {
      setClaimNotice({
        tone: "warn",
        text: "上一次签到仍在进行中，请等它结束。",
        notes: []
      });
      return;
    }
    claimInFlightRef.current = true;
    setClaiming("current");
    setClaimNotice(null);
    try {
      const result = await claimCredits(provider);
      setClaimNotice(summarizeClaim(result));
      read.current();
    } catch (error) {
      setClaimNotice({ tone: "warn", text: error?.message || "签到失败", notes: [] });
    } finally {
      claimInFlightRef.current = false;
      setClaiming(null);
    }
  };
  const onClaimAll = async () => {
    if (claimInFlightRef.current) {
      setClaimNotice({
        tone: "warn",
        text: "上一次签到仍在进行中，请等它结束。",
        notes: []
      });
      return;
    }
    claimInFlightRef.current = true;
    try {
      const providers = checkinProviders();
      setClaiming("all");
      setClaimNotice(null);
      setClaimProgress({ done: 0, total: providers.length });
      const parts = [];
      const notes = [];
      const totalByUnit = { token: 0, credit: 0 };
      let failed2 = 0;
      for (let index = 0; index < providers.length; index += 1) {
        const id = providers[index];
        try {
          const result = await claimCredits(id);
          const summary = result?.summary || {};
          const bits = [];
          if (summary.claimed > 0) {
            const byUnit = summary.totalByUnit || { credit: summary.totalCredit, token: 0 };
            totalByUnit.credit += Number(byUnit.credit) || 0;
            totalByUnit.token += Number(byUnit.token) || 0;
            const amount = formatClaimGains(byUnit);
            if (amount !== null) bits.push(amount);
          }
          if (summary.alreadyClaimed > 0) bits.push(`${summary.alreadyClaimed} 个今日已领`);
          if (summary.inactive > 0) bits.push(`${summary.inactive} 个暂无活动`);
          if (summary.failed > 0) {
            failed2 += summary.failed;
            const reason = (result?.results || []).map((item) => item?.outcome?.message).find((message) => typeof message === "string" && message.length > 0);
            bits.push(`${summary.failed} 个失败${reason ? `（${reason}）` : ""}`);
          }
          parts.push(`${providerLabel2(id)} ${bits.length > 0 ? bits.join("，") : "无账号"}`);
          for (const item of result?.results || []) {
            const outcome = item?.outcome || {};
            if (outcome.actionRequired !== true) continue;
            const message = outcome.message;
            if (typeof message !== "string" || message.length === 0) continue;
            if (!notes.includes(message)) notes.push(message);
          }
        } catch (error) {
          failed2 += 1;
          parts.push(`${providerLabel2(id)} 失败（${error?.message || "未知原因"}）`);
        }
        setClaimProgress({ done: index + 1, total: providers.length });
      }
      const totalAmount = formatClaimGains(totalByUnit);
      setClaimNotice({
        tone: failed2 > 0 || notes.length > 0 ? "warn" : "ok",
        text: parts.length > 0 ? `全部渠道：${parts.join("；")}${totalAmount === null ? "" : `（共 ${totalAmount}）`}` : "全部渠道：没有可领取的渠道",
        notes
      });
    } finally {
      claimInFlightRef.current = false;
      setClaimProgress(null);
      setClaiming(null);
    }
    read.current();
  };
  const tone = failed && snapshot === null ? "error" : view.tone;
  const title = [view.text, view.incompleteNote, view.failureReason].filter((part) => part !== "").join("\n");
  const ariaLabel = `${label} 用量：${view.text}${view.incompleteNote === "" ? "" : `（${view.incompleteNote}）`}`;
  const collapsed = React4.createElement("span", { key: "text", className: "dim-jh-badgeText" }, [
    React4.createElement("span", { key: "name", className: "dim-jh-badgeName" }, view.name),
    React4.createElement("span", { key: "sep", className: "dim-jh-badgeSep" }, "•"),
    // 空串时**不渲染**该节点：留一个空 span 会白吃一个 5px 的 gap
    //（.dim-jh-badgeText 用的是 .dim-jh-badgeBtn 的 gap）。只有套餐模式有中段。
    view.detail === "" ? null : React4.createElement("span", { key: "detail", className: "dim-jh-badgeDetail" }, view.detail),
    // ⚠️ 类名是 Reading 而**不是** Value：.dim-jh-badgeValue 已被弹窗里的读数占用
    //（那条规则带 font-weight:600，且排在样式表更后面 —— 同名会让胶囊里的数字
    // 被静默加粗、并拿到 flex:none 而无法收缩）。
    React4.createElement("span", { key: "value", className: "dim-jh-badgeReading" }, view.reading),
    /**
     * 「这个数字不完整」的标记（用户 2026-10-03 要求）。
     *
     * 合计少算了几个账号时，数字本身**看不出任何异常**，故必须有个可见标记 ——
     * 但它是**补语而不是读数**，故：
     * - 单独成 span，`flex: none`（与读数同级）：被省略号吃掉就等于没标；
     * - 排在读数**之后**：不干扰「先看数字」的阅读顺序；
     * - 不参与 `view.text`：那句话是 `title` / `aria-label` 用的纯读数。
     *
     * ⚠️ `aria-hidden` 是**故意**的：同一句话已经并进按钮的 `aria-label`，
     * 不隐藏会被读屏念两遍。鼠标用户的解释走 `title`。
     */
    view.incompleteNote === "" ? null : React4.createElement("span", {
      key: "incomplete",
      className: "dim-jh-badgeWarn",
      title: view.incompleteNote,
      "aria-hidden": "true"
    }, "⚠")
  ]);
  return React4.createElement("div", { className: "dim-jh-badge", ref: root }, [
    React4.createElement("button", {
      key: "btn",
      type: "button",
      className: "dim-jh-badgeBtn",
      "aria-expanded": open,
      "aria-label": ariaLabel,
      title,
      onClick: () => setOpen((was) => !was)
    }, [
      React4.createElement("span", { key: "dot", className: "dim-jh-badgeDot", "data-tone": tone }),
      collapsed
    ]),
    open ? renderPopover() : null
  ]);
  function renderPopover() {
    const stamp = snapshot === null ? "" : formatUpdatedAt(value?.generatedAt ?? snapshot.at);
    const children = [
      React4.createElement("div", { key: "head", className: "dim-jh-badgeHead" }, [
        React4.createElement("span", { key: "dot", className: "dim-jh-badgeDot", "data-tone": tone }),
        React4.createElement("span", { key: "title", className: "dim-jh-badgeTitle" }, label),
        React4.createElement(
          "span",
          { key: "at", className: "dim-jh-badgeAt" },
          snapshot === null ? "读取中…" : `${stamp === "" ? "已读取" : stamp}${value?.cached === true ? " · 缓存" : ""}`
        ),
        React4.createElement("button", {
          key: "auto",
          type: "button",
          className: "dim-jh-badgeAuto",
          "data-state": autoState,
          "data-running": auto?.running === true,
          "aria-pressed": auto?.enabled === true,
          title: autoTitle,
          "aria-label": autoTitle,
          onClick: () => {
            void onToggleAutoCheckin();
          }
        }, auto?.running === true ? "…" : React4.createElement("span", { className: "dim-jh-badgeAutoDot" })),
        React4.createElement("button", {
          key: "refresh",
          type: "button",
          className: "dim-jh-badgeRefresh",
          disabled: busy,
          title: "刷新（绕过宿主缓存）",
          "aria-label": "刷新用量",
          onClick: () => read.current()
        }, busy ? "…" : "↻")
      ]),
      // 开关写入失败时单独一行说明：它属于设置写入，混进偏好那行会让人以为
      // 是「显示偏好」没保存。
      autoError === "" ? null : React4.createElement("div", { key: "autoErr", className: "dim-jh-badgeFail", role: "alert" }, autoError),
      renderPreference()
    ];
    if (snapshot === null) {
      children.push(React4.createElement("div", {
        key: "placeholder",
        className: failed ? "dim-jh-badgeFail" : "dim-jh-badgeNote",
        role: failed ? "alert" : void 0
      }, failed ? readError === "" ? "用量不可用，可点右上角 ↻ 重试" : `${readError}（可点右上角 ↻ 重试）` : "正在读取用量…（首次要逐账号查询，可能要几秒）"));
      children.push(renderClaim());
      return wrapPopover(children);
    }
    children.push(renderSubscription());
    children.push(renderCredits());
    children.push(renderClaim());
    children.push(renderFoot());
    return wrapPopover(children);
  }
  function wrapPopover(children) {
    const narrow = isNarrowViewport();
    if (!narrow) {
      return React4.createElement("div", {
        className: "dim-jh-badgePop",
        style: POPOVER_ANCHOR_STYLE,
        ref: popRef
      }, children);
    }
    const composerHeight = readComposerHeightPx(root.current);
    const style = {
      ...NARROW_POPOVER_STYLE,
      // ⚠️ React 的内联样式对自定义属性（`--x`）是原样下发的，故这里可以
      // 直接用 CSS 变量名作 key。
      "--dsh-composer-height": `${composerHeight}px`
    };
    const node = React4.createElement("div", {
      className: "dim-jh-badgePop",
      style,
      ref: popRef
    }, children);
    if (typeof document === "undefined" || document.body === null || document.body === void 0) return node;
    return (0, import_react_dom.createPortal)(node, document.body, "jet-hub-badge-pop");
  }
  function renderPreference() {
    return React4.createElement("div", {
      key: "pref",
      className: "dim-jh-badgePref",
      // ⚠️ 三档的差别必须写清：auto 与 credits 在**有订阅时**表现不同
      //（auto 会回落，credits 不回落到订阅）—— 只说「优先显示哪个」会让人以为两档一样。
      title: "显示偏好：「自动」= 优先显示一共能用的余额（没有余额读数才显示订阅窗口/套餐）；「优先订阅」= 只看窗口与套餐；「只看积分」= 强制只显示余额，也是套餐判定不准时的兜底"
    }, [
      ...BADGE_PREFERENCES.map((item) => React4.createElement("button", {
        key: item,
        type: "button",
        className: "dim-jh-badgePrefBtn",
        "aria-pressed": effectivePreference === item,
        onClick: () => {
          void onPickPreference(item);
        }
      }, BADGE_PREFERENCE_LABELS[item])),
      prefError === "" ? null : React4.createElement("span", { key: "err", className: "dim-jh-badgeFail" }, prefError)
    ]);
  }
  function renderSubscription() {
    const subscription = value?.subscription;
    if (subscription === void 0) return null;
    if (subscription.kind === "windows") {
      const rows = Array.isArray(subscription.accounts) ? subscription.accounts : [];
      const account = rows.find((row) => row?.ok === true) ?? rows[0];
      const windows = account === void 0 ? [] : quotaWindowsOf(account.windows ?? []);
      return React4.createElement("div", { key: "sub", className: "dim-jh-badgeSection" }, [
        React4.createElement("div", { key: "title", className: "dim-jh-badgeSectionTitle" }, "订阅额度"),
        ...windows.length === 0 ? [React4.createElement(
          "div",
          { key: "empty", className: "dim-jh-badgeNote" },
          account?.ok === true ? "该账号没有额度窗口" : account?.error || "订阅额度不可用"
        )] : [React4.createElement(
          "div",
          { key: "wins", className: "dim-jh-badgeWins" },
          windows.map(([type, windowLabel, win]) => {
            const percent = quotaPercentValue(win?.percentUsed);
            const left = quotaResetsIn(win?.resetsAt);
            return React4.createElement("div", { key: type, className: "dim-jh-badgeWin" }, [
              React4.createElement("span", { key: "l", className: "dim-jh-badgeWinLabel" }, windowLabel),
              React4.createElement(
                "div",
                { key: "bar", className: "dim-jh-quotaBar" },
                React4.createElement("div", {
                  key: "fill",
                  className: "dim-jh-quotaBarFill",
                  "data-tone": quotaTone(percent),
                  style: { width: `${percent}%` }
                })
              ),
              React4.createElement("span", { key: "v", className: "dim-jh-badgeValue" }, formatQuotaPercent(percent)),
              left === "" ? null : React4.createElement("span", { key: "r", className: "dim-jh-badgeWinReset", title: left }, left)
            ]);
          })
        )]
      ]);
    }
    const groups = view.planGroups;
    return React4.createElement("div", { key: "sub", className: "dim-jh-badgeSection" }, [
      React4.createElement("div", { key: "title", className: "dim-jh-badgeSectionTitle" }, "订阅套餐"),
      ...groups.length === 0 ? [React4.createElement("div", { key: "empty", className: "dim-jh-badgeNote" }, "没有可用的套餐包")] : groups.map((group) => React4.createElement("div", {
        key: `${group.name}\0${group.unit}`,
        className: "dim-jh-badgeRow"
      }, [
        React4.createElement("div", { key: "head", className: "dim-jh-badgeRowHead" }, [
          React4.createElement("span", { key: "l", className: "dim-jh-badgeRowName", title: group.name }, group.name),
          React4.createElement(
            "span",
            { key: "v", className: "dim-jh-badgeValue" },
            // ⚠️ 数值与单位之间**不留空格**（`100.00M / 200.00MToken`）：
            //   与本弹窗积分区（`usage-badge.js:894` / `badge-model.js:474`）、
            //   设置页账号卡片是同一口径。本行原为 `... ?? '?'} ${group.label}`
            //   （**带空格**）—— 它渲染的正是 `94.54M Token` 形态，与积分区的
            //   `94.54MToken` 在同一弹窗里并列，像两种单位
            //   （2026-10-05 复审补修；这是该批次最后一处空格漏网，见
            //    `tests/unit/claim-unit-callsites.spec.ts` 的穷举断言）。
            `${formatUnits(group.remaining, group.unit) ?? "?"} / ${formatUnits(group.total, group.unit) ?? "?"}${group.label}`
          )
        ]),
        React4.createElement(
          "div",
          { key: "note", className: "dim-jh-badgeRowNote" },
          [
            group.accountCount > 1 ? `${group.accountCount} 个账号合计` : null,
            group.deductionEndTime === void 0 ? null : `扣费截止 ${formatUpdatedAt(group.deductionEndTime)}`
          ].filter(Boolean).join(" · ")
        )
      ]))
    ]);
  }
  function renderCredits() {
    const accounts = value?.accounts ?? [];
    const windowDays = value?.windowDays;
    const quotaGroup = view.groups.find((group) => group.unit === QUOTA_UNIT);
    const sum = quotaGroup !== void 0 ? (quotaGroup.quotaLines ?? []).join(" · ") : view.groups.map((group) => `${formatUnits(group.total, group.unit) ?? "?"}${group.label}`).join(" · ");
    const { shown, hidden } = orderCreditRows(accounts, {
      limit: CREDITS_COLLAPSED_LIMIT,
      expanded: creditsExpanded
    });
    return React4.createElement("div", { key: "credits", className: "dim-jh-badgeSection" }, [
      // 合计放进节标题右侧，省掉一整行
      React4.createElement("div", { key: "title", className: "dim-jh-badgeSectionTitle" }, [
        // ⚠️ 节标题的单位标签走**纯函数**（`creditSectionLabel`），不在这里写三元：
        //   原写法是 `quotaGroup === undefined ? '积分' : unitLabel(...)` —— 那个
        //   兜底分支把 **ZCode 的 token** 冒充成了积分（真实缺陷，2026-10-05 复审
        //   PR !56 时发现），渲染成「积分 … 94.54MToken」自相矛盾的一屏。
        //   判据收进 `badge-model.js` 是为了能被单测锁死（组件里没法测 —— 本仓库
        //   node_modules 没有 react）。
        React4.createElement("span", { key: "l" }, creditSectionLabel(view.groups)),
        accounts.length === 0 || sum === "" ? null : React4.createElement(
          "span",
          { key: "sum", className: "dim-jh-badgeSectionSum" },
          // ⚠️ 「合计」二字只对**可累加的余额**成立。配额窗口是并行百分比，
          //   没有「一共」的语义（上游也没给过那个数），故配额下只给逐窗口读数。
          //   token / 积分都是余额口径，加「合计」无误。
          quotaGroup === void 0 ? `合计 ${sum}` : sum
        )
      ]),
      ...accounts.length === 0 ? [React4.createElement(
        "div",
        { key: "empty", className: "dim-jh-badgeNote" },
        value?.disabledCount > 0 ? "该渠道的账号全部已停用" : "该渠道还没有账号（可在 Jet Hub 设置页添加）"
      )] : shown.map((row) => React4.createElement("div", { key: row.accountId, className: "dim-jh-badgeRow" }, [
        React4.createElement("div", { key: "head", className: "dim-jh-badgeRowHead" }, [
          React4.createElement("span", {
            key: "l",
            className: "dim-jh-badgeRowName",
            title: row.nickname || row.accountId
          }, row.nickname || row.accountId),
          React4.createElement("span", {
            key: "v",
            className: "dim-jh-badgeValue",
            "data-tone": row.balance === null ? "warn" : "ok",
            title: row.error || void 0
          }, row.balance === null ? row.error || "查询失败" : balanceLine(row.balance))
        ]),
        // 分桶/资源包说明：小字**逐段带色**（永久绿 / 长期黄 / 临期红 + 倒计时），
        // 存在时才占一行。用户 2026-10-12 明确要求三档分色。
        row.balance === null ? null : renderSplitNote(splitParts(row.balance, windowDays, provider))
      ])),
      hidden === 0 ? null : React4.createElement("button", {
        key: "more",
        type: "button",
        className: "dim-jh-badgeMore",
        "aria-expanded": creditsExpanded,
        onClick: () => setCreditsExpanded((was) => !was)
      }, creditsExpanded ? "收起" : `展开其余 ${hidden} 个账号`)
    ]);
  }
  function renderNote(text) {
    if (typeof text !== "string" || text.length === 0) return null;
    return React4.createElement("div", { key: "note", className: "dim-jh-badgeRowNote" }, text);
  }
  function renderSplitNote(parts) {
    if (!Array.isArray(parts) || parts.length === 0) return null;
    const children = [];
    parts.forEach((part, index) => {
      if (index > 0) children.push(React4.createElement("span", { key: `sep-${part.key}`, className: "dim-jh-badgeNoteSep" }, " · "));
      children.push(React4.createElement("span", {
        key: part.key,
        className: "dim-jh-badgeNotePart",
        "data-tone": part.tone,
        // ⚠️⚠️ **不得无条件追加「后」**（2026-10-21 合并审计发现，!135 引入的回归）。
        //
        // `expirySplitParts` 的 `countdown` 已从「裸时长」改为「**可能是完整短语**」：
        // 倒计时只覆盖其中一批时它是 `其中 500 于 6 天 0 小时后到期`。旧代码在这里
        // 无条件拼 `后` ⇒ 实测得到残句：
        //   `最早作废：其中 500 于 6 天 0 小时后到期后`
        // （!135 只改了生产者、没同步这个消费者；本处此前**零用例**，变异实测全绿。）
        //
        // ⇒ 直接用它，两种形态都自洽：
        //   `最早作废：6 天 0 小时`                    ← 倒计时覆盖全部临期时
        //   `最早作废：其中 500 于 6 天 0 小时后到期`  ← 只覆盖其中一批时
        // ⚠️ **不要**在这里按「短语/时长」分支 —— 那是在消费方复制生产者才知道的
        //   形态知识，必然再次漂移（本仓头号缺陷形态）。
        ...part.countdown === void 0 ? {} : { title: `最早作废：${part.countdown}` }
      }, part.countdown === void 0 ? part.text : `${part.text}（${part.countdown}）`));
    });
    return React4.createElement("div", { key: "note", className: "dim-jh-badgeRowNote" }, children);
  }
  function renderClaim() {
    const canClaimCurrent = supportsDailyCheckin(provider);
    const allBusy = claiming === "all";
    return React4.createElement("div", { key: "claim", className: "dim-jh-badgeSection dim-jh-badgeClaim" }, [
      React4.createElement("div", { key: "row", className: "dim-jh-badgeClaimRow" }, [
        canClaimCurrent ? React4.createElement("button", {
          key: "cur",
          type: "button",
          className: "dim-jh-badgeAction",
          disabled: claiming !== null,
          // ⚠️ 按钮文案**不写渠道名**：`签到（仅 CodeBuddy (腾讯)）` 在 300px 弹窗里
          // 会被 text-overflow 截成 `签到（仅 CodeBuddy (…`（截图核验发现）。渠道名
          // 已经在弹窗头部与 title 里，按钮只要说清「范围＝本渠道」即可。
          // ⚠️ 自动签到开着时加「（自动）」后缀 —— 只在**只有这一个按钮**的形态下
          // 才轮到它承载该标识（见 `withAutoSuffix` 的注释）。
          title: `只签到当前渠道（${label}）的全部账号`,
          onClick: () => {
            void onClaim();
          }
        }, claiming === "current" ? "领取中…" : "签到（本渠道）") : null,
        React4.createElement("button", {
          key: "all",
          type: "button",
          className: "dim-jh-badgeAction",
          disabled: claiming !== null,
          // ⚠️ 渠道数是**从能力表数出来的快照**（`registry.credits.dailyCheckin === true`
          // 的家数）—— 加一个支持签到的渠道就必须改这里。
          // 2026-10-16 合并审计发现：加 `minimaxintl` 后能力表已 9 → **10**，
          // 而此处仍写 9（**零守卫**：全仓没有断言这个数字的用例）。
          title: `串行签到全部支持签到的渠道（10 个；WorkBuddy 国际版 / Cline / Raccoon 后端没有签到接口）${auto?.enabled === true ? "；自动签到已开启，每天首次启动 DSH 时会自动执行一次" : ""}`,
          onClick: () => {
            void onClaimAll();
          }
        }, allBusy ? claimProgress === null ? "签到中…" : `签到中 ${claimProgress.done}/${claimProgress.total}…` : withAutoSuffix("全部渠道签到"))
      ]),
      /**
       * 本渠道没有签到接口时**明说原因**。
       *
       * ⚠️ 用户 2026-10-02 报障：「单渠道签到哪里去了」—— 他在 Cline 上打开弹窗只看到
       * 「全部渠道签到」，以为按钮丢了。真相是能力表里 `dailyCheckin: false`
       * （WorkBuddy 国际版 / Cline / Raccoon 后端没有签到接口，Raccoon 的每日积分由
       * 服务端自动发放）。少了这一句，用户只能靠猜。
       */
      canClaimCurrent ? null : React4.createElement(
        "div",
        { key: "nocount", className: "dim-jh-badgeNote" },
        "该渠道没有签到接口，签到请用「全部渠道签到」"
      ),
      claimNotice === null ? null : React4.createElement("div", {
        key: "notice",
        className: "dim-jh-badgeNotice",
        "data-tone": claimNotice.tone
      }, claimNotice.text),
      // 「需要用户操作」的提示单独列出（后端显式字段 actionRequired），
      // 混进计数行会被读漏，而它的价值就在于被看到。
      ...(claimNotice?.notes || []).map((message, index) => React4.createElement("div", {
        key: `note-${index}`,
        className: "dim-jh-badgeNotice",
        "data-tone": "warn"
      }, message)),
      renderAutoStatus()
    ]);
  }
  function renderAutoStatus() {
    if (auto?.enabled !== true || auto.dismissed === true) return null;
    const channels = Array.isArray(auto.channels) ? auto.channels : [];
    const running = auto.running === true;
    if (!running && channels.length === 0) return null;
    const stamp = running ? "" : formatUpdatedAt(auto.lastAt);
    return React4.createElement("div", { key: "autostatus", className: "dim-jh-badgeAutoStatus" }, [
      // 小关闭按钮在**文字上方**（用户：「在文字上方放个小按钮，点击直接关闭」）。
      React4.createElement(
        "div",
        { key: "closerow", className: "dim-jh-badgeAutoCloseRow" },
        React4.createElement("button", {
          key: "close",
          type: "button",
          className: "dim-jh-badgeAutoClose",
          title: "关闭这行自动签到状态（下一轮自动签到后会重新出现）",
          "aria-label": "关闭自动签到状态文字",
          onClick: () => {
            void onDismissAuto();
          }
        }, "×")
      ),
      React4.createElement(
        "div",
        { key: "head", className: "dim-jh-badgeAutoStatusHead" },
        running ? "自动签到 · 进行中…" : `自动签到${stamp === "" ? "" : ` · ${stamp}`}：${auto.lastResult}`
      ),
      channels.length === 0 ? null : React4.createElement(
        "div",
        { key: "channels", className: "dim-jh-badgeAutoChannels" },
        channels.map((entry2, index) => React4.createElement("span", {
          key: `${entry2.provider}-${index}`,
          className: "dim-jh-badgeAutoChannel"
        }, `${providerLabel2(entry2.provider)} ${entry2.text}`))
      )
    ]);
  }
  function renderFoot() {
    const parts = [];
    if (value?.disabledCount > 0) parts.push(`另有 ${value.disabledCount} 个账号已停用，未计入`);
    if (view.failedCount > 0) parts.push(view.incompleteNote === "" ? `${view.failedCount} 个账号读取失败` : view.incompleteNote);
    if (failed && snapshot !== null) parts.push("本次刷新失败，显示的是上一次读数");
    if (parts.length === 0) return null;
    return React4.createElement("div", { key: "foot", className: "dim-jh-badgeFoot" }, parts.join(" · "));
  }
}
function balanceLine(balance) {
  const packages = balance.packages || [];
  const unit = packages.find((pkg) => pkg && pkg.unit)?.unit;
  const quota = formatQuotaLine(packages, unit);
  if (quota !== null) return quota;
  const text = formatUnits(balance.total, unit) ?? "0";
  return `${text}${unitLabel(unit)}`;
}
function splitParts(balance, windowDays, provider) {
  const packages = balance.packages || [];
  const unit = packages.find((pkg) => pkg && pkg.unit)?.unit;
  if (unit === QUOTA_UNIT) {
    const parts2 = [];
    for (const pkg of packages) {
      if (!pkg) continue;
      const left = quotaResetsIn(pkg.cycleEndTime);
      if (left.length > 0) parts2.push({ key: pkg.name || "unnamed", text: `${pkg.name || "未命名"} ${left}`, tone: "muted" });
    }
    return parts2;
  }
  const format = (value) => formatUnits(value, unit);
  const poolText = formatPoolSplitLine(packages, format, provider === "loomy" ? "永久" : "长期");
  if (poolText !== null) return [{ key: "pool", text: poolText, tone: "muted" }];
  const now = Date.now();
  const parts = expirySplitParts(splitCreditsByExpiry(packages, windowDays, now), format, now);
  const exclusive = exclusivePoolRemainingOf(packages);
  if (exclusive > 0) {
    parts.push({ key: "exclusive", text: `另有 ${format(exclusive)} 专属（不计入）`, tone: "muted" });
  }
  return parts;
}
function summarizeClaim(result) {
  const summary = result?.summary;
  if (summary === void 0) return { tone: "ok", text: "签到完成", notes: [] };
  const parts = [];
  if (summary.claimed > 0) {
    const amount = formatClaimGains(
      summary.totalByUnit || { credit: Number(summary.totalCredit) || 0, token: 0 }
    );
    parts.push(amount === null ? `${summary.claimed} 个账号领取成功` : `${summary.claimed} 个账号领取成功，共 ${amount}`);
  }
  if (summary.alreadyClaimed > 0) parts.push(`${summary.alreadyClaimed} 个今天已领`);
  if (summary.inactive > 0) parts.push(`${summary.inactive} 个活动未开启`);
  if (summary.failed > 0) {
    const reason = (result.results || []).find((row) => row?.outcome?.kind === "failed")?.outcome?.message;
    parts.push(`${summary.failed} 个失败${reason ? `：${reason}` : ""}`);
  }
  const notes = (result?.results || []).map((row) => row?.outcome).filter((outcome) => outcome?.actionRequired === true && typeof outcome.message === "string" && outcome.message.length > 0).map((outcome) => outcome.message).filter((message, index, all) => all.indexOf(message) === index);
  return {
    tone: summary.failed > 0 || notes.length > 0 ? "warn" : "ok",
    text: parts.length === 0 ? "签到完成（无可领取的账号）" : parts.join("；"),
    notes
  };
}

// plugin-src/client/panel-entry.js
var React6 = __toESM(require("react"), 1);

// plugin-src/client/error-boundary.js
var React5 = __toESM(require("react"), 1);
var NO_ERROR = Symbol("jet-hub:no-error");
function describeThrown(error) {
  try {
    if (error !== null && error !== void 0 && typeof error.message === "string" && error.message.length > 0) {
      return error.message;
    }
  } catch {
  }
  try {
    return String(error);
  } catch {
    return "（抛出值无法转为文本，请查看控制台）";
  }
}
function withErrorBoundary(Inner, options) {
  const label = options !== null && typeof options === "object" && typeof options.label === "string" && options.label.length > 0 ? options.label : "这个面板";
  class PanelErrorBoundary extends React5.Component {
    constructor(props) {
      super(props);
      this.state = { error: NO_ERROR };
    }
    static getDerivedStateFromError(error) {
      return { error };
    }
    componentDidCatch(error, info) {
      console.error(`[jet-hub] ${label}渲染失败，已拦住（页面其余部分继续可用）：`, error, info?.componentStack);
    }
    render() {
      const error = this.state.error;
      if (error === NO_ERROR) return React5.createElement(Inner, this.props);
      const message = describeThrown(error);
      return React5.createElement(
        "div",
        {
          className: "dim-jh-probeNotice",
          "data-tone": "error",
          role: "alert",
          style: { margin: "16px" }
        },
        React5.createElement("div", null, `${label}渲染失败，已拦住 —— 其余页面仍可正常使用，不必重启。`),
        React5.createElement("div", { style: { marginTop: "6px", fontFamily: "monospace", fontSize: "12px" } }, message),
        // ⚠️ **必须给出可自我恢复的出路**（2026-10-25 审计 A3-2）。
        //
        // 本 fallback 是**粘性**的：没有 `key`、也没有 `componentDidUpdate`
        // 重置 ⇒ 同一实例一旦进 error 就永远显示 fallback（数据恢复了也不回来）。
        // 审计实测：数据恢复后仍显示 fallback，只有**新建实例**才恢复。
        //
        // 而用户其实**不必重启**：宿主 `SettingsPanel` 在 `open === false` 时整棵
        // 不挂载、`main` 是 keyed 槽 ⇒「关掉设置再打开」/「切走再切回」都能恢复。
        // 但**这条路径不可发现** —— 用户看到一块报错，不知道关掉再打开就能好。
        //
        // ⇒ 两件事：①给一个**就地重试**（`setState` 回 `NO_ERROR`，子树随即重挂载，
        // 比让用户摸索「关掉再打开」快得多）；②把那条路径**写出来**当兜底。
        React5.createElement(
          "div",
          { style: { marginTop: "8px" } },
          React5.createElement("button", {
            type: "button",
            className: "dim-jh-btn",
            onClick: () => {
              this.setState({ error: NO_ERROR });
            }
          }, "重试"),
          React5.createElement(
            "span",
            { style: { marginLeft: "8px", opacity: 0.75 } },
            "也可以关掉这一节再重新打开（或切到别的页面再切回来）来恢复。"
          )
        ),
        React5.createElement(
          "div",
          { style: { marginTop: "6px" } },
          "这是插件的缺陷，不是你操作错了。把上面这行报错连同「当时点了什么」一起反馈即可。"
        )
      );
    }
  }
  PanelErrorBoundary.displayName = `withErrorBoundary(${Inner.displayName || Inner.name || "Component"})`;
  return PanelErrorBoundary;
}

// plugin-src/client/panel-entry-store.js
var VALID_ENTRIES = ["sidebar", "settings"];
var FALLBACK_ENTRY = "sidebar";
var JET_HUB_PANEL_KEY = "jet-hub";
var JET_HUB_SIDEBAR_ORDER = 20;
var PANEL_ENTRY_READ_TIMEOUT_MS = 5e3;
var PANEL_ENTRY_READ_ATTEMPTS = 3;
var PANEL_ENTRY_RETRY_DELAY_MS = 200;
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
var entry = null;
var readFailed = false;
var inflight = null;
var writeSeq = 0;
var listeners = /* @__PURE__ */ new Set();
function normalize(raw) {
  return typeof raw === "string" && VALID_ENTRIES.includes(raw) ? raw : null;
}
function panelEntry() {
  return entry;
}
function panelEntryShowsSidebar() {
  return entry !== "settings";
}
function panelEntryShowsSettings() {
  return entry === "settings";
}
function panelEntryReadFailed() {
  return readFailed;
}
function subscribePanelEntry(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function publish(nextEntry, nextFailed) {
  if (entry === nextEntry && readFailed === nextFailed) return;
  entry = nextEntry;
  readFailed = nextFailed;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (caught) {
      console.error("[jet-hub] 面板入口监听器抛错", caught);
    }
  }
}
function readSignal() {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(PANEL_ENTRY_READ_TIMEOUT_MS);
  }
  if (typeof AbortController !== "function") return void 0;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PANEL_ENTRY_READ_TIMEOUT_MS);
  if (typeof timer === "object" && timer !== null && typeof timer.unref === "function") {
    timer.unref();
  }
  controller.signal?.addEventListener?.("abort", () => clearTimeout(timer), { once: true });
  return controller.signal;
}
function loadPanelEntry(rpcCall) {
  if (inflight !== null) return inflight;
  const seqAtStart = writeSeq;
  const task = (async () => {
    let lastError;
    for (let attempt = 1; attempt <= PANEL_ENTRY_READ_ATTEMPTS; attempt += 1) {
      try {
        const result = await rpcCall("panelEntry.get", {}, readSignal());
        if (writeSeq !== seqAtStart) return entry ?? FALLBACK_ENTRY;
        const next = normalize(result?.entry);
        if (next !== null) {
          publish(next, false);
        } else {
          publish(entry ?? FALLBACK_ENTRY, true);
        }
        return entry ?? FALLBACK_ENTRY;
      } catch (caught) {
        lastError = caught;
        if (writeSeq !== seqAtStart) return entry ?? FALLBACK_ENTRY;
        if (attempt >= PANEL_ENTRY_READ_ATTEMPTS) break;
        await delay(PANEL_ENTRY_RETRY_DELAY_MS * attempt);
        if (writeSeq !== seqAtStart) return entry ?? FALLBACK_ENTRY;
      }
    }
    console.warn(
      `[jet-hub] 读取面板入口偏好失败，按仅侧栏处理（已重试 ${PANEL_ENTRY_READ_ATTEMPTS - 1} 次）`,
      lastError
    );
    if (writeSeq === seqAtStart) publish(entry ?? FALLBACK_ENTRY, true);
    return entry ?? FALLBACK_ENTRY;
  })();
  inflight = task;
  const clear = () => {
    if (inflight === task) inflight = null;
  };
  void task.then(clear, clear);
  return task;
}
async function setPanelEntry(rpcCall, next) {
  const result = await rpcCall("panelEntry.set", { entry: next });
  const confirmed = normalize(result?.entry);
  if (confirmed === null) {
    throw new Error("面板入口偏好没有返回合法 entry");
  }
  writeSeq += 1;
  publish(confirmed, false);
  return confirmed;
}

// plugin-src/client/panel-entry.js
var JetHubPageForSettings = withErrorBoundary(JetHubPage, { label: "Jet Hub 设置页" });
var JetHubPageForMain = withErrorBoundary(JetHubPage, { label: "Jet Hub 面板" });
function JetHubSidebarIcon({ size }) {
  const px = typeof size === "number" && size > 0 ? size : 16;
  return React6.createElement(
    "svg",
    {
      width: px,
      height: px,
      viewBox: "0 0 16 16",
      fill: "none",
      xmlns: "http://www.w3.org/2000/svg",
      "aria-hidden": "true"
    },
    React6.createElement("path", {
      d: "M8 1.7 13.5 4.85v6.3L8 14.3 2.5 11.15v-6.3z",
      stroke: "currentColor",
      strokeWidth: 1.35,
      strokeLinejoin: "round"
    }),
    React6.createElement("circle", { cx: 8, cy: 8, r: 1.7, fill: "currentColor" })
  );
}
function JetHubMainPanel({ rpcCall }) {
  if (typeof rpcCall !== "function") return null;
  return React6.createElement(
    "div",
    { className: "dim-jh-panelHost", "data-plugin": "dsh-codearts-auth" },
    React6.createElement(JetHubPageForMain, { rpcCall })
  );
}
function registerJetHubPanelEntries(ctx, rpcCall) {
  ctx.slots.inject("main", () => ctx.slots.register({
    name: "main",
    key: JET_HUB_PANEL_KEY,
    inject: () => ({ rpcCall })
  }, JetHubMainPanel));
  let layout;
  ctx.inject(["layout"], (scoped) => {
    layout = scoped.layout;
    return () => {
      layout = void 0;
    };
  });
  const deselectIfActive = () => {
    try {
      if (layout?.panelInfo?.getSnapshot?.()?.activePanelId !== JET_HUB_PANEL_KEY) return;
      layout.selectPanel(null);
    } catch (caught) {
      console.warn("[jet-hub] 撤销侧栏入口时取消选中失败", caught);
    }
  };
  ctx.slots.inject("sidebar.panellist", () => {
    let stopRow;
    const sync = (visible) => {
      if (visible && stopRow === void 0) {
        stopRow = ctx.slots.register({
          name: "sidebar.panellist",
          id: JET_HUB_PANEL_KEY,
          order: JET_HUB_SIDEBAR_ORDER,
          label: () => "Jet Hub"
        }, JetHubSidebarIcon);
        return;
      }
      if (!visible && stopRow !== void 0) {
        const stop = stopRow;
        stopRow = void 0;
        stop();
        deselectIfActive();
      }
    };
    const unsubscribe = subscribePanelEntry(() => sync(panelEntryShowsSidebar()));
    sync(panelEntryShowsSidebar());
    let disposed = false;
    void loadPanelEntry(rpcCall).then(() => {
      if (!disposed) sync(panelEntryShowsSidebar());
    });
    return () => {
      disposed = true;
      unsubscribe();
      if (stopRow !== void 0) {
        const stop = stopRow;
        stopRow = void 0;
        stop();
      }
    };
  });
  ctx.slots.inject("settings.section", () => {
    let stopSection;
    const sync = (visible) => {
      if (visible && stopSection === void 0) {
        stopSection = ctx.slots.register({
          name: "settings.section",
          id: JET_HUB_PANEL_KEY,
          order: 50,
          label: () => "Jet Hub",
          inject: () => ({ rpcCall })
        }, JetHubPageForSettings);
        return;
      }
      if (!visible && stopSection !== void 0) {
        const stop = stopSection;
        stopSection = void 0;
        stop();
      }
    };
    const unsubscribe = subscribePanelEntry(() => sync(panelEntryShowsSettings()));
    sync(panelEntryShowsSettings());
    let disposed = false;
    void loadPanelEntry(rpcCall).then(() => {
      if (!disposed) sync(panelEntryShowsSettings());
    });
    return () => {
      disposed = true;
      unsubscribe();
      if (stopSection !== void 0) {
        const stop = stopSection;
        stopSection = void 0;
        stop();
      }
    };
  });
}

// plugin-src/client/settings-card.js
var React7 = __toESM(require("react"), 1);
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
var OPTIONS = [
  { id: "sidebar", label: "仅侧栏" },
  { id: "settings", label: "仅设置页" }
];
var CARD_TITLE = "面板入口";
var CARD_DESC = "决定 Jet Hub 出现在哪里。两个入口是同一个页面，任一时刻只保留一个。";
var CARD_DESC_READ_FAILED = "⚠️ 未能读取当前设置，下面显示的是默认值。重新选一次即可写回。";
var CARD_DESC_WRITE_FAILED = "⚠️ 刚才那次没有保存成功，下面仍是原来的设置。请再选一次。";
function currentEntry() {
  return panelEntry() ?? "sidebar";
}
function JetHubPanelEntryCard({ rpcCall }) {
  const [entry2, setEntry] = React7.useState(currentEntry);
  const [open, setOpen] = React7.useState(false);
  const [busy, setBusy] = React7.useState(false);
  const [readFailed2, setReadFailed] = React7.useState(() => panelEntryReadFailed());
  const [writeFailed, setWriteFailed] = React7.useState(false);
  const busyRef = React7.useRef(false);
  React7.useEffect(() => subscribePanelEntry(() => {
    setEntry(currentEntry());
    setReadFailed(panelEntryReadFailed());
  }), []);
  React7.useEffect(() => {
    if (typeof rpcCall !== "function") return;
    void loadPanelEntry(rpcCall).then(() => {
      setEntry(currentEntry());
      setReadFailed(panelEntryReadFailed());
    });
  }, [rpcCall]);
  const selectedLabel = OPTIONS.find((option) => option.id === entry2)?.label ?? OPTIONS[0].label;
  const choose = React7.useCallback(async (next) => {
    if (typeof rpcCall !== "function") return;
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await setPanelEntry(rpcCall, next);
      setWriteFailed(false);
    } catch (caught) {
      console.error("[jet-hub] 切换面板入口失败:", caught);
      setEntry(currentEntry());
      setWriteFailed(true);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [rpcCall]);
  return React7.createElement(
    "div",
    { className: "dim-jh-cardStack" },
    React7.createElement(
      "div",
      { className: "dim-jh-cardRow" },
      React7.createElement(
        "div",
        { className: "dim-jh-cardRowText" },
        React7.createElement("div", { className: "dim-jh-cardTitle" }, CARD_TITLE),
        React7.createElement(
          "div",
          { className: "dim-jh-cardDesc" },
          // 两种失败各有各的说法：读失败说「读到的是默认值」，写失败说「刚才那次没存上」。
          writeFailed ? CARD_DESC_WRITE_FAILED : readFailed2 ? CARD_DESC_READ_FAILED : CARD_DESC
        )
      ),
      React7.createElement(import_dsh_client_ui_primitives.Menu, {
        open,
        onClose: () => setOpen(false),
        items: OPTIONS.map((option) => ({ id: option.id, label: option.label })),
        selectedId: entry2,
        onSelect: (id) => {
          setOpen(false);
          void choose(id);
        },
        align: "end",
        // ⚠️ **必须开**：卡片在插件页的滚动 detail 列里，就地展开的列表会被
        //    overflow 裁剪（两个参考实现都踩过并留了这条注释）。
        portal: true,
        anchor: React7.createElement(
          "button",
          {
            type: "button",
            className: "dim-jh-cardSelector",
            "aria-haspopup": "menu",
            "aria-expanded": open,
            disabled: busy,
            onClick: () => setOpen((value) => !value)
          },
          selectedLabel,
          React7.createElement(import_dsh_client_ui_primitives.IconChevronDownOutlineRegular, { className: "dim-jh-cardChevron" })
        )
      })
    )
  );
}

// plugin-src/client/index.js
var name = "jet-hub-client";
var inject = ["slots", "connection", "modelDirectories", "sessions", "remote", "remote.session"];
var JetHubPanelEntryCardGuarded = withErrorBoundary(JetHubPanelEntryCard, { label: "插件详情页卡片" });
var UsageBadgeGuarded = withErrorBoundary(UsageBadge, { label: "用量徽标" });
function apply(ctx) {
  ctx.effect(() => installJetHubStyles(), "jet-hub: install styles");
  const rpcCall = async (endpoint, payload, signal) => {
    const raw = await callManagementRpc(ctx.connection, JET_HUB_RPC_CHANNEL, endpoint, payload, signal);
    return unwrapRpcResult(raw);
  };
  ctx.effect(() => startCarrierContribution({ rpcCall }), "jet-hub: zcode 内部载体贡献循环");
  registerJetHubPanelEntries(ctx, rpcCall);
  ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
    name: "plugins.bundle.config",
    key: "dsh-codearts-auth",
    inject: () => ({ rpcCall })
  }, JetHubPanelEntryCardGuarded));
  ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
    name: "conversation.input.right",
    id: "jet-hub-usage",
    order: 100,
    inject: (sessionId) => ({
      // ⚠️⚠️ **必须惰性取目录，不能在 inject 里取**（真机事故 2026-10-02）。
      //
      // 原写法 `directory: ctx.modelDirectories.directoryFor(sessionId).store`
      // 有两个问题：
      // 1. `directoryFor` 是**惰性 getter** —— 写 `directoryFor(sessionId).store`
      //    里的 `.store` 才触发求值，而求值发生在**槽位 inject 期**（即会话
      //    输入区渲染的同步路径上）。桌面版此时它内部要访问未注入的
      //    `remote.session`，直接抛 `cannot get property "remote.session"
      //    without inject`（Web 版不走那条分支，故只在 desktop 复现）。
      // 2. 该异常发生在渲染关键路径上，**会让整个会话输入区渲染中断** ——
      //    表现为模型选择器点不动（用户报障），远不止「徽标不显示」。
      //
      // ⇒ 改为交出一个**取值函数** `resolveDirectory()`，由组件在自己的
      // effect 里调用：失败被组件自身的 try/catch 兜住，影响面收敛到
      // 「徽标不显示」，绝不影响模型选择器。
      //
      // ⚠️⚠️ **必须同时交出 `store` 与 `load`（真机事故 2026-10-02 的真正根因）
      //
      // 读 `dsh-client-ui-model-selection` 的 `ModelDirectory` 源码得到两个事实：
      //   ① 它的**公开方法是 `load()` / `syncInputs()`，没有 `getSnapshot()` /
      //      `subscribe()`** —— 那两个在 `this.store` 上。我第一版只交出实例，
      //      组件调 `directory.getSnapshot()` 得到 `undefined` → TypeError →
      //      被 safe() 吞掉 → `provider` 恒为空 → **徽标永不显示**。
      //   ② `store` 的初值是 `{ current: null, status: 'idle' }`，**只有
      //      `await load()` 之后** `syncInputs()` 才把真实 `current` 填进去。
      //      徽标自己不发模型目录请求（`usage.badge` 按 provider 查），
      //      所以必须由它调 `load()`，否则 `current` 永远是 null。
      //
      // 两者缺一不可：只给 store 不 load → current 为 null；
      // 只给实例不 load 也不 store → getSnapshot 不存在。
      resolveDirectory: () => {
        const directory = ctx.modelDirectories.directoryFor(sessionId);
        return {
          store: directory.store,
          load: () => directory.load()
        };
      },
      providerLabel,
      readBadge: (provider, options) => rpcCall("usage.badge", { provider, ...options }),
      /**
       * 聚合 provider「上次**实际**转发成功的渠道」（P3）。
       *
       * ⚠️ 宿主侧该端点是**纯内存读**（零网络零余额查询）—— 徽标在**门控阶段**
       * 就要用它把 `aggregate` 重定向成真实渠道，而门控是同步渲染路径。
       * ⚠️ 返回 `{ provider: null }` 表示无历史 ⇒ 徽标**不渲染**。
       */
      readActiveProvider: (canonicalId) => rpcCall("aggregate.activeProvider", canonicalId === void 0 ? {} : { canonicalId }),
      // ⚠️ **这里曾有一个 `readExpiryOrder` prop，已删除**（真实死代码，审计实测指出）：
      //    它在 `c12b3ab` 上就已**零消费者** —— `AggregatePanel` 自己直接
      //    `rpcCall('aggregate.expiryOrder', {})`（`jet-hub.js`），从不经过本 prop。
      //    本仓库把死代码视为缺陷（会让人以为「面板是通过 prop 取数的」而找错地方）。
      //    ⚠️ 端点本身仍在（`aggregate.expiryOrder`）—— 删的只是这个没人用的转发 prop。
      writePreference: (preference) => rpcCall("usage.badgePreference", { preference }),
      // 自动签到开关（全局一个，不分渠道）：宿主在「打开」时会立刻跑一轮。
      setAutoCheckin: (enabled) => rpcCall("usage.autoCheckin", { enabled }),
      // 关闭那行**常驻**的自动签到状态文字（只关当前这一轮，下一轮会重新出现）。
      dismissAutoCheckin: () => rpcCall("usage.autoCheckin", { dismiss: true }),
      // 一键领取：每日签到 + （buddy / workbuddy 的）成长中心任务。
      //
      // ⚠️ runTasks 缺省**必须为 false** —— 同一个方法也是「每日首次启动自动签到」
      // 的执行体（宿主 auto-checkin 的 claim 回调）。成长一轮单账号 90～270s、
      // 全串行，默认开启等于每次开机自动打几十个上游请求。
      // budgetMs 缺省由宿主取 10 分钟；传 0 或负数表示不限时。
      claimCredits: (provider, runTasks, budgetMs) => rpcCall("credits.claimAll", { provider, runTasks, budgetMs })
    })
  }, UsageBadgeGuarded));
}

    return module.exports;
  }
});
