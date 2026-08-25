# 插件化迁移侦察（feat/plugin-conversion）

## 目标1：directory-picker 的 SD Card 快捷入口（可行性：高 → 已确认）

- dsh-host-directory-picker-browse 在 apply 中注册 **cordis 服务 `ctx.directoryPicker`**
  （源码自述："registers ctx.directoryPicker / stable capability object per service life"）
- entries 装配位于其 browse 方法，含 `this.config.maxEntries` 与既有 stub 注入的
  sdcard unshift 段（marker: dsh-launcher-android-sdcard-shortcut）

### 迁移方案
插件 apply(ctx) 内包装现有服务：
```js
const picker = ctx.directoryPicker
const raw = picker.browse.bind(picker)
picker.browse = async function (...args) {
  const res = await raw(...args)
  try {
    if ((await stat('/sdcard')).isDirectory() &&
        !res.entries.some(e => e.path === '/sdcard')) {
      res.entries.unshift({ name: 'SD Card', path: '/sdcard', hidden: false })
    }
  } catch {}
  return res
}
```
随后删除 stub-dsh 对该包的源码注入节。

## 后续目标（同模式确认 ctx.<service> 缝）
- host-apiproxy openPath 委托宿主（找 apiproxy 的 ctx 服务注册名）
- dsh-sandbox 可写根配置
