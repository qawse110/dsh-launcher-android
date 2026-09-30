/**
 * dsh-provider-headers — host plugin body.
 *
 * All behavior lives in the browser half (see ./client.js): this package
 * mounts a "请求头 (Provider request headers)" section in the web Models
 * settings page that edits `llm-pi-ai.providers.<route>.headers`.
 *
 * The host side contributes nothing at runtime: the shipped llm-pi-ai adapter
 * already reads `headers` from each provider profile and sends them on every
 * request. This row exists so the cordis loader mounts the package and the
 * client-modules service composes its browser bundle into __DSH_BOOT__.
 */
export function apply() {}
