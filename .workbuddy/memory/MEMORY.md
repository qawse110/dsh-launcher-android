# 项目长期记忆（dsh-launcher-android）

## 真机调试
- 测试机：realme RMX3888（`af45d401`），Android 16。`adb` 在 `D:\android-sdk\platform-tools`。
- **release APK 不可 debuggable**（`flags=0x0`），`run-as` 不可用。取日志走
  `adb pull /sdcard/Download/DshLauncher/logs/flow.log`（`FileLog.exportToShared` 在流程结束时导出）；
  取日志时 Git Bash 下必须加 `MSYS2_ARG_CONV_EXCL="*"`，否则 `/sdcard` 会被转成本地路径。
- 应用私有目录 `files/`：`dsh-prefix`（npm 树）、`stub/`（补丁载荷）、`logs/`、`state/markers.json`。
- 想临时改设备上的补丁脚本做验证：`adb shell "run-as ... cat > files/stub/xxx.mjs" < 本地文件`。
  注意 App 每次流程开始都会从 APK assets **重新同步** `stub/` 等目录，手工改动只对「本次」有效。

## 构建
- `./gradlew :app:assembleRelease`，签名用 `signing/release.keystore`（alias `dsh`，口令 `dshlauncher123`），
  需设 `DSH_KEYSTORE_FILE=<绝对路径>`；不设会退回 debug 签名（与已装包签名不符，无法覆盖安装）。
- **构建必须在沙箱外执行**，否则 `mergeReleaseAssets` 被拦，报 MD5 hash 失败。
- 本机 SDK 位于 `D:\android-sdk`，需要 `platforms;android-35` + `build-tools;36.0.0`。
  Gradle 发行包官网常超时，用 `mirrors.cloud.tencent.com/gradle/` 镜像。

## 装配 / 补丁约定（血泪）
- `.pnpm` 会并存同一包的多个版本副本（升级/回滚都不清理旧目录）。**定位包必须用
  `findAllPkgPaths()` 覆盖全部副本**，只改「第一个命中」会打出「补丁已打」的假象。
- `stub-applied` marker 不可单独信任：同版本重装后 marker 仍命中，但安装树已被换回上游原样。
  信任 marker 前要过 `DshFlow.stubPatchesPresent()` 之类的产物健康检查。
- `node-addon-require-builtin` 在 npm 上**没有 android-arm64 变体**（registry 404），
  只能靠 `--expose-internals` 的纯 JS 顶替；它是 app-boot 的硬依赖，缺失 = boot 级失败，
  日志表现为「web 未就绪」而无插件级报错。
- dsh 版本单一真源是 `assets/dsh-pin.json`（当前 `0.2.1-rc.2`，跟随 npm `next` 通道）。
  注意：MainActivity 的「检查更新」走 `latest` 通道，与控制台「更新 next」的通道不一致。
