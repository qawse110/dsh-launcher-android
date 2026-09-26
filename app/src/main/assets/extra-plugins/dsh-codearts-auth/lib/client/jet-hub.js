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
.dim-jh-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 24px; border-bottom: 1px solid var(--dsw-alias-border-default, #e5e5e5); }
.dim-jh-brand { display: flex; flex-direction: column; }
.dim-jh-brandName { font-size: 18px; font-weight: 600; color: var(--dsw-alias-label-primary, #1a1a1a); }
.dim-jh-brandDesc { font-size: 13px; color: var(--dsw-alias-label-secondary, #555); margin: 2px 0 0; }

/* 布局：对齐 dsh-im 的两栏 */
.dim-jh-layout { display: flex; flex: 1; overflow: hidden; }

/* 左侧导航：align dsh-im .dim-rail */
.dim-jh-rail { width: 200px; border-right: 1px solid var(--dsw-alias-border-default, #e5e5e5); padding: 8px; overflow-y: auto; display: grid; align-content: start; gap: 8px; }

/* 每个 provider 按钮：align dsh-im .dim-channel */
.dim-jh-provider { width: 100%; min-height: 48px; display: grid; grid-template-columns: 30px minmax(0, 1fr); align-items: center; gap: 10px; padding: 8px 12px; border: 1px solid var(--dsw-alias-border-l2, #eef0f3); border-radius: 14px; color: inherit; background: var(--dsw-alias-bg-layer-3, #fff); box-shadow: 0 2px 8px rgb(31 35 41 / 3%); font: inherit; text-align: left; cursor: pointer; transition: border-color .16s ease, background .16s ease, box-shadow .16s ease; }
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
.dim-jh-providerIcon.trae { background: white; }
/* Raccoon Work（商汤）：官方图标是深蓝底白色面具，白底容器中显示清晰。 */
.dim-jh-providerIcon.raccoon { background: white; }

/* provider 文案：align dsh-im .dim-channelCopy */
.dim-jh-providerLabel { min-width: 0; display: grid; }
.dim-jh-providerLabel strong { overflow: hidden; color: inherit; font-size: 14px; line-height: 20px; font-weight: 680; text-overflow: ellipsis; white-space: nowrap; }

/* 右侧面板 */
.dim-jh-panel { flex: 1; padding: 24px; overflow-y: auto; }
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
.dim-jh-orderHint { margin: 0 0 10px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8f959e); }

/* 顶部一行：状态点 + 名称 + 状态标签 */
.dim-jh-accountTop { display: flex; align-items: center; gap: 8px; }
.dim-jh-accountStatus { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-label-tertiary, #9aa0a6); }
.dim-jh-accountStatus[data-on="true"] { background: #22c55e; box-shadow: 0 0 0 3px rgb(34 197 94 / 14%); }
.dim-jh-accountName { flex: 1 1 auto; min-width: 0; overflow: hidden; font-size: 14px; line-height: 20px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); text-overflow: ellipsis; white-space: nowrap; }
.dim-jh-accountTag { flex: none; padding: 1px 8px; border-radius: 999px; font-size: 11px; line-height: 17px; font-weight: 500; }
.dim-jh-accountTag[data-tone="on"] { color: #15803d; background: rgb(34 197 94 / 12%); }
.dim-jh-accountTag[data-tone="off"] { color: var(--dsw-alias-label-tertiary, #8f959e); background: rgb(143 149 158 / 12%); }

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
/* 已失效额度：弱化的橙色提示，与主数值的蓝色明确区分 */
.dim-jh-creditExpired { font-size: 11px; color: #b45309; }

/* 限额重置徽章行 */
.dim-jh-rateLimits { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 8px; }
.dim-jh-rateLimitsLabel { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8f959e); }

/* 操作按钮：横向一行，右对齐 */
.dim-jh-accountActions { display: flex; flex-direction: row; flex-wrap: nowrap; justify-content: flex-end; gap: 8px; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--dsw-alias-border-l2, #f0f1f3); }

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

/* 限流 TTL 徽章 */
.dim-jh-ttlBadge { display: inline-block; padding: 1px 8px; border-radius: 999px; background: rgb(227 116 0 / 10%); color: #b45309; font-size: 11px; line-height: 17px; font-weight: 500; }

/* 面板标题区：标题独占一行，操作按钮另起一行。
   此前用单行 space-between 把标题与 5 个按钮挤在一起，面板一窄就溢出被裁掉。 */
.dim-jh-panelHead { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; margin-bottom: 16px; }
.dim-jh-panelTitle { margin: 0; font-size: 16px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); }

/* 面板标题下方的操作按钮组（显示列表 / 刷新积分 / 一键领取积分 / 重测所有 / 重置所有 / 新建账号）。
   允许换行：按钮数量随 provider 变化（CodeBuddy 有「一键领取积分」，其他没有），
   固定单行在窄面板下必然放不下。 */
.dim-jh-headerActions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; max-width: 100%; }

/* 上一次「重测 / 重置」的结果提示 */
.dim-jh-probeNotice { margin-bottom: 12px; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l2, #eef0f3); background: var(--dsw-alias-bg-layer-2, #f7f8fa); font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, #646a73); }
.dim-jh-probeNotice[data-tone="ok"] { border-color: color-mix(in srgb, #22c55e 35%, var(--dsw-alias-border-l2, #eef0f3)); background: rgb(34 197 94 / 8%); color: #15803d; }
.dim-jh-probeNotice[data-tone="warn"] { border-color: color-mix(in srgb, #e37400 35%, var(--dsw-alias-border-l2, #eef0f3)); background: rgb(227 116 0 / 8%); color: #b45309; }
.dim-jh-probeNotice[data-tone="error"] { border-color: color-mix(in srgb, #d93025 35%, var(--dsw-alias-border-l2, #eef0f3)); background: rgb(217 48 37 / 8%); color: #b3261e; }
.dim-jh-probeDetails { margin: 6px 0 0; padding-left: 18px; display: grid; gap: 2px; }
.dim-jh-probeDetails li { font-size: 12px; line-height: 18px; }

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
/* 模型列表弹窗：**顶部锚定**而非垂直居中。
   ⚠️ 这是修真实缺陷（用户报障「输入文字后整个弹框的位置会发生改变，有点突兀」）：
   弹窗高度随列表长度变化，而 align-items: center 会把高度变化直接变成**整体
   位置跳动** —— 实测输入搜索词后 top 从 4px 跳到 187px（结果变少 → 弹窗变矮 →
   居中的位置跟着上移）。顶部锚定后上边缘固定，只在下方伸缩，视觉上稳定。
   只作用于模型列表，不影响账号备份弹窗。
   ⚠️ 本文件整体是 JS 模板字符串，注释里**不能出现反引号**（会提前终止字符串）。 */
.dim-jh-modalOverlay--top { align-items: flex-start; padding-top: max(24px, 8vh); }
/* 顶锚后可用高度由 padding 决定，故 max-height 按 padding box 计算（100%），
   不再用 100vh - 48px 这类视口算式 —— 否则 8vh 大于 24px 时会溢出视口。 */
.dim-jh-modalOverlay--top .dim-jh-modal { max-height: 100%; }
.dim-jh-modal { display: flex; flex-direction: column; width: min(560px, 100%); max-height: min(640px, calc(100vh - 48px)); padding: 20px 22px; border-radius: 14px; background: var(--dsw-alias-bg-layer-1, #fff); box-shadow: 0 16px 48px rgba(0,0,0,0.22); }
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
/* 批量工具条（打开全部 / 关闭全部）：固定不滚动，紧跟在说明文字下方 */
.dim-jh-modelBulkBar { flex: none; display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
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
.dim-jh-modelInfo { flex: 1 1 auto; min-width: 0; display: flex; align-items: baseline; gap: 8px; }
/* 名称与 id 都必须能收缩（min-width: 0 + 可收缩的 flex-basis），否则长内容会
   顶宽整行。展示名优先保留，故 id 另加 max-width 上限。
   ⚠️ id 早期是 flex: none（拒绝收缩）—— 那正是「开关被挤出可视区」最直接的成因。 */
.dim-jh-modelName { flex: 0 1 auto; min-width: 0; overflow: hidden; font-size: 13px; line-height: 19px; font-weight: 500; color: var(--dsw-alias-label-primary, #1f2329); text-overflow: ellipsis; white-space: nowrap; }
.dim-jh-modelId { flex: 0 1 auto; min-width: 0; max-width: 46%; overflow: hidden; padding: 1px 5px; border-radius: 5px; background: var(--dsw-alias-bg-layer-2, #f4f5f7); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--dsw-alias-label-tertiary, #8f959e); text-overflow: ellipsis; white-space: nowrap; }

/* 开关：基于 checkbox 绘制，保持原生语义（可聚焦、可键盘操作、可读屏） */
.dim-jh-switch { flex: none; appearance: none; -webkit-appearance: none; position: relative; width: 34px; height: 20px; margin: 0; border-radius: 999px; background: var(--dsw-alias-border-l2, #d0d3d9); cursor: pointer; transition: background .18s ease; }
.dim-jh-switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgb(31 35 41 / 20%); transition: transform .18s ease; }
.dim-jh-switch:checked { background: #1677ff; }
.dim-jh-switch:checked::after { transform: translateX(14px); }
.dim-jh-switch:focus-visible { outline: none; box-shadow: 0 0 0 2px color-mix(in srgb, #1677ff 30%, transparent); }
.dim-jh-switch:disabled { opacity: 0.5; cursor: default; }

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
/* 弹窗底部动作区：右对齐（生成/确认按钮） */
.dim-jh-modalActions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
`;
var injected = false;
function installJetHubStyles() {
  if (injected) return () => {
  };
  injected = true;
  const style = document.createElement("style");
  style.textContent = STYLES;
  document.head.appendChild(style);
  return () => {
    style.remove();
    injected = false;
  };
}

// plugin-src/client/jet-hub.js
var React = __toESM(require("react"), 1);

// plugin-src/client/credits-capabilities.js
var CREDITS_CAPABILITIES = Object.freeze({
  codearts: Object.freeze({ balance: true, dailyCheckin: true }),
  buddy: Object.freeze({ balance: true, dailyCheckin: true }),
  workbuddy: Object.freeze({ balance: true, dailyCheckin: false }),
  lobsterai: Object.freeze({ balance: true, dailyCheckin: true }),
  // Qoder：余额（`sash/api/v2/me/usage`）+ 每日领取
  // （`sash/api/v1/me/campaigns` → `POST …/{campaignId}/claim`，
  // 2026-09-21 由 keylog 解密抓包解出）。
  // 显式登记而非省略 —— 单测要求本表与 PROVIDERS 同步。
  qoder: Object.freeze({ balance: true, dailyCheckin: true }),
  // TRAE：余额与签到都有（`/trae/api/v2/pay/ide_user_ent_usage` +
  // `checkin_credits/status` → `checkin_credits/claim`，见 `src/trae-credits.ts`）。
  trae: Object.freeze({ balance: true, dailyCheckin: true }),
  // Cline：**只有余额**，没有签到。
  //
  // 余额：`GET /api/v1/users/{accountId}/balance`
  // （实测 `{data:{userId, balance:500000}, success:true}`，见 `src/cline-credits.ts`）。
  //
  // ⚠️ `dailyCheckin: false` 的依据是**对整个 sidecar 二进制做字符串扫描**：
  // `checkin` / `check-in` / `daily` / `campaign` 均无任何 Cline 业务端点命中
  // （`campaign` 的命中是 PostHog 的 UTM 参数与 feature-flag 事件属性；
  // `daily` 是 YAML cron 别名与 Blob 导出频率枚举）。
  // 这比「某次调用没看到」强，但仍不等于「永远不存在」—— 若将来 Cline 增加
  // 签到，需按 Qoder 那次教训重新采集（见 AGENTS.md 的对应章节）。
  cline: Object.freeze({ balance: true, dailyCheckin: false }),
  // Loomy（讯飞）：三项能力齐全，且是**唯一**有第三项（新手任务）的渠道。
  //
  // 余额：`GET /api/v1/points/records`（**只读**）—— 刻意不用 `first-login`，
  //   那是写端点，在面板挂载这种高频路径上调用会意外触发签到。
  // 每日签到：`POST /api/v1/points/first-login`。⚠️ 语义是「触发每日赠送额度」
  //   而不是「+5000 积分」：实测 `dailyBalance = dailyQuota - dailyConsumed`
  //   （4992 = 5000 - 8），消耗后不回补。
  // 新手任务：`GET/POST /api/v1/onboarding/tasks*`，8 个任务合计 **10000 分**，
  //   **一次性**（每号只能领一次），故必须与每日签到分开成一个独立按钮 ——
  //   混进「一键签到」会导致每天对已领完的账号发 8 个必然 alreadyCompleted 的请求。
  loomy: Object.freeze({ balance: true, dailyCheckin: true, onboardingTasks: true }),
  // Raccoon Work（商汤小浣熊）：余额 + **一次性**登录奖励。
  //
  // 余额：`GET /api/web/points/v1/balance`（**只读**，实测返回
  //   `{available_points, daily_points, reward_points, topup_points}`）。
  //
  // ⚠️ **不登记 `dailyCheckin`，且这不是遗漏** —— 实测「每日 300 积分」是
  //   **服务端按日自动发放**的（账单里 `biz_type: 'daily_grant'`，
  //   该账号 13:30 注册、13:31 即到账），**没有可调用的签到端点**。
  //   把它实现成签到按钮会让用户每次点击都必然失败 ——
  //   与 CodeArts 早期「对不支持的 provider 无条件发请求」是同一类缺陷。
  //
  // 登录奖励：`POST /api/web/desktop/v1/login/points/grant`，3000 分，
  //   **幂等一次性**（已领过返回 `granted:false` 且账单里能看到上一次记录）。
  //   语义与 Loomy 的新手任务同构，故登记为 `onboardingTasks` 而**不是**
  //   `dailyCheckin` —— 后者会让用户以为每天都真的加了额度。
  //   ⚠️ 该端点**需要** `X-Client-Platform` 头（值见 RaccoonProduct.clientPlatform）。
  raccoon: Object.freeze({ balance: true, onboardingTasks: true })
});
var RATE_LIMIT_CAPABILITIES = Object.freeze({
  // Loomy（讯飞）：**不返回限流错误** —— 积分耗尽时静默降级为扣永久积分，
  // 故「重测 / 重置」这组按钮对它无意义（重测还会白烧积分）。
  loomy: Object.freeze({ rateLimit: false })
});
function supportsRateLimit(provider) {
  return RATE_LIMIT_CAPABILITIES[provider]?.rateLimit !== false;
}
function supportsPermanentLock(provider) {
  return provider === "loomy";
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

// plugin-src/client/model-bulk.js
function bulkButtonState(models, busy) {
  if (busy || !models || models.length === 0) {
    return { openAllDisabled: true, closeAllDisabled: true };
  }
  const anyDisabled = models.some((m) => m.disabled);
  const anyEnabled = models.some((m) => !m.disabled);
  return { openAllDisabled: !anyDisabled, closeAllDisabled: !anyEnabled };
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

// plugin-src/client/jet-hub.js
var JET_HUB_RPC_CHANNEL = "/jet-hub";
var CODEARTS_ICON = "data:image/png;base64,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";
var CODEBUDDY_ICON = "data:image/png;base64,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";
var WORKBUDDY_ICON = "data:image/png;base64,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";
var LOBSTERAI_ICON = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0Ij48cmVjdCB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHJ4PSI1IiBmaWxsPSIjZTg1MDNhIi8+PHBhdGggZD0iTTEyIDUuNWMtMi40IDAtNC4yIDEuNi00LjIgNHY1LjJjMCAyLjMgMS44IDMuOCA0LjIgMy44czQuMi0xLjUgNC4yLTMuOFY5LjVjMC0yLjQtMS44LTQtNC4yLTR6IiBmaWxsPSIjZmZmIi8+PGNpcmNsZSBjeD0iMTAuMyIgY3k9IjEwLjIiIHI9IjEiIGZpbGw9IiNlODUwM2EiLz48Y2lyY2xlIGN4PSIxMy43IiBjeT0iMTAuMiIgcj0iMSIgZmlsbD0iI2U4NTAzYSIvPjxwYXRoIGQ9Ik04LjQgNy4yIDYuMiA0LjltOS40IDIuMyAyLjItMi4zTTkuOSAxOC41bC0xLjQgMm02LjYtMiAxLjQgMiIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjEuNCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBmaWxsPSJub25lIi8+PC9zdmc+";
var QODER_ICON = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0Ij48cmVjdCB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHJ4PSI1IiBmaWxsPSIjMWYyYTNmIi8+PGNpcmNsZSBjeD0iMTEiIGN5PSIxMSIgcj0iNC42IiBmaWxsPSJub25lIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMS44Ii8+PHBhdGggZD0iTTEzLjkgMTMuOSAxNyAxN2EwLjk1IDAuOTUgMCAwIDEtMS4zNSAxLjM1bC0zLjEtMy4xIiBmaWxsPSIjZmZmIi8+PC9zdmc+";
var TRAE_ICON = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjM4IDM4IDQzNSA0MzUiIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCI+PHBhdGggZmlsbD0iIzMyRjA4QyIgZmlsbC1ydWxlPSJldmVub2RkIiBkPSJNNTggMTE2aDM5NXYyNzlIMTE1di01NUg1OHpNMTE1IDE3MmgyODF2MTY4SDExNXoiLz48cGF0aCBmaWxsPSIjMzJGMDhDIiBkPSJNMjE1LjUgMjE1LjVsMzkgMzktMzkgMzktMzktMzl6TTMyOSAyMTUuNWwzOSAzOS0zOSAzOS0zOS0zOXoiLz48L3N2Zz4=";
var CLINE_ICON = "data:image/png;base64,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";
var LOOMY_ICON = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"%3E%3Crect width="24" height="24" rx="6" fill="%23007aff"/%3E%3Ctext x="12" y="17.5" font-size="15" font-family="sans-serif" font-weight="700" fill="white" text-anchor="middle"%3EL%3C/text%3E%3C/svg%3E';
var RACCOON_ICON = "data:image/png;base64,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";
var PROVIDERS = Object.freeze([
  { id: "codearts", label: "CodeArts (华为云)", icon: CODEARTS_ICON, logoClass: "codearts" },
  { id: "buddy", label: "CodeBuddy (腾讯)", icon: CODEBUDDY_ICON, logoClass: "buddy" },
  { id: "workbuddy", label: "WorkBuddy (国际版)", icon: WORKBUDDY_ICON, logoClass: "workbuddy" },
  { id: "lobsterai", label: "LobsterAI (有道)", icon: LOBSTERAI_ICON, logoClass: "lobsterai" },
  { id: "qoder", label: "Qoder", icon: QODER_ICON, logoClass: "qoder" },
  { id: "trae", label: "TRAE (字节)", icon: TRAE_ICON, logoClass: "trae" },
  { id: "cline", label: "Cline", icon: CLINE_ICON, logoClass: "cline" },
  { id: "loomy", label: "Loomy (讯飞)", icon: LOOMY_ICON, logoClass: "loomy" },
  // ⚠️ 用『Raccoon (商汤)』而非『Raccoon Work (商汤)』—— 后者在 provider 列表里
  // **触发换行**（用户报障）。与 `RaccoonProduct.displayName` 保持一致。
  { id: "raccoon", label: "Raccoon (商汤)", icon: RACCOON_ICON, logoClass: "raccoon" }
]);
function ProviderLogo({ provider }) {
  const p = PROVIDERS.find((p2) => p2.id === provider);
  if (!p) return null;
  return React.createElement(
    "span",
    { className: `dim-jh-providerIcon ${p.logoClass}` },
    React.createElement("img", { src: p.icon, alt: "", width: 20, height: 20 })
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
  return d.toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
var RETEST_HELP = "对本账号每个「限额重置」标记的模型真实发送一条最小消息：正常返回则清除该标记，仍被限流则保留。会消耗少量模型额度。";
var RETEST_ALL_HELP = "对本页全部账号（含已停用）执行「重测」：逐个模型真实发送一条最小消息，正常返回才清除标记。停用账号同样会发送。会消耗模型额度。";
var RESET_HELP = "直接清除本账号的全部「限额重置」标记，不发送任何请求。适用于你已确认额度恢复、只想清掉显示的情况。";
var RESET_ALL_HELP = "直接清除本页全部账号（含已停用）的「限额重置」标记，不发送任何请求。";
var MODEL_LIST_HELP = "列出该 Provider 的全部模型。每个模型后面的开关默认打开；关闭后，该模型不再出现在对话框的模型选择列表里（黑名单制：只有被关闭的才隐藏，其余含服务端新增的模型一律默认显示）。此设置持久化保存，可随时重新打开。";
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
function formatCredits(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
function formatPackageLine(pkg) {
  const remaining = formatCredits(pkg.remaining) ?? "?";
  const total = formatCredits(pkg.total) ?? "?";
  const parts = [`${pkg.active ? "" : "[已失效] "}${pkg.name || "未命名"}: ${remaining} / ${total}`];
  if (!pkg.active && pkg.expiredTime) parts.push(`失效于 ${pkg.expiredTime}`);
  else if (pkg.cycleEndTime) parts.push(`本周期至 ${pkg.cycleEndTime}`);
  return parts.join(" · ");
}
function CreditBalanceRow({ balance, error, loading }) {
  if (loading) {
    return React.createElement(
      "div",
      { className: "dim-jh-metaRow" },
      React.createElement("dt", null, "积分"),
      React.createElement("dd", { "data-tone": "muted" }, "读取中…")
    );
  }
  if (error || !balance) {
    return React.createElement(
      "div",
      { className: "dim-jh-metaRow" },
      React.createElement("dt", null, "积分"),
      React.createElement(
        "dd",
        { "data-tone": "warn", title: error || "查询失败" },
        error || "查询失败"
      )
    );
  }
  const total = formatCredits(balance.total) ?? "0";
  const detail = (balance.packages || []).map(formatPackageLine).join("\n");
  const all = balance.packages || [];
  const activeCount = all.filter((p) => p.active).length;
  const isLoomyTwoPools = all.length === 2 && all[0].name === "永久积分" && all[1].name === "每日赠送";
  return React.createElement(
    "div",
    { className: "dim-jh-metaRow" },
    React.createElement("dt", null, "积分"),
    React.createElement(
      "dd",
      {
        className: "dim-jh-creditValue",
        title: detail || void 0
      },
      React.createElement("strong", { className: "dim-jh-creditTotal" }, total),
      isLoomyTwoPools ? React.createElement(
        "span",
        { className: "dim-jh-creditPools" },
        `永久 ${formatCredits(all[0].remaining) ?? "0"} · 每日 ${formatCredits(all[1].remaining) ?? "0"}`
      ) : null,
      !isLoomyTwoPools && all.length > 1 ? React.createElement(
        "span",
        { className: "dim-jh-creditPackages" },
        `${activeCount}/${all.length} 个资源包有效`
      ) : null,
      // 失效额度单独提示：它们仍在服务端响应里，但不计入上面的数字
      balance.expiredTotal > 0 ? React.createElement(
        "span",
        { className: "dim-jh-creditExpired" },
        `另有 ${formatCredits(balance.expiredTotal)} 已失效`
      ) : null
    )
  );
}
function AccountCard({ account, index, order, onToggle, onDelete, onRetest, onReset, onClaimOnboarding, onboardingBusy, busy, credits, creditsLoading, showCredits, showRateLimitActions, drag }) {
  const rateLimits = account.modelRateLimits ? Object.entries(account.modelRateLimits).filter(([, v]) => v > Date.now()) : [];
  const expired = typeof account.expiresAt === "number" && account.expiresAt > 0 && account.expiresAt <= Date.now();
  const hasAnyLimit = Boolean(account.modelRateLimits && Object.keys(account.modelRateLimits).length > 0);
  const dragProps = drag || {};
  return React.createElement(
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
    React.createElement(
      "div",
      { className: "dim-jh-accountTop" },
      // 抓取柄 + 序号：序号即自动选号的优先级，让"拖到第一位"的含义明确。
      dragProps.enabled ? React.createElement("span", {
        className: "dim-jh-dragHandle",
        title: "拖动以调整顺序（顺序即自动选号优先级）",
        "aria-hidden": "true"
      }, "⠿") : null,
      dragProps.enabled ? React.createElement(
        "span",
        { className: "dim-jh-accountOrder", title: "自动选号优先级" },
        String((order ?? index ?? 0) + 1)
      ) : null,
      React.createElement("span", {
        className: "dim-jh-accountStatus",
        "data-on": account.enabled ? "true" : "false",
        title: account.enabled ? "已启用" : "已停用",
        "aria-hidden": "true"
      }),
      React.createElement(
        "span",
        { className: "dim-jh-accountName" },
        account.nickname || account.id
      ),
      React.createElement("span", {
        className: "dim-jh-accountTag",
        "data-tone": account.enabled ? "on" : "off"
      }, account.enabled ? "已启用" : "已停用")
    ),
    React.createElement(
      "dl",
      { className: "dim-jh-accountMeta" },
      React.createElement(
        "div",
        { className: "dim-jh-metaRow" },
        React.createElement("dt", null, "凭据"),
        React.createElement("dd", null, React.createElement("code", null, account.credentialRef))
      ),
      React.createElement(
        "div",
        { className: "dim-jh-metaRow" },
        React.createElement("dt", null, "有效期"),
        React.createElement(
          "dd",
          { "data-tone": expired ? "warn" : void 0 },
          account.expiresAt ? `${formatTime(account.expiresAt) || "未知"}${account.refreshable ? " · 自动续期" : ""}` : "未知"
        )
      ),
      // 不支持积分余额的 provider 不渲染该行：留着它只能显示「查询失败」，
      // 而失败原因是「这个 provider 根本没有此接口」——与其展示一条无法修复
      // 的错误，不如不展示。
      showCredits ? React.createElement(CreditBalanceRow, {
        balance: credits?.balance ?? null,
        error: credits?.error,
        loading: creditsLoading
      }) : null
    ),
    rateLimits.length > 0 ? React.createElement(
      "div",
      { className: "dim-jh-rateLimits" },
      React.createElement("span", { className: "dim-jh-rateLimitsLabel" }, "限额重置"),
      rateLimits.map(([modelId, resetAt]) => React.createElement("span", {
        key: modelId,
        className: "dim-jh-ttlBadge",
        title: `模型 ${modelId}`
      }, `${modelId} · ${formatTime(resetAt)}`))
    ) : null,
    React.createElement(
      "div",
      { className: "dim-jh-accountActions" },
      // 新手任务（仅 Loomy）：一次性 10000 分，每号只能领一次。
      // 与「一键领取积分」（每日签到）是**不同**的操作，故独立按钮 ——
      // 混进「一键签到」会导致每天对已领完的账号发 8 个必然 alreadyCompleted 的请求。
      //
      // ⚠️ **只显示礼物图标**（用户报障：「领取新手任务」文字太长、按钮溢出行尾）。
      // 该行有 5 个按钮且 `flex-wrap: nowrap`，多一个宽按钮就会被挤出容器。
      // 文案移到 `title`（hover tooltip）与 `aria-label`（无障碍）里。
      onClaimOnboarding ? React.createElement("button", {
        className: "dim-jh-btn dim-jh-iconBtn",
        // tooltip 说明「是什么 + 一次性 + 多少分」，因为图标本身不自解释
        title: "领取新手任务（合计 10000 积分，每个账号仅能领取一次）",
        "aria-label": "领取新手任务",
        disabled: busy || onboardingBusy,
        onClick: () => onClaimOnboarding(account.id)
      }, onboardingBusy ? "领取中…" : React.createElement(
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
        React.createElement("rect", { x: 3, y: 8, width: 18, height: 4, rx: 1 }),
        React.createElement("path", { d: "M12 8v13" }),
        React.createElement("path", { d: "M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7" }),
        React.createElement("path", { d: "M7.5 8a2.5 2.5 0 0 1 0-5A4.8 4.8 0 0 1 12 8a4.8 4.8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5" })
      )) : null,
      // 卡片级「重测 / 重置」同样只对会限流的 provider 有意义
      // （Loomy 不返回限流错误，故这两个按钮对它永远禁用 —— 直接不渲染）。
      showRateLimitActions ? React.createElement("button", {
        className: "dim-jh-btn",
        title: RETEST_HELP,
        disabled: busy || !hasAnyLimit,
        onClick: () => onRetest(account.id)
      }, "重测") : null,
      showRateLimitActions ? React.createElement("button", {
        className: "dim-jh-btn",
        title: RESET_HELP,
        disabled: busy || !hasAnyLimit,
        onClick: () => onReset(account.id)
      }, "重置") : null,
      React.createElement("button", {
        className: "dim-jh-btn",
        onClick: () => onToggle(account.id, !account.enabled)
      }, account.enabled ? "停用" : "启用"),
      React.createElement("button", {
        className: "dim-jh-btn",
        "data-kind": "danger",
        onClick: () => onDelete(account.id)
      }, "删除")
    )
  );
}
function ModelToggle({ model, busy, onToggle }) {
  return React.createElement(
    "label",
    {
      className: "dim-jh-modelRow",
      "data-disabled": model.disabled ? "true" : "false",
      title: model.id
    },
    React.createElement(
      "span",
      { className: "dim-jh-modelInfo" },
      React.createElement("strong", { className: "dim-jh-modelName" }, model.name || model.id),
      React.createElement("code", { className: "dim-jh-modelId" }, model.id)
    ),
    React.createElement("input", {
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
  const [models, setModels] = React.useState(null);
  const [phase, setPhase] = React.useState("loading");
  const [error, setError] = React.useState(null);
  const [toggleError, setToggleError] = React.useState(null);
  const [busyIds, setBusyIds] = React.useState(() => /* @__PURE__ */ new Set());
  const [bulkBusy, setBulkBusy] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("all");
  const mounted = React.useRef(true);
  const load = React.useCallback(async () => {
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
  React.useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);
  React.useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  const toggleModel = async (modelId, disabled) => {
    setBusyIds((prev) => new Set(prev).add(modelId));
    setToggleError(null);
    try {
      await rpcCall("model.setDisabled", { provider, modelId, disabled });
      if (!mounted.current) return;
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
  const all = models || [];
  const hiddenCount = all.filter((m) => m.disabled).length;
  const providerLabel = PROVIDERS.find((p) => p.id === provider)?.label || provider;
  const bulk = bulkButtonState(models, bulkBusy);
  const filtered = filterModels(all, { query, status: statusFilter });
  const filtering = isFilterActive({ query, status: statusFilter });
  const resetFilters = () => {
    setQuery("");
    setStatusFilter("all");
  };
  const setAllDisabled = async (disabled) => {
    if (disabled && !confirm(`确认关闭全部 ${all.length} 个模型？关闭后它们不再出现在对话框的模型选择里。`)) {
      return;
    }
    setBulkBusy(true);
    setToggleError(null);
    try {
      await rpcCall("model.setAllDisabled", { provider, disabled });
      if (!mounted.current) return;
      setModels((prev) => (prev || []).map((m) => ({ ...m, disabled })));
    } catch (caught) {
      console.error("[jet-hub] bulk toggle failed:", caught);
      if (!mounted.current) return;
      setToggleError(caught?.message || `批量${disabled ? "关闭" : "打开"}模型失败`);
    } finally {
      if (mounted.current) setBulkBusy(false);
    }
  };
  const dialog = React.createElement(
    "div",
    {
      // `--top`：顶部锚定。列表长度随搜索变化，若垂直居中会让弹窗整体上下跳动
      //（见 jet-hub-styles.js 中该修饰类的说明）。
      className: "dim-jh-modalOverlay dim-jh-modalOverlay--top",
      // 点击遮罩关闭；点击弹窗内部不关闭（stopPropagation 由内层容器负责）。
      onClick: (event) => {
        if (event.target === event.currentTarget) onClose();
      }
    },
    React.createElement(
      "div",
      {
        className: "dim-jh-modal",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": `${providerLabel} 模型列表`
      },
      React.createElement(
        "div",
        { className: "dim-jh-modalHead" },
        React.createElement(
          "div",
          { className: "dim-jh-modalTitle" },
          React.createElement("strong", null, "模型列表"),
          React.createElement("span", { className: "dim-jh-modalSubtitle" }, providerLabel),
          phase === "ready" ? React.createElement(
            "span",
            { className: "dim-jh-modelPanelCount" },
            filtering ? `${filtered.length} / ${all.length} 个模型${hiddenCount > 0 ? `，已隐藏 ${hiddenCount} 个` : ""}` : `${all.length} 个模型${hiddenCount > 0 ? `，已隐藏 ${hiddenCount} 个` : ""}`
          ) : null
        ),
        React.createElement(
          "div",
          { className: "dim-jh-modelPanelActions" },
          React.createElement("button", {
            className: "dim-jh-btn",
            disabled: phase === "loading",
            onClick: () => void load()
          }, phase === "loading" ? "读取中…" : "刷新"),
          React.createElement("button", {
            className: "dim-jh-btn",
            "data-kind": "primary",
            onClick: onClose
          }, "完成")
        )
      ),
      React.createElement(
        "p",
        { className: "dim-jh-modalHint" },
        "关闭开关后该模型不再出现在对话框的模型选择里；其余模型（含服务端新增的）默认显示。"
      ),
      // 搜索 + 状态筛选：Cline 的目录实测近 500 条，没有它就只能一页页翻。
      // 只在列表可用时渲染（载入中/出错时没有可筛的内容）。
      phase === "ready" && all.length > 0 ? React.createElement(
        "div",
        { className: "dim-jh-modelFilterBar" },
        React.createElement("input", {
          type: "search",
          className: "dim-jh-input dim-jh-modelSearch",
          placeholder: "搜索模型名或 id…",
          value: query,
          "aria-label": "搜索模型",
          onChange: (event) => setQuery(event.target.value)
        }),
        React.createElement(
          "div",
          { className: "dim-jh-modelStatusFilter", role: "group", "aria-label": "按状态筛选" },
          [["all", "全部"], ["enabled", "已打开"], ["disabled", "已关闭"]].map(([value, label]) => React.createElement("button", {
            key: value,
            className: "dim-jh-btn",
            "data-active": statusFilter === value ? "true" : "false",
            "aria-pressed": statusFilter === value ? "true" : "false",
            onClick: () => setStatusFilter(value)
          }, label))
        ),
        filtering ? React.createElement("button", {
          className: "dim-jh-btn",
          title: "清空搜索词与状态筛选，恢复完整列表。",
          onClick: resetFilters
        }, "清空筛选") : null
      ) : null,
      // 批量工具条：只在列表可用时渲染。计数从标题挪到这里，避免与标题争宽。
      phase === "ready" && all.length > 0 ? React.createElement(
        "div",
        { className: "dim-jh-modelBulkBar" },
        React.createElement("button", {
          className: "dim-jh-btn",
          title: "打开该 Provider 的全部模型开关（含此前被关闭的）。",
          disabled: bulk.openAllDisabled,
          onClick: () => void setAllDisabled(false)
        }, bulkBusy ? "处理中…" : "打开全部"),
        React.createElement("button", {
          className: "dim-jh-btn",
          title: "关闭该 Provider 的全部模型开关，关闭后它们不再出现在对话框的模型选择里。",
          disabled: bulk.closeAllDisabled,
          onClick: () => void setAllDisabled(true)
        }, bulkBusy ? "处理中…" : "关闭全部")
      ) : null,
      toggleError ? React.createElement("div", {
        className: "dim-jh-probeNotice",
        "data-tone": "error",
        role: "alert"
      }, React.createElement("div", null, toggleError)) : null,
      phase === "error" ? React.createElement(
        "div",
        { className: "dim-jh-modalBody" },
        React.createElement(
          "div",
          { className: "dim-jh-empty" },
          React.createElement("p", null, error),
          React.createElement("button", { className: "dim-jh-btn", onClick: () => void load() }, "重新读取")
        )
      ) : phase === "loading" ? React.createElement(
        "div",
        { className: "dim-jh-modalBody" },
        React.createElement("div", { className: "dim-jh-empty" }, "正在读取模型列表…")
      ) : all.length === 0 ? React.createElement(
        "div",
        { className: "dim-jh-modalBody" },
        React.createElement(
          "div",
          { className: "dim-jh-empty" },
          React.createElement("p", null, "该 Provider 当前没有可用的模型。")
        )
      ) : filtered.length === 0 ? React.createElement(
        "div",
        { className: "dim-jh-modalBody" },
        React.createElement(
          "div",
          { className: "dim-jh-empty" },
          React.createElement("p", null, "没有符合当前搜索与筛选条件的模型。"),
          React.createElement("button", { className: "dim-jh-btn", onClick: resetFilters }, "清空筛选")
        )
      ) : React.createElement(
        "div",
        { className: "dim-jh-modalBody" },
        React.createElement(
          "div",
          { className: "dim-jh-modelList" },
          // 直接渲染全部筛选结果（**无渲染上限**）：改动前 478 条就是
          // 一次性全渲染、工作正常。
          filtered.map((model) => React.createElement(ModelToggle, {
            key: model.id,
            model,
            // 批量提交期间一并禁用单条开关：黑名单是整体写入，
            // 并发提交必然互相覆盖（后写的会丢掉先写的改动）。
            busy: busyIds.has(model.id) || bulkBusy,
            onToggle: (id, disabled) => void toggleModel(id, disabled)
          }))
        )
      )
    )
  );
  return dialog;
}
function ProviderPanel({ provider, rpcCall }) {
  const [accounts, setAccounts] = React.useState([]);
  const [phase, setPhase] = React.useState("loading");
  const [error, setError] = React.useState(null);
  const [creating, setCreating] = React.useState(false);
  const [probeBusy, setProbeBusy] = React.useState(null);
  const [probeNotice, setProbeNotice] = React.useState(null);
  const [credits, setCredits] = React.useState({});
  const [creditsLoading, setCreditsLoading] = React.useState(false);
  const [loginUrlForManual, setLoginUrlForManual] = React.useState(null);
  const [draggingId, setDraggingId] = React.useState(null);
  const [dropTargetId, setDropTargetId] = React.useState(null);
  const [dropPosition, setDropPosition] = React.useState("before");
  const [reordering, setReordering] = React.useState(false);
  const [reorderError, setReorderError] = React.useState(null);
  const mounted = React.useRef(true);
  const accountsRef = React.useRef([]);
  const loadAccounts = React.useCallback(async () => {
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
  const canLoadCredits = supportsCreditBalance(provider);
  const supportsCredits = supportsDailyCheckin(provider);
  const loadCredits = React.useCallback(async () => {
    if (!canLoadCredits) return;
    setCreditsLoading(true);
    try {
      const res = await rpcCall("credits.balances", { provider });
      if (!mounted.current) return;
      const next = {};
      for (const item of res.accounts || []) {
        next[item.accountId] = { balance: item.balance, error: item.error };
      }
      setCredits(next);
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
  }, [provider, rpcCall, canLoadCredits]);
  React.useEffect(() => {
    mounted.current = true;
    void loadAccounts();
    if (canLoadCredits) void loadCredits();
    return () => {
      mounted.current = false;
    };
  }, [provider]);
  const [claiming, setClaiming] = React.useState(false);
  const [claimNotice, setClaimNotice] = React.useState(null);
  const [onboarding, setOnboarding] = React.useState(null);
  const [onboardingLoading, setOnboardingLoading] = React.useState(false);
  const [onboardingNotice, setOnboardingNotice] = React.useState(null);
  const canClaimOnboarding = supportsOnboardingTasks(provider);
  const canLockPermanent = supportsPermanentLock(provider);
  const [permanentLocked, setPermanentLocked] = React.useState(false);
  const [lockBusy, setLockBusy] = React.useState(false);
  const [lockNotice, setLockNotice] = React.useState(null);
  React.useEffect(() => {
    if (!canLockPermanent) return void 0;
    let alive = true;
    void (async () => {
      try {
        const res = await rpcCall("loomy.permanentLock", {});
        if (alive) setPermanentLocked(res?.locked === true);
      } catch (caught) {
        console.error("[jet-hub] load permanent lock failed:", caught);
      }
    })();
    return () => {
      alive = false;
    };
  }, [canLockPermanent, provider]);
  const togglePermanentLock = async () => {
    if (!canLockPermanent) return;
    const next = !permanentLocked;
    setLockBusy(true);
    setLockNotice(null);
    try {
      const res = await rpcCall("loomy.permanentLock", { locked: next });
      if (!mounted.current) return;
      setPermanentLocked(res?.locked === true);
      setLockNotice({
        tone: "ok",
        text: next ? "已锁定永久积分：只消耗每日赠送额度。今日额度用尽后将无可用账号。" : "已解锁永久积分：今日额度用尽后会继续使用永久积分。"
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
      if (canLoadCredits) await loadCredits();
    } catch (caught) {
      setOnboardingNotice({ tone: "error", text: caught?.message || "领取新手任务失败" });
    } finally {
      if (mounted.current) setOnboardingLoading(false);
    }
  };
  const [showModels, setShowModels] = React.useState(false);
  const claimCredits = async () => {
    if (!supportsCredits) return;
    setClaiming(true);
    setClaimNotice(null);
    try {
      const res = await rpcCall("credits.claimAll", { provider });
      const { summary, results } = res;
      const parts = [];
      if (summary.claimed > 0) parts.push(`${summary.claimed} 个账号领取成功（+${summary.totalCredit} 积分）`);
      if (summary.alreadyClaimed > 0) parts.push(`${summary.alreadyClaimed} 个今日已领取`);
      if (summary.inactive > 0) parts.push(`${summary.inactive} 个活动未开启`);
      if (summary.failed > 0) parts.push(`${summary.failed} 个失败`);
      if (!mounted.current) return;
      const details = [];
      for (const item of results || []) {
        const outcome = item.outcome || {};
        if (outcome.kind === "claimed") {
          details.push(`${item.nickname || item.accountId}：领取成功 +${outcome.credit} 积分`);
        } else if (outcome.kind === "already-claimed") {
          details.push(`${item.nickname || item.accountId}：${outcome.message || "今天已领取"}`);
        } else if (outcome.kind === "inactive") {
          details.push(`${item.nickname || item.accountId}：${outcome.message || "不在活动范围"}`);
        } else if (outcome.kind === "failed") {
          details.push(`${item.nickname || item.accountId}：失败 — ${outcome.message || "未知原因"}`);
        }
      }
      setClaimNotice({
        tone: summary.failed > 0 ? "warn" : "ok",
        text: parts.length > 0 ? parts.join("，") : "没有可领取的账号",
        details
      });
      await loadAccounts();
      await loadCredits();
    } catch (caught) {
      console.error("[jet-hub] claim credits failed:", caught);
      if (!mounted.current) return;
      setClaimNotice({ tone: "error", text: caught?.message || "领取积分失败" });
    } finally {
      if (mounted.current) setClaiming(false);
    }
  };
  const createAccount = async () => {
    setCreating(true);
    let accountId = "";
    let loginUrl = "";
    try {
      console.log("[jet-hub] account.create request, provider =", provider);
      const res = await rpcCall("account.create", { provider });
      console.log("[jet-hub] account.create response =", res);
      accountId = res.accountId;
      loginUrl = res.loginUrl;
      if (loginUrl) {
        const loginWindow = window.open(loginUrl, "_blank", "width=800,height=600");
        if (!loginWindow || loginWindow.closed) {
          setLoginUrlForManual(loginUrl);
        }
        const pollTimer = setInterval(async () => {
          try {
            const pollRes = await rpcCall("login.poll", { accountId, provider });
            if (pollRes.done) {
              clearInterval(pollTimer);
              if (loginWindow && !loginWindow.closed) loginWindow.close();
              setLoginUrlForManual(null);
              await loadAccounts();
            }
          } catch {
          }
        }, 1e3);
        setTimeout(() => {
          clearInterval(pollTimer);
        }, 3e5);
      } else {
        setError("后端未返回登录地址（loginUrl 为空）。");
        setPhase("error");
      }
    } catch (caught) {
      console.error("[jet-hub] create account failed:", caught);
      setError("新建账号失败：" + (caught?.message || "未知错误"));
      setPhase("error");
    } finally {
      setCreating(false);
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
                text: `账号已停用，但关闭模型失败：${caught?.message || "未知错误"}。可在「显示列表」中手动关闭。`,
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
                  text: `账号已启用，但打开模型失败：${caught?.message || "未知错误"}。可在「显示列表」中手动打开。`,
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
  return React.createElement(
    "section",
    { "aria-label": `${provider} 账号管理` },
    // 标题与按钮分开成两块（而不是同一行的 space-between）：操作按钮多达 5 个，
    // 与面板标题挤在一行时既会被压缩又会溢出。标题独占一行、按钮组另起一行
    // 并允许换行，窄面板下也能完整显示。
    React.createElement(
      "div",
      { className: "dim-jh-panelHead" },
      React.createElement(
        "h2",
        { className: "dim-jh-panelTitle" },
        `${PROVIDERS.find((p) => p.id === provider)?.label || provider} 账号管理`
      ),
      React.createElement(
        "div",
        { className: "dim-jh-headerActions" },
        React.createElement("button", {
          className: "dim-jh-btn",
          title: MODEL_LIST_HELP,
          onClick: () => setShowModels(true)
        }, "显示列表"),
        canLoadCredits ? React.createElement("button", {
          className: "dim-jh-btn",
          title: "重新查询本页全部账号的剩余积分（Credits Balance）。余额由服务端实时计算，点此可刷新。",
          disabled: creditsLoading,
          onClick: () => void loadCredits()
        }, creditsLoading ? "查询中…" : "刷新积分") : null,
        supportsCredits ? React.createElement("button", {
          className: "dim-jh-btn",
          title: `领取全部 ${PROVIDERS.find((p) => p.id === provider)?.label || provider} 账号（含已停用）的每日签到积分`,
          disabled: claiming || accounts.length === 0,
          onClick: () => void claimCredits()
        }, claiming ? "领取中…" : "一键领取积分") : null,
        // 「重测 / 重置」只对**会返回限流错误**的 provider 有意义。
        // ⚠️ Loomy 不会限流（积分耗尽时静默降级为扣永久积分），故对它
        // 隐藏这两个按钮 —— 重测永远测不出限流、重置也没有标记可清，
        // 而重测还会白烧积分（用户报障：「这个 provider 好像没发现模型限流，
        // 把重置所有按钮删掉」）。
        supportsRateLimit(provider) ? React.createElement("button", {
          className: "dim-jh-btn",
          title: RETEST_ALL_HELP,
          disabled: probeBusy !== null || accounts.length === 0,
          onClick: () => void runLimitAction("retestAll")
        }, probeBusy === "all" ? "重测中…" : "重测所有") : null,
        supportsRateLimit(provider) ? React.createElement("button", {
          className: "dim-jh-btn",
          title: RESET_ALL_HELP,
          disabled: probeBusy !== null || accounts.length === 0,
          onClick: () => void runLimitAction("resetAll")
        }, "重置所有") : null,
        // 锁定永久积分（仅 Loomy）：只消耗每日赠送额度，保住永久积分。
        canLockPermanent ? React.createElement("button", {
          className: "dim-jh-btn",
          "data-kind": permanentLocked ? "primary" : void 0,
          title: permanentLocked ? "当前已锁定永久积分：只消耗每日赠送额度。今日额度用尽后将没有可用账号。点此解锁。" : "锁定永久积分后只消耗每日赠送额度（今日额度用尽即无可用账号），可保住永久积分。点此锁定。",
          disabled: lockBusy,
          onClick: () => void togglePermanentLock()
        }, lockBusy ? "处理中…" : permanentLocked ? "解锁永久积分" : "锁定永久积分") : null,
        React.createElement("button", {
          className: "dim-jh-btn",
          "data-kind": "primary",
          title: "通过浏览器登录一个新的账号并加入账号池。",
          onClick: () => void createAccount(),
          disabled: creating
        }, creating ? "正在登录…" : "+ 新建账号")
      )
    ),
    probeNotice ? React.createElement(
      "div",
      {
        className: "dim-jh-probeNotice",
        "data-tone": probeNotice.tone,
        role: "status"
      },
      React.createElement("div", null, probeNotice.text),
      probeNotice.details.length > 0 ? React.createElement(
        "ul",
        { className: "dim-jh-probeDetails" },
        probeNotice.details.map((d, i) => React.createElement("li", { key: i }, d))
      ) : null
    ) : null,
    lockNotice ? React.createElement("div", {
      className: "dim-jh-probeNotice",
      "data-tone": lockNotice.tone,
      role: lockNotice.tone === "error" ? "alert" : "status"
    }, lockNotice.text) : null,
    claimNotice ? React.createElement(
      "div",
      {
        className: "dim-jh-probeNotice",
        "data-tone": claimNotice.tone,
        role: claimNotice.tone === "error" ? "alert" : "status"
      },
      React.createElement("div", null, claimNotice.text),
      // 逐账号原因列表。没有它时用户只看到「1 个失败」，无从判断是
      // 凭据问题、活动未开、还是解析 bug。
      (claimNotice.details || []).length > 0 ? React.createElement(
        "ul",
        { className: "dim-jh-probeDetails" },
        claimNotice.details.map((d, i) => React.createElement("li", { key: i }, d))
      ) : null
    ) : null,
    // 新手任务结果（仅 Loomy，一次性领取）。
    onboardingNotice ? React.createElement(
      "div",
      {
        className: "dim-jh-probeNotice",
        "data-tone": onboardingNotice.tone,
        role: onboardingNotice.tone === "error" ? "alert" : "status"
      },
      React.createElement("div", null, onboardingNotice.text),
      (onboardingNotice.details || []).length > 0 ? React.createElement(
        "ul",
        { className: "dim-jh-probeDetails" },
        onboardingNotice.details.map((line, index) => React.createElement("li", { key: index }, line))
      ) : null
    ) : null,
    // 弹窗被拦截：给出可点击的登录链接。不劫持当前页面（见 createAccount 的说明）。
    loginUrlForManual ? React.createElement(
      "div",
      {
        className: "dim-jh-probeNotice",
        "data-tone": "warn",
        role: "alert"
      },
      React.createElement("div", null, "登录窗口被浏览器拦截，请手动打开下方链接完成登录："),
      React.createElement("a", {
        className: "dim-jh-loginLink",
        href: loginUrlForManual,
        target: "_blank",
        rel: "noopener noreferrer"
      }, loginUrlForManual)
    ) : null,
    phase === "loading" ? React.createElement("div", { className: "dim-jh-empty" }, "正在读取账号列表…") : phase === "error" ? React.createElement(
      "div",
      { className: "dim-jh-empty", role: "alert" },
      React.createElement("p", null, error),
      React.createElement("button", { className: "dim-jh-btn", onClick: loadAccounts }, "重新读取")
    ) : accounts.length === 0 ? React.createElement(
      "div",
      { className: "dim-jh-empty" },
      React.createElement("p", null, "尚未配置账号"),
      React.createElement("p", null, '点击"+ 新建账号"进行浏览器登录。')
    ) : React.createElement(
      "div",
      null,
      // 排序提示：顺序会真实影响自动选号，必须让用户知道，否则
      // 「拖了有什么用」无从得知。仅两个以上账号时才显示。
      accounts.length > 1 ? React.createElement(
        "p",
        { className: "dim-jh-orderHint" },
        "拖动卡片可调整顺序（也可直接拖整张卡片）。顺序即自动选号与限流换号的优先级，排在前面的账号优先使用。"
      ) : null,
      reorderError ? React.createElement("div", {
        className: "dim-jh-probeNotice",
        "data-tone": "warn",
        role: "alert"
      }, React.createElement("div", null, `顺序保存失败：${reorderError}`)) : null,
      accounts.map((account, index) => React.createElement(AccountCard, {
        key: account.id,
        account,
        index,
        busy: probeBusy !== null,
        credits: credits[account.id],
        creditsLoading: creditsLoading && credits[account.id] === void 0,
        showCredits: canLoadCredits,
        // 卡片级「重测 / 重置」：只对会返回限流错误的 provider 渲染。
        showRateLimitActions: supportsRateLimit(provider),
        onToggle: toggleAccount,
        onDelete: deleteAccount,
        onRetest: (id) => void runLimitAction("retest", id),
        onReset: (id) => void runLimitAction("reset", id),
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
    showModels ? React.createElement(ModelListPanel, {
      provider,
      rpcCall,
      onClose: () => setShowModels(false)
    }) : null
  );
}
function BackupPanel({ rpcCall, onImported }) {
  const [dialog, setDialog] = React.useState(null);
  const [encrypt, setEncrypt] = React.useState(true);
  const [pass1, setPass1] = React.useState("");
  const [pass2, setPass2] = React.useState("");
  const [importFile, setImportFile] = React.useState(null);
  const [importPass, setImportPass] = React.useState("");
  const [backupStatus, setBackupStatus] = React.useState(null);
  const [confirmStep, setConfirmStep] = React.useState(false);
  const [decryptedPayload, setDecryptedPayload] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState(null);
  const fileRef = React.useRef(null);
  const mounted = React.useRef(true);
  React.useEffect(() => {
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
  };
  const safeNotice = (next) => {
    if (mounted.current) setNotice(next);
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
    setBusy(true);
    setNotice(null);
    try {
      const res = await rpcCall("backup.export", {});
      const payload = res.payload;
      const warnings = res.warnings || [];
      const stamp = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10).replace(/-/g, "");
      let data = payload;
      let filename = `dsh-codearts-backup-${stamp}.json`;
      if (encrypt) {
        data = await encryptBackup(payload, pass1);
        filename = `dsh-codearts-backup-${stamp}.enc.json`;
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
      setImportFile({ name: file.name, encrypted: isEncryptedBackup(parsed), parsed });
      setDialog("import");
      setImportPass("");
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
      const res = await rpcCall("backup.import", { payload });
      const parts = [`已导入 ${res.accountsImported} 个账号`, `${res.credentialsImported} 条凭据`];
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
  const renderDialog = () => {
    const isExport = dialog === "export";
    const title = isExport ? "导出备份" : "导入备份";
    const subtitle = isExport ? "全部 provider 的账号密钥与凭据" : importFile?.name || "";
    const body = isExport ? React.createElement(
      React.Fragment,
      null,
      React.createElement(
        "p",
        { className: "dim-jh-modalHint" },
        "备份文件包含全部账号的密钥与 refresh_token，请",
        React.createElement("strong", { className: "dim-jh-emph-warn" }, "妥善保管"),
        "。"
      ),
      React.createElement(
        "p",
        { className: "dim-jh-modalHint" },
        "备份是导出时刻的凭据快照：refresh_token 会随续期轮换或过期，建议导出后尽快迁移，导入后失效的账号需重新登录。"
      ),
      React.createElement(
        "label",
        { className: "dim-jh-checkRow" },
        React.createElement("input", {
          type: "checkbox",
          checked: encrypt,
          onChange: (event) => setEncrypt(event.target.checked)
        }),
        "加密备份文件（推荐）"
      ),
      encrypt ? React.createElement(
        "div",
        { className: "dim-jh-formRows" },
        React.createElement("input", {
          className: "dim-jh-input",
          type: "password",
          placeholder: "备份口令（用于解密，请牢记）",
          value: pass1,
          onChange: (event) => setPass1(event.target.value)
        }),
        React.createElement("input", {
          className: "dim-jh-input",
          type: "password",
          placeholder: "再次输入口令",
          value: pass2,
          onChange: (event) => setPass2(event.target.value)
        })
      ) : null
    ) : !isExport && confirmStep ? (
      // 导入确认页（应用内二次确认）：展示覆盖警告与提示
      React.createElement(
        React.Fragment,
        null,
        React.createElement(
          "p",
          { className: "dim-jh-modalHint" },
          "导入将",
          React.createElement("strong", { className: "dim-jh-emph-danger" }, "覆盖"),
          "当前全部账号与模型开关（共 ",
          React.createElement("strong", { className: "dim-jh-emph-warn" }, `${decryptedPayload?.accounts?.length ?? 0}`),
          " 个账号），且",
          React.createElement("strong", { className: "dim-jh-emph-danger" }, "不可撤销"),
          "。"
        ),
        backupStatus?.withoutExpiry > 0 ? React.createElement(
          "p",
          { className: "dim-jh-modalHint" },
          "当前有 ",
          React.createElement("strong", { className: "dim-jh-emph-warn" }, `${backupStatus.withoutExpiry}`),
          " 个账号缺少有效期信息（可能是版本切换后自动恢复的），导入将",
          React.createElement("strong", { className: "dim-jh-emph-warn" }, "整体覆盖"),
          "它们。"
        ) : null
      )
    ) : importFile?.encrypted ? React.createElement(
      React.Fragment,
      null,
      React.createElement(
        "p",
        { className: "dim-jh-modalHint" },
        "该备份已加密，请输入导出时设置的口令。"
      ),
      React.createElement("input", {
        className: "dim-jh-input",
        type: "password",
        placeholder: "备份口令",
        value: importPass,
        onChange: (event) => setImportPass(event.target.value)
      })
    ) : React.createElement(
      "p",
      { className: "dim-jh-modalHint" },
      "该备份为明文文件，导入将覆盖当前全部账号与模型开关。"
    );
    return React.createElement(
      "div",
      {
        className: "dim-jh-modalOverlay",
        onClick: (event) => {
          if (event.target === event.currentTarget) closeDialog();
        }
      },
      React.createElement(
        "div",
        {
          className: "dim-jh-modal",
          role: "dialog",
          "aria-modal": "true",
          "aria-label": title
        },
        React.createElement(
          "div",
          { className: "dim-jh-modalHead" },
          React.createElement(
            "div",
            { className: "dim-jh-modalTitle" },
            React.createElement("strong", null, title),
            subtitle.length > 0 ? React.createElement("span", { className: "dim-jh-modalSubtitle" }, subtitle) : null
          ),
          React.createElement(
            "div",
            { className: "dim-jh-modelPanelActions" },
            React.createElement("button", {
              className: "dim-jh-btn",
              onClick: closeDialog
            }, "关闭")
          )
        ),
        React.createElement(
          "div",
          { className: "dim-jh-modalBody" },
          body,
          notice ? React.createElement("div", {
            className: "dim-jh-probeNotice",
            "data-tone": notice.tone,
            role: notice.tone === "error" ? "alert" : "status"
          }, React.createElement("div", null, notice.text)) : null,
          React.createElement(
            "div",
            { className: "dim-jh-modalActions" },
            isExport ? React.createElement("button", {
              className: "dim-jh-btn",
              "data-kind": "primary",
              disabled: busy,
              onClick: () => void doExport()
            }, busy ? "生成中…" : "生成备份文件") : confirmStep ? React.createElement(
              React.Fragment,
              null,
              React.createElement("button", {
                className: "dim-jh-btn",
                disabled: busy,
                onClick: () => {
                  setConfirmStep(false);
                  setNotice(null);
                }
              }, "返回"),
              React.createElement("button", {
                className: "dim-jh-btn",
                "data-kind": "primary",
                disabled: busy,
                onClick: () => void confirmImport()
              }, busy ? "导入中…" : "确认导入")
            ) : React.createElement("button", {
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
  return React.createElement(
    React.Fragment,
    null,
    React.createElement("button", {
      className: "dim-jh-btn",
      title: "导出全部账号的密钥与凭据，便于更换 DSH 版本后导入恢复。",
      onClick: () => {
        setDialog("export");
        setNotice(null);
      }
    }, "备份"),
    React.createElement("button", {
      className: "dim-jh-btn",
      title: "从备份文件恢复账号与凭据（会覆盖当前全部账号）。",
      onClick: () => fileRef.current?.click()
    }, "恢复"),
    React.createElement("input", {
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
function JetHubPage({ close, rpcCall }) {
  const [selected, setSelected] = React.useState(PROVIDERS[0].id);
  const [version, setVersion] = React.useState(0);
  const [checkinBusy, setCheckinBusy] = React.useState(false);
  const [checkinNotice, setCheckinNotice] = React.useState(null);
  const mounted = React.useRef(true);
  React.useEffect(() => () => {
    mounted.current = false;
  }, []);
  const selectProvider = (id) => {
    setSelected(id);
    setVersion((v) => v + 1);
  };
  const checkinAll = async () => {
    setCheckinBusy(true);
    setCheckinNotice(null);
    const parts = [];
    const notes = [];
    let totalCredit = 0;
    let failed = 0;
    for (const provider of checkinProviders()) {
      const label = PROVIDERS.find((p) => p.id === provider)?.label || provider;
      try {
        const res = await rpcCall("credits.claimAll", { provider });
        const s = res?.summary || {};
        const bits = [];
        if (s.claimed > 0) {
          totalCredit += s.totalCredit;
          bits.push(`+${s.totalCredit}`);
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
    setCheckinNotice({
      // 有待用户处理的提示时用 warn 色调，让那条提示更显眼
      tone: failed > 0 || notes.length > 0 ? "warn" : "ok",
      text: parts.length > 0 ? `一键签到：${parts.join("，")}${totalCredit > 0 ? `（共 +${totalCredit} 积分）` : ""}` : "一键签到：没有可领取的渠道",
      notes
    });
    setCheckinBusy(false);
    setVersion((v) => v + 1);
  };
  return React.createElement(
    "section",
    { className: "dim-jh-page", "aria-label": "Jet Hub Provider 设置" },
    React.createElement(
      "header",
      { className: "dim-jh-header" },
      React.createElement(
        "div",
        { className: "dim-jh-brand" },
        React.createElement("strong", { className: "dim-jh-brandName" }, "Jet Hub"),
        React.createElement("p", { className: "dim-jh-brandDesc" }, "Provider 凭据管理与多账号支持")
      ),
      React.createElement(
        "div",
        { className: "dim-jh-headerActions" },
        // 一键签到在备份/恢复**左侧**（需求指定位置）
        React.createElement("button", {
          className: "dim-jh-btn",
          title: "依次签到全部支持签到的渠道（CodeBuddy / LobsterAI / CodeArts / Qoder / TRAE）。串行执行以避免触发风控。",
          disabled: checkinBusy,
          onClick: () => void checkinAll()
        }, checkinBusy ? "签到中…" : "一键签到"),
        React.createElement(BackupPanel, {
          rpcCall,
          // 导入成功会整体替换账号，ProviderPanel 只在挂载时拉列表；
          // 递增版号强制重新挂载，让账号列表与模型目录立即反映新状态。
          onImported: () => setVersion((v) => v + 1)
        }),
        close ? React.createElement("button", {
          className: "dim-jh-btn",
          onClick: close
        }, "关闭") : null
      )
    ),
    // 签到结果放在页头下方横跨整宽：页头是 flex 且不换行，塞进去会挤压按钮。
    // `flex: none` 是必需的 —— `dim-jh-page` 是 column flex 且 `dim-jh-layout`
    // 带 `flex: 1`，不锁住的话提示条会被压扁（与 modal 内同款做法）。
    checkinNotice ? React.createElement(
      "div",
      {
        className: "dim-jh-probeNotice",
        "data-tone": checkinNotice.tone,
        role: checkinNotice.tone === "error" ? "alert" : "status",
        style: { flex: "none", margin: "12px 24px 0" }
      },
      React.createElement("div", null, checkinNotice.text),
      // 需要用户操作的提示单列成列表（如「请先用 Qoder 官方客户端登录一次」）。
      // 复用既有的 `dim-jh-probeDetails` 样式，不引入新样式。
      (checkinNotice.notes || []).length > 0 ? React.createElement(
        "ul",
        { className: "dim-jh-probeDetails" },
        checkinNotice.notes.map((note, index) => React.createElement("li", { key: index }, note))
      ) : null
    ) : null,
    React.createElement(
      "div",
      { className: "dim-jh-layout" },
      React.createElement(
        "nav",
        { className: "dim-jh-rail", role: "tablist", "aria-label": "Provider 导航" },
        PROVIDERS.map((p) => React.createElement(
          "button",
          {
            key: p.id,
            type: "button",
            role: "tab",
            className: "dim-jh-provider",
            "aria-selected": p.id === selected,
            onClick: () => selectProvider(p.id)
          },
          React.createElement(ProviderLogo, { provider: p.id }),
          React.createElement(
            "span",
            null,
            React.createElement("strong", null, p.label)
          )
        ))
      ),
      React.createElement(
        "main",
        {
          className: "dim-jh-panel",
          role: "tabpanel"
        },
        PROVIDERS.map((p) => p.id === selected ? React.createElement(ProviderPanel, {
          key: p.id + "-" + version,
          provider: p.id,
          rpcCall
        }) : null)
      )
    )
  );
}

// plugin-src/client/index.js
var name = "jet-hub-client";
var inject = ["slots", "connection"];
function apply(ctx) {
  ctx.effect(() => installJetHubStyles(), "jet-hub: install styles");
  const rpcCall = async (endpoint, payload, signal) => {
    const raw = await callManagementRpc(ctx.connection, JET_HUB_RPC_CHANNEL, endpoint, payload, signal);
    return unwrapRpcResult(raw);
  };
  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: "jet-hub",
    order: 50,
    label: () => "Jet Hub",
    inject: () => ({ rpcCall })
  }, JetHubPage));
}

    return module.exports;
  }
});
