/**
 * stub/patchers/host-runtime.mjs — **host 侧运行时**兼容修补（Node/服务端）。
 *
 * 覆盖六项：
 *   · llm-pi-ai sendAttribution 抑制（6 锚点全命中才写盘，避免半套补丁）
 *   · koffi ABI 布局断言禁用（boot 硬阻断：koffi 被 stub 后 struct().size 恒 0）
 *   · WebView/旧 Chrome 前端 API polyfill（无条件注入 + 逐条 if(!X) 守卫，SHIM_ID 幂等）
 *   · settings-models 的 CodeBuddy 共存 Provider 编辑布局
 *   · @vscode/ripgrep 解析器 Android 回退（优先 Termux 原生 rg）
 *   · dsh-fs-local chmod 对 FUSE 的 EACCES/EPERM 容错
 *
 * 这些都要求「锚点命中才动手」，锚点状态在各自块注释里标注了 0.1.7-rc.2 实测结果。
 */
import { writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { HOME, log, findPkg } from '../env.mjs';


/* apiproxy WEB_SETTINGS_NAMESPACES += vision 补丁已移除（v4.10 审计）：
 * 上游 0.1.x 已无该常量，补丁永远命中 "pattern not found, skip" 死分支；
 * dsh-vision 现通过 @deepseek-ai/dsh-settings 的 settingsNamespace('vision')
 * 直接注册设置命名空间，无需 api 网关白名单。 */

/* ---------------------------------------------------------------------------
 * llm-pi-ai sendAttribution 抑制缝隙（**已针对 0.1.7-rc.2 核实**）
 *
 * 为什么还需要这个补丁：dsh-provider-headers 内置插件的「发送归因请求头」
 * 开关把 `providers.<route>.sendAttribution = false` 写进 profile，期望不再注入
 * `deepseek-harness/…` User-Agent。但上游 @deepseek-ai/dsh-llm 的
 * attributionHeaders() 签名是 `(identity = APP_IDENTITY)`，注释明写
 * “omission cannot suppress attribution”；pi-ai 侧 requestHeaders() 又无条件把
 * 归因头**合并覆盖**在用户 headers 之上（按小写名去重，用户设了同名头也会被顶掉）。
 * → 该开关在 0.1.7-rc.2 上仍然无效，上游未提供抑制缝隙，只能就地插桩。
 *
 * 0.1.7-rc.2 锚点实测（dsh-llm-pi-ai/lib/index.js，113953 字节）：
 *   · `headers: z.dict(z.string()),`                  → 命中 1 处（profile schema，行 1024）
 *   · `function requestHeaders(headers) {`            → 命中 1 处（行 1733）
 *   · `headers: requestHeaders(profile.headers)`      → 命中 1 处（流式请求，行 1883）
 *   · 归因头注入**共 2 处**：上述流式请求，以及模型探测 discoverModels() 的
 *     `for (const [name, value] of Object.entries(attributionHeaders())) headers.set(...)`
 *     （行 2308）。**旧版补丁只覆盖了前者**，探测请求仍带归因头 —— 本次补齐。
 *   · 旧锚点 `sendAttribution: z.boolean().optional(),` → **0 处**：0.1.5 起就不存在，
 *     属历史死分支（每轮都白跑一次 replace），本次删除。
 *   · 结论：上游**未**原生支持抑制，补丁保留（不是「为了适配而硬打」）。
 *
 * 做法（6 个锚点，全部命中才写盘；缺任一即显式 WARN 并放弃，避免半套补丁）：
 *   1) profile schema 声明 sendAttribution（default true，与「未设置即发送」同义）；
 *   2) requestHeaders 增加第二参数，false 时直接返回用户 headers，不合并归因头；
 *   3) 流式请求调用点传入 profile.sendAttribution；
 *   4) 探测链路分流：storedDiscoveryProfile() 透出 sendAttribution，
 *      discoverModels() 据其决定是否注入归因头。
 *
 * 幂等 marker 写在文件头（`// dsh-launcher-android-pi-ai-send-attribution`），
 * 与 fs-local / plugin-compat 的 marker 写法一致。
 * ------------------------------------------------------------------------- */
try {
  const MARKER_PI = 'dsh-launcher-android-pi-ai-send-attribution';
  const pi = findPkg('@deepseek-ai/dsh-llm-pi-ai', 'lib/index.js');
  if (!pi) {
    log('llm-pi-ai: not found, skip sendAttribution patch');
  } else {
    let src = readFileSync(pi, 'utf8');
    if (src.includes(MARKER_PI)) {
      log('llm-pi-ai sendAttribution already patched');
    } else {
      let out = src;
      let hits = 0;
      /* 逐锚点替换：每个锚点单独报命中/未命中，避免「整体 replace 后 out===src」
         这种只说「pattern not found」却不知是哪一条漂移的含糊日志。 */
      const apply = (label, re, to) => {
        const before = out;
        out = out.replace(re, to);
        if (out !== before) { hits++; return true; }
        log('WARN llm-pi-ai sendAttribution: anchor MISS — ' + label);
        return false;
      };
      // 1) profile schema 声明字段
      apply('profile schema (headers: z.dict)',
        /headers: z\.dict\(z\.string\(\)\),/,
        'headers: z.dict(z.string()),\n\tsendAttribution: z.boolean().default(true),');
      // 2) requestHeaders 签名 + 函数体分流
      apply('requestHeaders signature',
        /function requestHeaders\(headers\) \{/,
        'function requestHeaders(headers, sendAttribution = true) {');
      apply('requestHeaders body guard',
        /function requestHeaders\(headers, sendAttribution = true\) \{\n(\s*)const attribution = attributionHeaders\(\);/,
        (m, indent) => m.replace(
          'const attribution = attributionHeaders();',
          `if (sendAttribution === false) return { ...(headers ?? {}) };\n${indent}const attribution = attributionHeaders();`
        ));
      // 3) 流式请求调用点
      apply('stream requestHeaders call',
        /headers: requestHeaders\(profile\.headers\)/,
        'headers: requestHeaders(profile.headers, profile.sendAttribution)');
      // 4) 模型探测链路（0.1.7 新增覆盖）
      apply('discovery attribution injection',
        /for \(const \[name, value\] of Object\.entries\(attributionHeaders\(\)\)\) headers\.set\(name, value\);/,
        'if (stored?.sendAttribution !== false) for (const [name, value] of Object.entries(attributionHeaders())) headers.set(name, value);');
      apply('discovery profile passthrough',
        /return \{\n\t\t\theaders: profile\.headers,\n\t\t\tresolveApiKey: \(\) => resolveApiKey\(provider, profile\)\n\t\t\};/,
        'return {\n\t\t\theaders: profile.headers,\n\t\t\tsendAttribution: profile.sendAttribution,\n\t\t\tresolveApiKey: () => resolveApiKey(provider, profile)\n\t\t};');

      const EXPECTED = 6;
      if (hits < EXPECTED) {
        log('WARN llm-pi-ai sendAttribution: only ' + hits + '/' + EXPECTED +
            ' anchors hit — file NOT modified (上游结构又漂移了，需重新对表)');
      } else {
        // 写盘前语法自检（与 attachment-local / plugin-compat 同手法）
        const tmp = pi + '.pi-check.mjs';
        let ok = false;
        try {
          writeFileSync(tmp, out);
          const r = spawnSync(process.execPath, ['--check', tmp], { timeout: 15000, encoding: 'utf8' });
          ok = r.status === 0;
          if (!ok) log('WARN llm-pi-ai sendAttribution syntax check FAILED: ' + (r.stderr || '').slice(0, 200));
        } catch (e) {
          log('WARN llm-pi-ai sendAttribution syntax check unavailable: ' + e.message);
        } finally {
          try { unlinkSync(tmp); } catch {}
        }
        if (ok) {
          writeFileSync(pi, '// ' + MARKER_PI + '\n' + out);
          log('llm-pi-ai sendAttribution patched: ' + hits + '/' + EXPECTED +
              ' anchors (schema + requestHeaders + stream call + discovery x2)');
        } else {
          log('WARN llm-pi-ai sendAttribution: syntax check failed, file NOT modified');
        }
      }
    }
  }
} catch (e) { log('WARN llm-pi-ai sendAttribution: ' + e.message); }

try {
  /* koffi ABI 断言禁用：koffi 已被 stub 顶替（见上文 koffi ESM/CJS stub），
     其 struct().size 恒为 0，而上游在 import 期就断言 STARTUPINFOW=104 /
     PROCESS_INFORMATION=24 → **抛错发生在模块加载期**，Cordis 会把整棵插件树
     判为 failed to apply，web 直接起不来（不是降级，是硬失败）。

     0.1.5 把断言从 dsh-sandbox-windows-acl **搬到了新包** dsh-win32-process，
     旧包只剩同名的无断言实现。只扫旧包会命中 0 处（日志 'asserts disabled: 0'
     看起来无害），实际 boot 必崩——故改为**按包名清单遍历**，新旧两包都扫，
     并对「包在但一处未命中」发出显式 WARN（避免再次静默漂移）。

     **已针对 0.1.7-rc.2 核实**（0.1.7 安装树实测）：
       · @deepseek-ai/dsh-win32-process/lib/index.js → 'layout mismatch' 命中 **2 处**
         （行 71 STARTUPINFOW / 行 72 PROCESS_INFORMATION，文本与下方正则一致）；
       · @deepseek-ai/dsh-sandbox-windows-acl → 命中 **0 处**（该包在 0.1.7 已无断言）。
     → 按包名清单遍历两包的实现**已兼容 0.1.7，保持不动**；日志会打
       'koffi ABI asserts disabled: 2 (pkgs: …)'，若归零则显式 WARN（boot 必崩）。 */
  const ABI_PKGS = ['@deepseek-ai/dsh-sandbox-windows-acl', '@deepseek-ai/dsh-win32-process'];
  const foundPkgs = [];
  let totalPatched = 0;
  let totalAlready = 0;  // 全部包合计「已禁用」的断言条数（幂等判据用）
  for (const name of ABI_PKGS) {
    const w = findPkg(name, 'lib') || findPkg(name, 'lib/index.js');
    if (!w) continue;
    const dir = existsSync(w) && w.endsWith('.js') ? dirname(w) : w;
    if (!existsSync(dir)) continue;
    foundPkgs.push(name);
    let patched = 0;       // 本次实际禁用的**断言条数**（非文件数：0.1.7 两处断言同在一个文件）
    let sawAssert = 0;     // 文件里出现 'layout mismatch' 的处数
    let alreadyDone = 0;   // 已被本补丁禁用过的断言条数（二次运行 / 重装后重跑）
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.js')) continue;
      const p = join(dir, f);
      const src = readFileSync(p, 'utf8');
      /* 已被本补丁处理过：断言文本已被替换成 marker 注释。
         必须单独计数，否则二次运行会看到 sawAssert=0 而误报「boot 必崩」。 */
      alreadyDone += (src.match(/dsh-launcher: koffi stubbed,/g) || []).length;
      if (!src.includes('layout mismatch')) continue;
      let out = src;
      out = out.replace(/if \(STARTUPINFOW\.size !== 104\) throw new Error\(`STARTUPINFOW layout mismatch[^;]*\);/, '/* dsh-launcher: koffi stubbed, STARTUPINFOW assert disabled */');
      out = out.replace(/if \(PROCESS_INFORMATION\.size !== 24\) throw new Error\(`PROCESS_INFORMATION layout mismatch[^;]*\);/, '/* dsh-launcher: koffi stubbed, PROCESS_INFORMATION assert disabled */');
      if (out !== src) {
        /* 断言条数 = 原文出现 'layout mismatch' 的次数（0.1.7 实测同一文件 2 处）。
           用 match 计数，避免把「文件数」误报成「断言数」。 */
        const n = (src.match(/layout mismatch/g) || []).length;
        sawAssert += n;
        patched += n;
        writeFileSync(p, out);
      } else {
        sawAssert += (src.match(/layout mismatch/g) || []).length;
      }
    }
    if (sawAssert > 0 && patched === 0) log(`WARN koffi-abi: ${name} has ${sawAssert} layout assertion(s) but none matched the disable patterns`);
    totalPatched += patched;
    totalAlready += alreadyDone;
  }
  if (foundPkgs.length === 0) {
    log('WARN koffi-abi: none of the ABI-assert packages found (koffi stub may leave boot broken)');
  } else if (totalAlready > 0) {
    /* 断言已在位（本次禁用 0 条是**正常**的幂等结果，不是漂移）。
       旧实现只判 totalPatched===0，导致二次运行恒打「boot may fail」假警报。 */
    log('koffi ABI asserts already disabled: ' + totalAlready + ' (pkgs: ' + foundPkgs.join(', ') + ')');
  } else {
    log('koffi ABI asserts disabled: ' + totalPatched + ' (pkgs: ' + foundPkgs.join(', ') + ')');
    /* 关键护栏：若扫到包、断言文本在、却一条都没禁用，说明文本又漂移了——
       此时 boot 必崩，大声报出来（这是 0.1.5 适配期真实踩到的静默失效点）。 */
    if (totalPatched === 0) log('WARN koffi-abi: no assertion disabled across ' + foundPkgs.join(', ') + ' — dsh boot may fail at plugin load');
  }
} catch (e) { log('WARN koffi-abi: ' + e.message); }

try {
  // WebView / 旧 Chrome 前端 API 补齐（**已针对 0.1.7-rc.2 核实**）。
  //
  // 真机实测（Android 11 / 系统 WebView 94）dsh 0.1.7 前端一启动即抛：
  //   Uncaught TypeError: Promise.withResolvers is not a function        （需 Chrome 119+）
  //   Uncaught (in promise) TypeError: AbortSignal.any is not a function（需 Chrome 116+）
  //   AbortSignal.timeout                                                （需 Chrome 103+）
  // → 页面停在引导骨架，UI 完全不可交互。
  //
  // v4.10 起曾把注入改成「按需」：只在 dist 内 app bundle 命中字面量时才写 index.html。
  // **该判据在 0.1.7 上失效**：消费者在**插件 client bundle**（/plugins/**/client.js）里，
  // 不在 app bundle —— 实测扫描 0 命中并跳过注入，页面照旧崩（真机 console 实拍）。
  // 故改回无条件注入，但整段由 `if(!X)` 守卫包裹：新版 WebView 上逐条 no-op，
  // 不覆盖原生实现，代价只有几行 HTML。
  //
  // 必须留在引导期脚本里：polyfill 要早于 /assets/index-*.js 与模块系统条目执行，
  // client 插件通道时序上做不到。
  const idx = findPkg('@deepseek-ai/dsh-web-frontend', 'dist/index.html');
  if (idx && existsSync(idx)) {
    let html = readFileSync(idx, 'utf8');
    // 幂等判据**带版本号**：payload 变更时只需递增 SHIM_ID，旧版会被就地替换。
    // 不能用「含不带版本号的 id」判断已注入——残留的旧版（更小的）shim 会让新版
    // 被永久跳过，真机上只能手改 index.html 绕过（绕过式补丁，已废弃）。
    const SHIM_ID = 'dsh-webview-compat-shim-v2';
    const SHIM_TAG_RE = /<script id="dsh-webview-compat-shim(?:-v\d+)?"[\s\S]*?<\/script>/;
    if (html.includes(SHIM_ID)) {
      log('index.html shim already present: ' + SHIM_ID);
    } else if (!html.includes('<head>')) {
      log('WARN index.html has no <head>, skip shim');
    } else {
      // payload 以 base64 内嵌：内含引号与尖括号，直接内联字符串极易转义出错
      // （与 koffi / node-pty / narb 的写法一致）；且必须分块——单行过长会被截断写坏。
      const SHIM_HTML_B64 =
        'PHNjcmlwdCBpZD0iZHNoLXdlYnZpZXctY29tcGF0LXNoaW0tdjIiPihmdW5jdGlvbigpewogIHZh' +
        'ciBnPXR5cGVvZiBnbG9iYWxUaGlzIT09J3VuZGVmaW5lZCc/Z2xvYmFsVGhpczp3aW5kb3c7CiAg' +
        'aWYoIVByb21pc2Uud2l0aFJlc29sdmVycyl7UHJvbWlzZS53aXRoUmVzb2x2ZXJzPWZ1bmN0aW9u' +
        'KCl7dmFyIHJlcyxyZWo7dmFyIHA9bmV3IFByb21pc2UoZnVuY3Rpb24oYSxiKXtyZXM9YTtyZWo9' +
        'Yjt9KTtyZXR1cm57cHJvbWlzZTpwLHJlc29sdmU6cmVzLHJlamVjdDpyZWp9O307fQogIGlmKCFB' +
        'Ym9ydFNpZ25hbC50aW1lb3V0KXtBYm9ydFNpZ25hbC50aW1lb3V0PWZ1bmN0aW9uKG1zKXt2YXIg' +
        'Yz1uZXcgQWJvcnRDb250cm9sbGVyKCk7c2V0VGltZW91dChmdW5jdGlvbigpe2MuYWJvcnQobmV3' +
        'IERPTUV4Y2VwdGlvbignVGltZW91dEVycm9yJywnVGltZW91dEVycm9yJykpO30sbXMpO3JldHVy' +
        'biBjLnNpZ25hbDt9O30KICBpZighQWJvcnRTaWduYWwuYW55KXtBYm9ydFNpZ25hbC5hbnk9ZnVu' +
        'Y3Rpb24oc2lncyl7dmFyIGM9bmV3IEFib3J0Q29udHJvbGxlcigpO2Zvcih2YXIgaT0wO2k8c2ln' +
        'cy5sZW5ndGg7aSsrKXt2YXIgcz1zaWdzW2ldO2lmKHMuYWJvcnRlZCl7Yy5hYm9ydChzLnJlYXNv' +
        'bik7YnJlYWs7fShmdW5jdGlvbihzaWcpe3NpZy5hZGRFdmVudExpc3RlbmVyKCdhYm9ydCcsZnVu' +
        'Y3Rpb24oKXtpZighYy5zaWduYWwuYWJvcnRlZCljLmFib3J0KHNpZy5yZWFzb24pO30se29uY2U6' +
        'dHJ1ZX0pO30pKHMpO31yZXR1cm4gYy5zaWduYWw7fTt9CiAgaWYoIUFib3J0U2lnbmFsLnByb3Rv' +
        'dHlwZS50aHJvd0lmQWJvcnRlZCl7QWJvcnRTaWduYWwucHJvdG90eXBlLnRocm93SWZBYm9ydGVk' +
        'PWZ1bmN0aW9uKCl7aWYodGhpcy5hYm9ydGVkKXRocm93IHRoaXMucmVhc29uIT09dW5kZWZpbmVk' +
        'P3RoaXMucmVhc29uOm5ldyBET01FeGNlcHRpb24oJ1RoZSBvcGVyYXRpb24gd2FzIGFib3J0ZWQu' +
        'JywnQWJvcnRFcnJvcicpO307fQogIGlmKCFBcnJheS5wcm90b3R5cGUuYXQpe0FycmF5LnByb3Rv' +
        'dHlwZS5hdD1mdW5jdGlvbihuKXtuPU1hdGgudHJ1bmMobil8fDA7aWYobjwwKW4rPXRoaXMubGVu' +
        'Z3RoO3JldHVybiBuPDB8fG4+PXRoaXMubGVuZ3RoP3VuZGVmaW5lZDp0aGlzW25dO307fQogIGlm' +
        'KCFTdHJpbmcucHJvdG90eXBlLmF0KXtTdHJpbmcucHJvdG90eXBlLmF0PWZ1bmN0aW9uKG4pe249' +
        'TWF0aC50cnVuYyhuKXx8MDtpZihuPDApbis9dGhpcy5sZW5ndGg7cmV0dXJuIG48MHx8bj49dGhp' +
        'cy5sZW5ndGg/dW5kZWZpbmVkOnRoaXMuY2hhckF0KG4pO307fQogIGlmKCFBcnJheS5wcm90b3R5' +
        'cGUuZmluZExhc3Qpe0FycmF5LnByb3RvdHlwZS5maW5kTGFzdD1mdW5jdGlvbihmLHQpe2Zvcih2' +
        'YXIgaT10aGlzLmxlbmd0aC0xO2k+PTA7aS0tKXtpZihmLmNhbGwodCx0aGlzW2ldLGksdGhpcykp' +
        'cmV0dXJuIHRoaXNbaV07fXJldHVybiB1bmRlZmluZWQ7fTt9CiAgaWYoIUFycmF5LnByb3RvdHlw' +
        'ZS5maW5kTGFzdEluZGV4KXtBcnJheS5wcm90b3R5cGUuZmluZExhc3RJbmRleD1mdW5jdGlvbihm' +
        'LHQpe2Zvcih2YXIgaT10aGlzLmxlbmd0aC0xO2k+PTA7aS0tKXtpZihmLmNhbGwodCx0aGlzW2ld' +
        'LGksdGhpcykpcmV0dXJuIGk7fXJldHVybiAtMTt9O30KICBpZighT2JqZWN0Lmhhc093bil7T2Jq' +
        'ZWN0Lmhhc093bj1mdW5jdGlvbihvLGspe3JldHVybiBPYmplY3QucHJvdG90eXBlLmhhc093blBy' +
        'b3BlcnR5LmNhbGwobyxrKTt9O30KICBpZighQXJyYXkucHJvdG90eXBlLnRvU29ydGVkKXtBcnJh' +
        'eS5wcm90b3R5cGUudG9Tb3J0ZWQ9ZnVuY3Rpb24oYyl7cmV0dXJuIEFycmF5LnByb3RvdHlwZS5z' +
        'bGljZS5jYWxsKHRoaXMpLnNvcnQoYyk7fTt9CiAgaWYoIUFycmF5LnByb3RvdHlwZS50b1JldmVy' +
        'c2VkKXtBcnJheS5wcm90b3R5cGUudG9SZXZlcnNlZD1mdW5jdGlvbigpe3JldHVybiBBcnJheS5w' +
        'cm90b3R5cGUuc2xpY2UuY2FsbCh0aGlzKS5yZXZlcnNlKCk7fTt9CiAgaWYoIUFycmF5LnByb3Rv' +
        'dHlwZS53aXRoKXtBcnJheS5wcm90b3R5cGUud2l0aD1mdW5jdGlvbihpLHYpe3ZhciBhPUFycmF5' +
        'LnByb3RvdHlwZS5zbGljZS5jYWxsKHRoaXMpO2k9TWF0aC50cnVuYyhpKXx8MDtpZihpPDApaSs9' +
        'YS5sZW5ndGg7YVtpXT12O3JldHVybiBhO307fQogIGlmKHR5cGVvZiBnLnN0cnVjdHVyZWRDbG9u' +
        'ZT09PSd1bmRlZmluZWQnKXsKICAgIGcuc3RydWN0dXJlZENsb25lPWZ1bmN0aW9uKHYpewogICAg' +
        'ICBpZih2PT09bnVsbHx8dHlwZW9mIHYhPT0nb2JqZWN0JylyZXR1cm4gdjsKICAgICAgaWYodHlw' +
        'ZW9mIHY9PT0nZnVuY3Rpb24nfHx0eXBlb2Ygdj09PSdzeW1ib2wnKXRocm93IG5ldyBET01FeGNl' +
        'cHRpb24oJ2NvdWxkIG5vdCBiZSBjbG9uZWQnLCdEYXRhQ2xvbmVFcnJvcicpOwogICAgICBpZih2' +
        'IGluc3RhbmNlb2YgRGF0ZSlyZXR1cm4gbmV3IERhdGUodi5nZXRUaW1lKCkpOwogICAgICBpZih2' +
        'IGluc3RhbmNlb2YgUmVnRXhwKXJldHVybiBuZXcgUmVnRXhwKHYuc291cmNlLHYuZmxhZ3MpOwog' +
        'ICAgICBpZih2IGluc3RhbmNlb2YgTWFwKXt2YXIgbT1uZXcgTWFwKCk7di5mb3JFYWNoKGZ1bmN0' +
        'aW9uKHgsayl7bS5zZXQoZy5zdHJ1Y3R1cmVkQ2xvbmUoayksZy5zdHJ1Y3R1cmVkQ2xvbmUoeCkp' +
        'O30pO3JldHVybiBtO30KICAgICAgaWYodiBpbnN0YW5jZW9mIFNldCl7dmFyIHN0PW5ldyBTZXQo' +
        'KTt2LmZvckVhY2goZnVuY3Rpb24oeCl7c3QuYWRkKGcuc3RydWN0dXJlZENsb25lKHgpKTt9KTty' +
        'ZXR1cm4gc3Q7fQogICAgICBpZih2IGluc3RhbmNlb2YgQXJyYXlCdWZmZXIpcmV0dXJuIHYuc2xp' +
        'Y2UoMCk7CiAgICAgIGlmKEFycmF5QnVmZmVyLmlzVmlldyh2KSlyZXR1cm4gbmV3IHYuY29uc3Ry' +
        'dWN0b3IoZy5zdHJ1Y3R1cmVkQ2xvbmUodi5idWZmZXIpLHYuYnl0ZU9mZnNldCx2Lmxlbmd0aCk7' +
        'CiAgICAgIGlmKEFycmF5LmlzQXJyYXkodikpcmV0dXJuIHYubWFwKGcuc3RydWN0dXJlZENsb25l' +
        'KTsKICAgICAgdmFyIG91dD17fTtmb3IodmFyIGsgaW4gdil7aWYoT2JqZWN0LnByb3RvdHlwZS5o' +
        'YXNPd25Qcm9wZXJ0eS5jYWxsKHYsaykpb3V0W2tdPWcuc3RydWN0dXJlZENsb25lKHZba10pO31y' +
        'ZXR1cm4gb3V0OwogICAgfTsKICB9CiAgaWYoIU9iamVjdC5ncm91cEJ5KXtPYmplY3QuZ3JvdXBC' +
        'eT1mdW5jdGlvbihpdGVtcyxrZXkpe3ZhciBvPU9iamVjdC5jcmVhdGUobnVsbCk7dmFyIGk9MDtm' +
        'b3IodmFyIGl0IG9mIGl0ZW1zKXt2YXIgaz1rZXkoaXQsaSsrKTtpZighT2JqZWN0LnByb3RvdHlw' +
        'ZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKG8saykpb1trXT1bXTtvW2tdLnB1c2goaXQpO31yZXR1cm4g' +
        'bzt9O30KICBpZighTWFwLmdyb3VwQnkpe01hcC5ncm91cEJ5PWZ1bmN0aW9uKGl0ZW1zLGtleSl7' +
        'dmFyIG09bmV3IE1hcCgpO3ZhciBpPTA7Zm9yKHZhciBpdCBvZiBpdGVtcyl7dmFyIGs9a2V5KGl0' +
        'LGkrKyk7dmFyIGE9bS5nZXQoayk7aWYoYSlhLnB1c2goaXQpO2Vsc2UgbS5zZXQoayxbaXRdKTt9' +
        'cmV0dXJuIG07fTt9Cn0pKCk7PC9zY3JpcHQ+' ;
      const shim = Buffer.from(SHIM_HTML_B64, 'base64').toString('utf8');
      // 先摘掉任意旧版 shim 再注入，保证「升级 payload」不需要人工介入。
      html = html.replace(SHIM_TAG_RE, '').replace('<head>', '<head>' + shim);
      writeFileSync(idx, html);
      log('index.html WebView compat shim injected (withResolvers/any/timeout)');
    }
  } else {
    log('dsh-web-frontend dist not found, skip shim');
  }
} catch (e) { log('WARN index shim: ' + e.message); }

try {
  // CodeBuddy 共存 Provider 的编辑布局：settings-models 客户端按命名空间白名单
  // 选择 Provider 编辑器布局（layoutOf：llm-deepseek→deepseek、llm-pi-ai→pi-ai，
  // 其余→unknown）。unknown 布局只渲染“高级提示”且保存按钮永久禁用，卡片无法
  // 填写/保存。dsh-llm-codebuddy 内置插件以独立命名空间 llm-codebuddy 与内置
  // llm-pi-ai 共存（互不抢占 settings 注册），必须让客户端把它按 pi-ai 布局渲染。
  // 必须留在引导期脚本里：layoutOf 是编译产物内的闭包函数，client 插件通道改不到。
  //
  // 已针对 0.1.7-rc.2 核实：锚点 'if (ns === "llm-pi-ai") return "pi-ai";' 在
  // @deepseek-ai/dsh-client-ui-settings-models@0.1.7-rc.2/lib/client.js 中**命中 1 处**
  // → 保持不动。锚点缺失时打 'WARN settings-models layoutOf pattern not found'（可诊断）。
  //
  // 消费者说明（0.1.7 改造后）：本补丁服务的是 **dsh-llm-codebuddy**。该插件本次改造后
  // **不再内置**（代码保留在 assets/optional-plugins/dsh-llm-codebuddy，默认不装配），
  // 因此当前**无内置消费者**，仅服务于用户手动装配 codebuddy 的场景。补丁保留不删。
  const smClient = findPkg('@deepseek-ai/dsh-client-ui-settings-models', 'lib/client.js');
  if (smClient && existsSync(smClient)) {
    let smSrc = readFileSync(smClient, 'utf8');
    if (smSrc.includes('llm-codebuddy") return "pi-ai"')) {
      log('settings-models codebuddy layout already patched');
    } else if (smSrc.includes('if (ns === "llm-pi-ai") return "pi-ai";')) {
      smSrc = smSrc.replace(
        'if (ns === "llm-pi-ai") return "pi-ai";',
        'if (ns === "llm-pi-ai") return "pi-ai";\n\t\t\tif (ns === "llm-codebuddy") return "pi-ai";'
      );
      writeFileSync(smClient, smSrc);
      log('settings-models codebuddy layout patched (llm-codebuddy -> pi-ai)');
    } else {
      log('WARN settings-models layoutOf pattern not found, skip (dsh 升级后需核对)');
    }
  } else {
    log('settings-models client not found, skip codebuddy layout patch');
  }
} catch (e) { log('WARN codebuddy layout patch: ' + e.message); }

try {
  // 已针对 0.1.7-rc.2 核实：**与 dsh 版本无关，无锚点**。@vscode/ripgrep 的解析器
  // 是整体覆写（整文件重写，含 rgPath 导出），不依赖上游字面量；0.1.7 仍由
  // dsh-tool-fs-search 消费。fallback 缺失时打 'not found, skip'（可诊断）。
  // @vscode/ripgrep：Android 没有 @vscode/ripgrep-android-arm64 平台包，
  // 导致 dsh-tool-fs-search 的 glob/grep 报 “ripgrep launch failed”。
  // 这里把解析器改为优先使用 Termux `pkg install -y ripgrep` 安装的原生 rg，
  // 缺失时才回退到 linux-arm64 静态二进制（由 install-dsh.mjs 安装到 dsh-prefix/node_modules）。
  const rgMain = findPkg('@vscode/ripgrep', 'lib/index.js');
  if (!rgMain) {
    log('@vscode/ripgrep: not found, skip android fallback');
  } else {
    const termuxRg = existsSync(join(HOME, 'termux/usr/bin/rg')) ? join(HOME, 'termux/usr/bin/rg') : null;
    const fallbackRg = termuxRg || findPkg('@vscode/ripgrep-linux-arm64', 'bin/rg');
    if (!fallbackRg) {
      log('@vscode/ripgrep: linux-arm64 fallback not found, skip (install-dsh should install it)');
    } else {
      const src = readFileSync(rgMain, 'utf8');
      if (src.includes('dsh-launcher-android-ripgrep-v2')) {
        log('@vscode/ripgrep android fallback already patched');
      } else {
        const patched = `// dsh-launcher-android-ripgrep-v2
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);

const arch = process.env.npm_config_arch || process.arch;
const binaryName = process.platform === 'win32' ? 'rg.exe' : 'rg';
const platformPkg = \`@vscode/ripgrep-\${process.platform}-\${arch}\`;
const FALLBACK_RG = ${JSON.stringify(fallbackRg)};

let resolved;
try {
  resolved = require.resolve(\`\${platformPkg}/bin/\${binaryName}\`);
} catch {
  try {
    // Android 优先使用 Termux pkg 安装的原生 rg；缺失时再回退 linux-arm64 静态二进制。
    if (existsSync(FALLBACK_RG)) {
      resolved = FALLBACK_RG;
    } else {
      const fallbackPkg = \`@vscode/ripgrep-linux-\${arch}\`;
      resolved = require.resolve(\`\${fallbackPkg}/bin/\${binaryName}\`);
    }
  } catch {
    if (!resolved && existsSync(FALLBACK_RG)) resolved = FALLBACK_RG;
  }
}
if (!resolved) throw new Error(\`No ripgrep binary for \${process.platform}-\${arch}\`);

export const rgPath = resolved;
`;
        writeFileSync(rgMain, patched);
        log('@vscode/ripgrep android fallback patched: ' + rgMain);
      }
    }
  }
} catch (e) { log('WARN @vscode/ripgrep: ' + e.message); }

/* dsh-sandbox / dsh-sandbox-local 的 "/tmp"→TMPDIR 补丁已移除（v4.10 审计）：
 * 上游 writableRoots() 现原生并入 os.tmpdir()（Node 会优先读 TMPDIR 环境变量，
 * 启动器 web 进程恒导出应用私有 tmp），沙箱白名单无需再改写源码；
 * sandbox-local 的 --tmpfs/readWrite 分支依赖 bubblewrap，Android 上本就不可达。
 * 旧补丁在 rc.2 上零替换仍会向上游文件追加 marker 头，属纯污染。 */

try {
  // 已针对 0.1.7-rc.2 核实：dsh-fs-local@0.1.7-rc.2/lib/index.js 三处锚点
  // **全部命中 1 次**：
  //   'await chmod(stagingDir, 448);' / 'await handle.chmod(384);' /
  //   'if (mode !== void 0) await handle.chmod(mode);'
  // → **保持不动**。注意 0.1.7 同时新增了 @deepseek-ai/dsh-atomic-write，
  //   本补丁**不覆盖**它——该新包已在文件末尾单独评估（结论：无需补丁）。
  //
  // Android 共享存储（/storage/emulated/0，FUSE）不支持 chmod；dsh-fs-local 原子写
  // 会对临时 staging 目录/文件 chmod 0700/0600，导致 EACCES。这里把 chmod 改为
  // 遇到 EACCES/EPERM 时忽略（权限位在 FUSE 上本来也无法生效）。
  const MARKER_FS_CHMOD = 'dsh-launcher-android-fs-chmod';
  const fsLocal = findPkg('@deepseek-ai/dsh-fs-local', 'lib/index.js');
  if (fsLocal) {
    let src = readFileSync(fsLocal, 'utf8');
    if (src.includes(MARKER_FS_CHMOD)) {
      log('dsh-fs-local chmod already patched');
    } else {
      const guard = (expr) => `try { ${expr}; } catch (e) { if (e && (e.code === 'EACCES' || e.code === 'EPERM')) { /* Android FUSE: chmod unsupported */ } else throw e; }`;
      src = src.split('await chmod(stagingDir, 448);').join(guard('await chmod(stagingDir, 448)'));
      src = src.split('await handle.chmod(384);').join(guard('await handle.chmod(384)'));
      src = src.split('if (mode !== void 0) await handle.chmod(mode);').join(`if (mode !== void 0) { try { await handle.chmod(mode); } catch (e) { if (e && (e.code === 'EACCES' || e.code === 'EPERM')) { /* Android FUSE: chmod unsupported */ } else throw e; } }`);
      writeFileSync(fsLocal, `// ${MARKER_FS_CHMOD}\n` + src);
      log('dsh-fs-local chmod patched');
    }
  } else {
    log('dsh-fs-local: not found, skip chmod patch');
  }
} catch (e) { log('WARN dsh-fs-local chmod: ' + e.message); }
