# 更正：「page.snapshot() 返回 0 字符」不是产品缺陷，是我测试代码的错误

日期：2026-10-13（真机 RMX3888 / Android 16 / arm64-v8a）
对象：dsh-ego-browser 的 snapshot 通路

## 我此前写下的错误结论
new-apk-defects.md 与后续几轮把它记为「缺陷 2：page.snapshot() 返回 0 字符，
ego_snapshot 退化；read 类工具走 snapshotRaw() 不受影响」。并据此在 task 里
当作唯一未闭环的功能缺口。

## 实际原因（我的测量代码错了，产品是对的）
dsh-ego-browser 有**两个** snapshot API，返回类型不同：

| API | 定义位置 | 返回类型 |
|---|---|---|
| `page.snapshot(options)` | runtime/ego-browser/dist/out/index.js:2246 | **string**（`return result.content \|\| ""`） |
| `page.snapshotRaw(options)` | 同上 :2223 | object `{ content, refs }` |

我此前对两者都写了 `String(s.content).length`。对 `snapshotRaw()` 正确；
对 `snapshot()`——它返回的是字符串，`"abc".content` 是 `undefined`——
于是量出 0，被我误判为「实现坏了」。

## 更正后的真机实测（设备源码与仓库 byte-identical，sha256 2c2807e9…）
对同一页面：
    snapshot()    typeof=string len=41  head="heading1 \"FINAL_c4\"\ntext: final body para"
    snapshotRaw() typeof=object hasContent=true contentLen=41
                  head="heading1 \"FINAL_c4\"\ntext: final body para"

再按**插件真实调用形态**（lib/index.js:3771 的 `await page.snapshotRaw()` →
取 `s.content`，带最多 3 次重试）实测：
    EGO_SNAPSHOT contentLen=104 tries=0
    head="heading1 \"PLUGIN_e9\"\ntext: plugin body\nbutton \"OK\" [ref=15938, loc=role:button[n…"
    refs=1
⇒ 含 [ref]/loc 的结构化语义树、以及 refs 都正常产出。**ego_snapshot 可用。**

## 途中真正查清的事实（不是为了修 bug，但有价值）
- 该 WebView **支持** DOMSnapshot.captureSnapshot：真机返回 strings=76
  documents=1 nodes=32（另一页 2579/1/7637），layout.bounds 2060/2221 为正。
  即「WebView 不支持 DOMSnapshot」的猜想**被证伪**。
- 中继与 ego 的 CDP id 空间**不冲突**：ego transport 从 1_000_000 起、
  中继从 900_000_000 起（此前怀疑互相吃回包，实测证伪）。
- 插桩期间确认 shim 内部产出正确（out 2 行 / contentLen 30），只是我在外层
  用错了字段名。

## 处置
- 我已把设备端被插桩的 src/snapshot.mjs **完全还原**，并与仓库版本核对
  sha256 一致（2c2807e9…），未留下任何修改。
- 结论：**缺陷 2 撤销**。当前 task 的功能性遗留项只剩
  「GUI 可见性需要用户肉眼确认」这一条。
