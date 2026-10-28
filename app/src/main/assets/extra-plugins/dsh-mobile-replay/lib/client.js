// dsh-mobile-replay 浏览器半端：把两个上游插件的本地移动端重放注入页面。
//
// 为什么是外置插件而不是改包：两个上游包要保持**未改动的原版**
// （A = @dsh-external/dsh-wish-specializer 0.9.0-stable，B = dsh-providers-hub 2.8.261028），
// 而本地重放只有两类东西，全都与包内实现无关：
//   1. document 级 <style> 里的窄屏 CSS（A 的 ⑧⑨ 段 + B 的 173 行 560px 块）——
//      两个插件都没有 Shadow DOM，类名/属性选择器都是全局的，外部样式表等价生效；
//   2. 给 A 的「优化选项」标题 span 补一个 data-po06="options-label" 标记
//      （上游 client.js:4513 那个 span 上游自己没有标记，窄屏 CSS 要按它收按钮）。
//
// 顺序很关键：A/B 自己的样式表也在 <head> 里，同优先级规则靠「后者胜」，
// 所以 ensureStyle() 每次都把本插件的 <style> 挪到 head 末尾（appendChild 会移动节点）。
//
// 手写惰性 CJS（同 @liustack/modsearch 的零依赖样板）：不 import 任何 dsh client 包。
window.__ModuleLoader__.load({
  id: 'dsh-mobile-replay',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var STYLE_ID = 'dsh-mobile-replay/styles';

    var A_CSS = "/* ─────────────────────────────────────────────────────────────────────────\n * A 段：dsh-prompt-optimizer-mobile（上游 @dsh-external/dsh-wish-specializer）\n * 的移动端重放。来源 = 本地分支 lib/client.js 的 ⑧⑨ 两段注入样式（逐条照抄），\n * 外加「内联样式等价覆盖」——fork 把若干值直接写进 S.* 内联样式对象，内联\n * 优先级高于普通规则，故这里用 !important 复现同样结果。\n *\n * 结构前提（上游 0.9.0-stable 原样）：\n *   [data-po06=\"bar\"][data-po06-busy] > [data-po06=\"bar-row-1\"] > button[data-po06=\"options-btn\"]\n *        > svg + span(标题「优化选项」) + span[data-po06=\"options-summary\"] + span(▾)\n *   [data-po06=\"intercept\"] 是【拦截浮层】（width/minWidth 内联）\n * 标题 span 上游没有标记，由 client.js 的 markLabels() 补 data-po06=\"options-label\"。\n * ───────────────────────────────────────────────────────────────────────── */\n/* ⑧ 拦截浮层：上游按桌面尺度内联写死宽高（宽 460 / minWidth 360），真机视口仅 361 CSS px\n *    ⇒ 不覆盖就右侧被裁。宽高在内联上，必须 !important。 */\n@media (max-width:768px){[data-po06=\"intercept\"]{width:calc(100vw - 20px) !important;min-width:0 !important;max-width:520px !important}}\n@media (max-width:560px){[data-po06=\"intercept\"]{width:calc(100vw - 16px) !important;min-width:0 !important;max-height:min(78vh,640px) !important}}\n@media (max-width:420px){[data-po06=\"intercept\"]{width:calc(100vw - 12px) !important;border-radius:10px}}\n/* 触控目标：浮层按钮原 28px 高，窄屏抬到 38px */\n@media (max-width:560px){[data-po06] button{min-height:38px}}\n\n/* ⑨ 控件栏窄屏修复：宿主 conversation.input.left 是横向挤占的 flex 行，CJK 可在任意\n *   字符间断行 ⇒ 「优化选项」曾被逐字竖排并与相邻控件重叠。 */\n/* ① 控件栏整体不许横向溢出，按钮一律不被压缩（显式 box-sizing 与 client.js 的内联等价覆盖配套） */\n[data-po06=\"bar\"]{max-width:100%;box-sizing:border-box;min-width:0}\n[data-po06=\"bar\"] button{flex:0 0 auto;white-space:nowrap}\n/* ② 窄屏收成图标按钮：标题与摘要一起收起（渐进隐藏，弹层里档位/权限/模型一应俱全） */\n@media (max-width:560px){[data-po06=\"options-label\"],[data-po06=\"options-summary\"]{display:none}}\n@media (max-width:560px){[data-po06=\"options-btn\"]{padding:0 8px;gap:4px}}\n/* ③ 触控目标：控件栏按钮窄屏抬高（34px → 40px，后一条覆盖前一条，与 fork 同序） */\n@media (max-width:560px){[data-po06=\"bar\"] button{min-height:34px;padding-left:10px;padding-right:10px}}\n/* ④ 窄屏下控件栏自身纵向堆叠、留出间距 */\n@media (max-width:560px){[data-po06=\"bar-row-1\"]{row-gap:6px;max-width:100%}}\n/* ⑤ 真机量得控件栏按钮仅 34px 高（低于 40px 常用下限），窄屏抬到 40px */\n@media (max-width:560px){[data-po06=\"bar\"] button{min-height:40px;padding-left:12px;padding-right:12px}}\n/* ⑥ 弹出层避开系统栏：全面屏手势条 / 刘海会盖住贴边浮层 */\n@supports (padding:max(0px)){[data-po06=\"options-pop\"],[data-po06=\"help-pop\"]{padding-bottom:max(10px,env(safe-area-inset-bottom));padding-left:max(12px,env(safe-area-inset-left));padding-right:max(12px,env(safe-area-inset-right))}}\n/* 全面屏安全区：★ 显式 border-box，否则内联 calc(100vw - Npx) 再加 padding 会溢出 */\n@supports (padding:max(0px)){[data-po06=\"intercept\"]{box-sizing:border-box;padding-left:env(safe-area-inset-left);padding-right:env(safe-area-inset-right);padding-bottom:env(safe-area-inset-bottom)}}\n/* 拖动面板时禁止页面滚动/缩放干扰（仅拖拽头） */\n[data-po06=\"intercept-head\"]{touch-action:none}\n\n/* ── 内联样式等价覆盖（fork 在 S.* 里改的**活值**；inline 需要 !important）─────────\n * 依据：Object.assign(S, {...})（上游 client.js:758-931）二次覆盖了 optBtn / bar，\n * 所以 fork 对这两个键的改动其实是死代码 ⇒ 这里**不复现**；而 optBtnText /\n * optSummary / optPop / barRow 未被二次覆盖 ⇒ 必须复现，否则行为会退回上游。\n *   optBtnText  : +whiteSpace:'nowrap'\n *   optSummary  : +overflow:'hidden' +textOverflow:'ellipsis' +minWidth:0 +flex:'0 1 auto'\n *   optPop      : +boxSizing:'border-box'  width 320px → min(340px, calc(100vw - 24px))\n *   barRow      : +minWidth:0 +maxWidth:'100%'\n * ───────────────────────────────────────────────────────────────────────── */\n[data-po06=\"options-pop\"]{box-sizing:border-box !important;width:min(340px,calc(100vw - 24px)) !important;max-height:min(64vh,480px) !important}\n[data-po06=\"options-summary\"]{overflow:hidden !important;text-overflow:ellipsis !important;min-width:0 !important;flex:0 1 auto !important}\n[data-po06=\"options-label\"]{white-space:nowrap !important}\n[data-po06=\"bar-row-1\"]{min-width:0 !important;max-width:100% !important}\n@media (max-width:560px){[data-po06=\"options-btn\"] > span:nth-of-type(1){white-space:nowrap}}\n";

    var B_CSS = "\n/* ══════════════════════════════════════════════════════════════════════\n   dsh-launcher 移动端适配（新增层，本文件唯一一段本地样式扩展）\n   ──────────────────────────────────────────────────────────────────────\n   背景：本插件的配置界面在 Android WebView 窄屏（360 CSS px）下按桌面尺度\n   排布会出问题。适配层用真机 DOM 度量逐轮驱动，非静态推断。\n\n   实测环境：Sharp 803SH / Android 11 / 1080x2280 / density 480 => DPR 3\n            => CSS 视口 360 x 686～760（验收要求的 360-420 区间下限，最严苛）\n\n   桌面原状与窄屏故障：\n     1) .dim-jh-layout 是 flex 两栏 + .dim-jh-rail 固定 228px，360px 下右侧\n        只剩约 130px，内容被挤到溢出。\n     2) .dim-jh-accountActions 是 flex-wrap: nowrap，行内 5 个按钮必然横向溢出。\n     3) .dim-jh-btn 高约 26px、.dim-jh-iconBtn 宽 26px，低于触控可用下限。\n     4) .dim-jh-header / .dim-jh-panel 的 padding 按桌面给（24px），窄屏浪费。\n     5) 无任何安全区处理，刘海与底部手势条会盖住页头/底部操作。\n\n   真机度量驱动发现的两个隐藏坑（仅看代码看不出来）：\n     A) flex 子项默认 min-width: auto —— .dim-jh-rail 虽是 overflow-x: auto 的\n        横向条，却不肯收缩，把 .dim-jh-layout 与 .dim-jh-page 整体撑宽\n        （实测 page scrollWidth=393 vs clientWidth=320，溢出 73px）。\n        同理 .dim-jh-brand（flex 列 + brandDesc 的 nowrap）撑破 .dim-jh-header。\n        ⇒ 必须给这些 flex 子项显式 min-width: 0。\n     B) 只给 .dim-jh-page 加 padding 时计算值仍为 0px（被既有布局吃掉），\n        ⇒ 用选择器双写 .dim-jh-page.dim-jh-page 提升特异性。\n\n   ⚠️ 本文件整体是一个 JS 模板字符串 —— 本段注释里**不能出现反引号**，\n      否则会提前终止字符串（源码上方已记过这次构建失败的成因）。\n   ⚠️ 本段整体放在样式表**末尾**：靠后的规则在同等特异性下覆盖前面的写法。\n   ══════════════════════════════════════════════════════════════════════ */\n\n\n/* ② 中等窄屏（<=720）：收紧桌面尺度的留白，并抬触控目标到 40px */\n@media (max-width: 720px) {\n  .dim-jh-header { padding-top: 12px; padding-bottom: 12px; gap: 8px; }\n  .dim-jh-panel { padding: 14px; }\n  .dim-jh-brandName { font-size: 16px; }\n  .dim-jh-brandDesc { font-size: 12px; }\n  .dim-jh-btn { min-height: 40px; padding-top: 8px; padding-bottom: 8px; }\n  .dim-jh-iconBtn { min-width: 40px; min-height: 40px; }\n}\n\n/* ③ 手机竖屏（<=560）：两栏改上下堆叠 —— 本适配的核心一条 */\n@media (max-width: 560px) {\n  .dim-jh-page { max-width: 100%; width: 100%; overflow-x: hidden; }\n  .dim-jh-layout { flex-direction: column; overflow: visible; min-width: 0; max-width: 100%; width: 100%; }\n\n  /* 左侧导航成横向可滚 tab 条：固定高度、横向可滑、不换行 */\n  .dim-jh-rail {\n    width: 100%;\n    max-width: 100%;\n    min-width: 0;\n    box-sizing: border-box;\n    flex: none;\n    display: flex;\n    flex-direction: row;\n    flex-wrap: nowrap;\n    align-items: stretch;\n    gap: 6px;\n    padding: 6px 8px;\n    overflow-x: auto;\n    overflow-y: hidden;\n    border-right: 0;\n    border-bottom: 1px solid var(--dsw-alias-border-default, #e5e5e5);\n    -webkit-overflow-scrolling: touch;\n    scrollbar-width: none;\n  }\n  .dim-jh-rail::-webkit-scrollbar { width: 0; height: 0; display: none; }\n\n  /* ══ 供应商导航：横向可滑条带（三层结构都要改，缺一层就退化成竖列）══\n     结构：.dim-jh-rail > .dim-jh-railGroup > .dim-jh-providerRow > button.dim-jh-provider\n     上游三层全是 grid（各自单列）⇒ 只把 rail 改成 flex row 是不够的，\n     railGroup 与 providerRow 仍是 grid 单列 ⇒ 实际渲染成竖排（上一版就是这么翻的车）。\n     ⚠️ 每一层都必须显式参与横向 flex，且**不许被压缩**（flex: 0 0 auto），\n        否则 flex 会按默认 flex-shrink:1 把它们压扁 ⇒ 按钮互相压盖。 */\n  .dim-jh-railGroup {\n    display: flex;\n    flex-direction: row;\n    flex-wrap: nowrap;\n    gap: 6px;\n    flex: 0 0 auto;\n    min-width: 0;\n  }\n  .dim-jh-railGroup + .dim-jh-railGroup { margin-top: 0; }\n  /* 分组小标题是纵向列表的分隔，横向条带里没有位置 */\n  .dim-jh-railGroupTitle { display: none; }\n\n  .dim-jh-rail .dim-jh-providerRow {\n    display: block;\n    flex: 0 0 auto;\n    /* 宽度**由内容决定**：不设 max-width，标签完整显示不截断（用户要求「内容完整」）。\n       min-width 只是下限，保证短标签的按钮也够大、点得中。\n       最长的标签是「WorkBuddy (国际版)」这类，实测需要约 180px 才能完整放下。 */\n    min-width: 124px;\n  }\n  .dim-jh-rail .dim-jh-provider {\n    width: 100%;\n    min-width: 0;\n    min-height: 44px;\n    grid-template-columns: 24px minmax(0, 1fr);\n    gap: 6px;\n    padding: 6px 10px;\n    white-space: nowrap;\n    box-sizing: border-box;\n  }\n  .dim-jh-providerIcon { width: 24px; height: 24px; }\n  /* 标签不截断：给足宽度后让它自然显示，不加省略号（用户要求「内容完整」） */\n  .dim-jh-providerLabel { min-width: 0; }\n  .dim-jh-providerLabel strong { overflow: visible; text-overflow: clip; white-space: nowrap; }\n\n  /* 面板占满整宽，杜绝溢出 */\n  .dim-jh-panel {\n    min-width: 0;\n    width: 100%;\n    max-width: 100%;\n    box-sizing: border-box;\n    padding: 12px;\n    overflow-x: hidden;\n  }\n\n  /* 页头：brand 允许收缩（否则 nowrap 的副标题撑破容器），按钮组可换行 */\n  .dim-jh-header {\n    min-width: 0;\n    max-width: 100%;\n    box-sizing: border-box;\n    flex-wrap: wrap;\n    padding-top: 10px;\n    padding-bottom: 10px;\n  }\n  .dim-jh-brand { min-width: 0; flex: 1 1 auto; overflow: hidden; }\n  .dim-jh-brandName { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n  .dim-jh-brandDesc { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }\n  .dim-jh-headerActions {\n    /* 用户要求：这几个按键做成一条横向可滑的栏，而不是折行平铺。\n       关键在 flex-basis 100% —— 父级 .dim-jh-header 是 flex-wrap: wrap，\n       若这里用 flex:1 1 auto，它会与 brand 争同一行、并可能分到\n       「刚好装下全部按钮」的宽度，于是 overflow-x 永不触发、也滑不动。\n       占满整行后才是真正的满宽条带：行内按钮 nowrap 且不收缩，\n       超出部分交给 overflow-x: auto，手指左右滑即可触达全部按钮。\n       （真机探针实测：w=272 scrollW=391 clientW=272 scrollable=true） */\n    flex: 1 1 100%;\n    min-width: 0;\n    max-width: 100%;\n    box-sizing: border-box;\n    flex-wrap: nowrap;\n    justify-content: flex-start;\n    gap: 8px;\n    overflow-x: auto;\n    overflow-y: hidden;\n    -webkit-overflow-scrolling: touch;\n    scrollbar-width: none;\n    padding-bottom: 2px;\n  }\n  .dim-jh-headerActions::-webkit-scrollbar { width: 0; height: 0; display: none; }\n  /* 按钮本身不收缩、不折行：宽度由内容决定，靠横滑触达 */\n  .dim-jh-headerActions > .dim-jh-btn { flex: 0 0 auto; white-space: nowrap; }\n\n  /* 账号卡：操作按钮换行并均分，杜绝横向溢出（原为 flex-wrap: nowrap） */\n  .dim-jh-accountCard { min-width: 0; max-width: 100%; box-sizing: border-box; padding: 12px; }\n  .dim-jh-accountActions { flex-wrap: wrap; justify-content: stretch; gap: 8px; }\n  .dim-jh-accountActions > .dim-jh-btn { flex: 1 1 auto; min-width: 88px; justify-content: center; text-align: center; }\n  .dim-jh-metaRow { grid-template-columns: 46px minmax(0, 1fr); }\n  .dim-jh-accountName { font-size: 13px; }\n\n  /* 弹层/模态：不超出视口 */\n  .dim-jh-modal { max-width: calc(100vw - 16px); max-height: calc(100vh - 16px); box-sizing: border-box; }\n  .dim-jh-panelHead { margin-bottom: 12px; }\n\n  /* 横排内容兜底：长串（额度/限流说明）不撑破容器 */\n  .dim-jh-creditPackages, .dim-jh-rateLimits { overflow-wrap: anywhere; }\n\n}\n";

    var CSS = '/* ── A：dsh-prompt-optimizer-mobile（上游 dsh-wish-specializer）本地重放 ── */\n'
      + A_CSS
      + '\n\n/* ── B：dsh-codearts-auth（上游 dsh-providers-hub）173 行 560px 窄屏块 ── */\n'
      + B_CSS;

    var installed = false;
    var markQueued = false;
    /** 样式表在场且在 head 末尾（挪到末尾 = 压过 A/B 自己那两张表的同优先级规则）。 */
    function ensureStyle() {
      try {
        var head = document.head || document.documentElement;
        if (!head) return;
        var tag = document.getElementById(STYLE_ID);
        if (!tag) {
          tag = document.createElement('style');
          tag.id = STYLE_ID;
        }
        if (tag.textContent !== CSS) tag.textContent = CSS;
        if (head.lastElementChild !== tag) head.appendChild(tag);
      } catch (e) {
        /* 取不到 DOM 不影响宿主功能：最坏只是窄屏样式缺失 */
      }
    }

    /**
     * 给「优化选项」按钮的标题 span 补 data-po06="options-label"。
     * 结构（上游 client.js:4501-4516）：button > svg + span(标题) + span[options-summary] + span(▾)
     * ⇒ 第一个**没有** data-po06 的 span 就是标题（图标是 svg，摘要已有标记）。
     * React 重渲染会新建节点、丢掉本属性，故用 body 级 MutationObserver 反复补。
     */
    function markLabels(root) {
      try {
        var scope = root || document;
        if (!scope.querySelectorAll) return;
        var btns = scope.querySelectorAll('[data-po06="options-btn"]');
        for (var i = 0; i < btns.length; i++) {
          var kids = btns[i].children;
          for (var j = 0; j < kids.length; j++) {
            var el = kids[j];
            if (el.tagName !== 'SPAN') continue;
            if (el.getAttribute('data-po06')) continue;
            el.setAttribute('data-po06', 'options-label');
            break;
          }
        }
      } catch (e) { /* 同上：纯视觉增强，失败不影响功能 */ }
    }

    function queueMark() {
      if (markQueued) return;
      markQueued = true;
      setTimeout(function () { markQueued = false; markLabels(); }, 16);
    }

    function install() {
      if (installed) return;
      installed = true;
      ensureStyle();
      markLabels();

      try {
        // A/B 的样式表若被自愈逻辑重建（A 的 ensureUiCss 会重建），把我们的表挪回末尾
        if (typeof MutationObserver === 'function') {
          new MutationObserver(function () { ensureStyle(); })
            .observe(document.head || document.documentElement, { childList: true });
          var root = document.body || document.documentElement;
          if (root) {
            new MutationObserver(queueMark).observe(root, { childList: true, subtree: true });
          }
        }
      } catch (e) { /* MutationObserver 不可用就只靠下面两次兜底 */ }

      // 迟到加载的兜底：客户端 bundle 半端可能在 boot 之后才注入自己的 <style>
      setTimeout(function () { ensureStyle(); markLabels(); }, 1000);
      setTimeout(function () { ensureStyle(); markLabels(); }, 4000);
    }

    function apply() {
      if (typeof document === 'undefined') return;
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', install, { once: true });
        return;
      }
      install();
    }

    exports.apply = apply;
    // 不需要任何 dsh client 包：本插件只碰 document
    exports.inject = [];
    return module.exports;
  },
});