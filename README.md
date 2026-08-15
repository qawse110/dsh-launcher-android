# DshLauncher (Android)

Single-APK Android launcher for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).
Embeds a Termux Node.js aarch64 runtime and boots the dsh CLI web app directly
on the device — no Termux or external Node installation required.

**Package**: `com.dsh.launcher` — build with AGP 9.0 / Kotlin / Gradle 8.x.

## Features

- Built-in Node runtime extracted from APK assets (`assets/node/…`) into the app
  private dir; `makeUnwritable` applied so the `W^X` exec restriction is lifted
  (Android requires non-writable files for exec).
- Built-in command console (`ConsoleActivity`) that drives the dsh bootstrap:
  `1/4 ensure node → 2/4 read stub from assets → 3/4 install+build → 4/4 start web`.
- `--ez dsh true` extra triggers the full bootstrap flow from `adb` or launchers.
- `dsh web` serves on `http://127.0.0.1:3080`; open it in Via / any browser.
- Optional: mobile UI takeover via the
  [`dsh-client-ui-mobile`](https://github.com/qawse110/dsh-client-ui-mobile)
  plugin on narrow viewports.

## Build

```sh
# 0) place a release.keystore in the project root (or set DSH_KEYSTORE_FILE)
# 1) build (release uses the keystore; falls back to debug signing)
./gradlew assembleRelease

# or with the signing config fully driven by env:
DSH_KEYSTORE_FILE=/path/to/release.keystore DSH_KEYSTORE_PASS=... ./gradlew assembleRelease
```

`app/build.gradle.kts` reads the keystore from `DSH_KEYSTORE_FILE` (default
`release.keystore` in project root) and the password from `DSH_KEYSTORE_PASS`
(default `dshlauncher123`). **Never commit a keystore or its password to the
repo** — the checked-in default exists only for local development.

## Install & run

```sh
adb install -r app-release.apk
adb shell am start -n com.dsh.launcher/.ConsoleActivity --ez dsh true
# wait for "OK 4/4 dsh web started", then open http://127.0.0.1:3080/
```

> Note: on some ColorOS devices, installing from `/sdcard` can hit FUSE file
> context issues (`system_server` cannot read the APK). Copy to
> `/data/local/tmp/` first: `adb push app-release.apk /data/local/tmp/ && adb shell pm install -r /data/local/tmp/app-release.apk`.

## Releases

Prebuilt signed APKs are published on the
[Releases](https://github.com/qawse110/dsh-launcher-android/releases) page.
