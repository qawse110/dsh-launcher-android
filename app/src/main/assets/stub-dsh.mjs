#!/usr/bin/env node
/**
 * stub-dsh.mjs — Android 兼容性修复的**驱动层**。
 *
 * 只做一件事：按顺序加载各补丁模块。补丁实现全部在 assets/stub/ 下：
 *
 *   stub/env.mjs                    路径常量、日志、包定位（findPkg / eachPlugin*）
 *   stub/patchers/native-stubs.mjs  koffi / node-pty / sharp / node-addon 顶替
 *                                   + attachment-local 视觉链路 v5
 *   stub/patchers/host-runtime.mjs  sendAttribution / koffi ABI / 前端 polyfill /
 *                                   codebuddy 布局 / ripgrep 回退 / fs-local chmod
 *   stub/patchers/plugin-compat.mjs 内置插件 host 端 + client 端源码兼容
 *   stub/patchers/flock.mjs         Android flock 降级
 *
 * 拆分动机：此前本文件 1336 行、13 个顶层补丁块挤在一个作用域里。补丁彼此
 * **完全独立**（各自有 marker、各自锚点、各自 WARN），拆开后「哪个补丁在修什么」
 * 由文件名直接回答，新增补丁只需加一个文件 + 一行 import。
 *
 * 原则（不变）：**只修 Node/原生模块加载期与 WebView 引导期的问题**——
 * 凡是能在 Cordis 插件运行时实现的功能一律下沉为独立内置插件
 * （见 docs/plugin-conversion-audit.md），避免每次 dsh 升级都要重新对表锚点。
 *
 * 环境变量：
 *   HOME / NODE_DIR / DSH_PREFIX / DSH_PROFILE
 */
import { log } from './stub/env.mjs';
import './stub/patchers/native-stubs.mjs';
import './stub/patchers/host-runtime.mjs';
import './stub/patchers/plugin-compat.mjs';
import './stub/patchers/flock.mjs';

// ⚠ 收尾日志必须留在驱动层：它是「全部补丁块已执行完」的唯一信号，
//   历史上用于确认 boot 期兼容修复整体完成（旧版位于最后一块之后）。
log('=== android fixup done ===');
