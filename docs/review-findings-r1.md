# Code Review 记录 —— R1.5 横切扫描（overlay/service/ui）

- 基准：v4.7.0 @ `d33ad44` 之后
- 方法：高信号模式扫描（Handler/流关闭/prefs 同步写/回调清理/轮询周期）+ 定点读源
- 结论先行：修复 **4 处**，误报排除 **5 类**，遗留观察 **3 项**

## 已修复

| # | 位置 | 问题 | 修复 |
|---|---|---|---|
| 1 | StatusBridgeService.writeHeartbeat | 心跳在**主线程**做同步磁盘 I/O（每轮询周期两次写）；`heartbeat.log` appendText 无上限增长 | 单线程后台执行器落盘；追加日志改走 FileLog（可读时间戳 + 512KB 轮转） |
| 2 | 同上 json 写入 | 直接 writeText 存在半截 JSON 窗口（watchdog 读侧靠 try/catch 兜底） | tmp + rename 原子替换 |
| 3 | overlay/StatusBridgeAlerts:38 | 主线程回调路径用 prefs `commit()` 同步落盘 | 改 `apply()`（内存即时可见，去重语义不变） |
| 4 | ui/MainActivity onDestroy/autoRoute | 仅清理 pollRunnable，其余 post（含延迟 beginFlow）销毁后仍触达；autoRoute post 无 finishing 守卫 | `removeCallbacksAndMessages(null)` 全量清扫 + post 内 `isFinishing/isDestroyed` 守卫 |

## 误报排除（审计过、确认健康）

- CodexPetStore 精灵表解码：`openSheetStream(...)?.use { decodeStream }` 已正确包裹
- Handler 构造：全项目均为 `Handler(Looper.getMainLooper())` 正确形态
- 无 companion object 静态持有 Context/Activity 的泄漏点
- EdgeTts：generation(stale) 守卫 + shutdown/cancel/close 生命周期完整
- PowerGovernor 自适应轮询（亮屏 1s → 灭屏空闲 30s）设计良好，无需改动

## 遗留观察（挂到既有路线图项）

1. BridgeOverlayManager 1268 行 —— 对应路线图 P1-6 拆分（桌宠 16ms ticker 有 falling/walk 标志位停止条件，未见失控循环）
2. PluginManagerActivity 1143 行 —— P2-4 插件分发解耦时一并瘦身
3. NodeRuntime.extractTar 手动 try/finally 关闭流 —— 可改 `use{}`（纯风格，随 P2-1 协程化顺带）
