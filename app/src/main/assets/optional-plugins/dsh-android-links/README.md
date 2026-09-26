# dsh-android-links

把 Android 共享存储以**符号链接**暴露进 dsh HOME 目录的独立内置插件。

## 解决什么问题

dsh Web UI「添加工作区」的目录浏览器根目录是 `os.homedir()`，在 Android 上即应用私有目录，
用户看不到 `/storage/emulated/0`（SD 卡）下的任何内容。

旧方案由 `stub-dsh.mjs` 在每次启动时**直接改写**
`@deepseek-ai/dsh-host-directory-picker-browse/lib/index.js` 源码、硬编码插入 "SD Card" 条目——
dsh 一旦升级、锚点漂移就会静默失效甚至毒化文件。

本插件利用 browse 服务**原生就支持符号链接**这一事实（`list()` 保留
`dirent.isSymbolicLink()` 项，`directoryRow()` 会 stat 跟随链接判断可进入），
只需在 HOME 下创建一个指向共享存储的符号链接即可，**零 dsh 文件改动**。

## 配置

| 环境变量 | 缺省 | 说明 |
|---|---|---|
| `DSH_ANDROID_LINKS` | `sdcard=/storage/emulated/0` | 逗号分隔的 `名称=目标` 列表；只写名称时按 `/storage/emulated/0/<名称>` 解析 |

## 安全约定

- 幂等；目标缺失/非目录时跳过；同名位置被非符号链接占用时**绝不覆盖**。
- 卸载插件不回收已创建的链接（用户可见的文件系统便利设施，避免活动会话断链）。
