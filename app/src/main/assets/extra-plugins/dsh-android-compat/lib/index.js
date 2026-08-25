export const name = 'dsh-android-compat'

/**
 * Android 内嵌环境适配层（骨架）。
 *
 * 迁移路线（自 stub-dsh.mjs 分批转入，每批需先在
 * https://deepseek-harness.github.io/deepseek-harness/ 参考文档确认对应扩展点）：
 *
 *  1. directory-picker-browse 的 SD Card 快捷入口
 *     —— 待确认：目录浏览服务的 entries 组合点
 *  2. host-apiproxy 的 openNativePath → 委托宿主 App 代开
 *     —— 待确认：open 动作的路由/事件覆写点
 *  3. dsh-sandbox 可写根 → TMPDIR
 *     —— 待确认：sandbox 配置是否经 ctx.config 暴露
 *  4. dsh-fs-local chmod FUSE 容错
 *     —— 待确认：fs-local 是否暴露错误处理钩子
 *
 * 不可插件化（保留于 stub-dsh.mjs 启动前机制）：
 *  koffi/node-pty/sharp 模块桩、@vscode/ripgrep resolver、
 *  attachment-local 函数体级视觉补丁（均需在依赖装载前介入）。
 */
export function apply(ctx) {
  try {
    console.log('[dsh-android-compat] apply: android compat layer loaded')
    // 后续迁移的能力注册写在这里（事件监听/服务/工具），卸载时由框架自动清理。
  } catch (e) {
    console.log('[dsh-android-compat] apply failed:', e?.message || e)
  }
}
