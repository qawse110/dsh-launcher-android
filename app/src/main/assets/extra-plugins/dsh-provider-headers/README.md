# dsh-provider-headers

DeepSeek Harness plugin — configure **custom HTTP request headers** for your custom
(custom-provider) model providers, right from the web **设置 → 请求头** (Models settings)
page, instead of hand-editing `settings.yaml`.

## What it does

- Adds a **"请求头"** section to the web **Settings** page (next to "模型"/Models).
- Lists every **custom (llm-pi-ai) provider** you have configured.
- Lets you add/remove/edit header key→value rows per provider and save them.
- Saves into `llm-pi-ai.providers.<route>.headers`, which the shipped
  `@deepseek-ai/dsh-llm-pi-ai` adapter **already sends on every request** — so the
  headers take effect immediately, no backend changes needed.

> Why a plugin? The backend has supported per-provider `headers` all along; only the
> web UI to configure them was missing. This plugin supplies that UI.

## How it works

- **Host side** (`lib/index.js`): inert — the row exists so the loader mounts the
  package and `dsh-client-modules` composes the browser bundle into `__DSH_BOOT__`.
- **Browser side** (`lib/client.js`): a client plugin that registers into the
  `settings.section` slot with id `provider-headers`, reads the `llm-pi-ai`
  settings namespace via `settings.describe`, and writes header maps via
  `settings.mutate` (ops `set` at `["providers", route, "headers"]`).
- **Mounting**: a single patch entry (`cordis.patch.yml`) inserts the row into the
  profile composition.

## Install

The plugin is a DSH profile bundle (`dsh.bundle.patch`). Two equivalent ways:

### A. Manual (no pnpm needed) — used for the web profile

1. Copy the package into the profile's node_modules:
   ```
   Copy-Item D:\code\dsh-provider-headers -> C:\Users\HK200\.dsh\profiles\web\node_modules\dsh-provider-headers -Recurse -Force
   ```
2. Add the mount row to `C:\Users\HK200\.dsh\profiles\web\cordis.patch.yml`:
   ```yaml
   - insert:
       - id: provider-headers
         name: dsh-provider-headers
   ```
3. **Refresh the web GUI** (the profile watches the patch file and hot-mounts the
   plugin server-side; the browser picks it up on the next page load).

### B. Via `dsh plugin` (requires pnpm)

```
dsh plugin --profile web add <path-or-version-of-dsh-provider-headers>
```
(`pnpm` must be on PATH; the `dsh plugin` command forwards to it and records the
bundle in the profile manifest.)

## Usage

1. Open **设置 (Settings) → 请求头 (Request headers)**.
2. For each custom provider card, add header rows (e.g. `Authorization`,
   `X-Custom-Header`), then click **保存 (Save)**.
3. Every request to that provider now carries the configured headers.

The values land in `settings.yaml` under:

```yaml
llm-pi-ai:
  providers:
    my-route:
      # ...
      headers:
        X-Custom-Header: value
```

## Notes & caveats

- Only **custom (llm-pi-ai) providers** support `headers` today. The official
  DeepSeek channel (`llm-deepseek`) does not — this plugin does not add headers there.
- Attribution headers (`User-Agent`, `x-deepseek-harness-*`) are reserved by the
  adapter and cannot be overridden (case-insensitive).
- Header names/values must be HTTP-header safe; blank names are dropped on save.
- Writes require a writable settings session (read-only sessions show a notice).

## Files

| File | Purpose |
| --- | --- |
| `package.json` | DSH bundle (`dsh.bundle.patch`) + client (`dsh.client`) declaration |
| `cordis.patch.yml` | Bundle patch: mounts the `provider-headers` row |
| `lib/index.js` | Host plugin (inert) |
| `lib/client.js` | Browser plugin: the 请求头 settings section |
| `test/smoke.cjs`, `test/render.cjs` | Node harnesses that validate the bundle logic |
