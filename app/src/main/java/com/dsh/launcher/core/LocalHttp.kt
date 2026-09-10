package com.dsh.launcher.core

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * 本机回环 HTTP 的唯一入口（架构整理：消除 4 处重复探测实现）。
 *
 * ## 为什么必须集中
 *
 * 本项目有四处「探测本机端口」的代码，此前各自实现同一套动作：
 * 建连接 → 设超时 → GET → 判状态码 → 断开。它们既重复又已出现细微漂移
 * （超时值不一致、`disconnect` 有的在正常路径、有的在 `finally`）。
 *
 * ## 两条硬约束（都有真实事故背景）
 *
 * 1. **一律 [java.net.Proxy.NO_PROXY]**：用户在系统/Wi-Fi 设置里配了代理时，
 *    默认 `ProxySelector` 会把 `127.0.0.1` 请求也交给代理 → 探针全部超时 →
 *    看门狗误判 dsh 已死 → 反复误杀/误拉起。而 WebView（Chromium 对 loopback
 *    豁免代理）与 curl（不读系统代理）却正常，形成「网页能开、app 判引擎没起来」
 *    的矛盾现场（对齐参考实现 dsh-mobile-apk 坑 33）。
 * 2. **`disconnect()` 必须在 `finally`**：`responseCode` 抛异常时（连接被拒、
 *    读超时）也要释放连接，否则 fd 泄漏在长驻轮询线程里会累积。
 *
 * 本对象是纯函数式工具：无状态、可并发调用，便于单测直接覆盖。
 */
object LocalHttp {

    /** 探测/读取默认超时（毫秒）。轮询路径对延迟敏感，故取较小的固定值。 */
    const val DEFAULT_TIMEOUT_MS = 800

    /** `GET http://127.0.0.1:<port>/` 是否返回 2xx/3xx。 */
    fun responds(port: Int, timeoutMs: Int = DEFAULT_TIMEOUT_MS): Boolean =
        get("http://127.0.0.1:$port/", timeoutMs) { conn -> conn.responseCode in 200..399 } ?: false

    /** 读取本机 URL 的响应体；任何失败（连接/超时/空响应）返回 null。 */
    fun getText(url: String, timeoutMs: Int = DEFAULT_TIMEOUT_MS): String? =
        get(url, timeoutMs) { conn ->
            conn.inputStream.bufferedReader().use { it.readText() }
        }?.takeIf { it.isNotBlank() }

    /** 读取并解析本机 URL 的 JSON 响应体；任何失败返回 null。 */
    fun getJson(url: String, timeoutMs: Int = DEFAULT_TIMEOUT_MS): JSONObject? =
        getText(url, timeoutMs)?.let { text ->
            runCatching { JSONObject(text) }.getOrNull()
        }

    /**
     * 统一的「建连 → GET → 取值 → 断开」骨架。
     *
     * @param read 在连接就绪后被调用以取值；抛出的异常由本函数吞掉并返回 null
     *   （探测类调用方的契约是「失败 = null/false」，不应把异常抛给轮询线程）
     */
    private fun <T> get(url: String, timeoutMs: Int, read: (HttpURLConnection) -> T): T? {
        val conn = try {
            (URL(url).openConnection(java.net.Proxy.NO_PROXY) as HttpURLConnection).apply {
                useCaches = false
            }
        } catch (_: Exception) {
            // URL 非法/协议不支持：与连接失败同语义，返回 null 而非抛给调用方
            return null
        }
        return try {
            conn.connectTimeout = timeoutMs
            conn.readTimeout = timeoutMs
            conn.requestMethod = "GET"
            read(conn)
        } catch (_: Exception) {
            null
        } finally {
            // 必须放 finally：responseCode/inputStream 抛异常时连接也要释放
            runCatching { conn.disconnect() }
        }
    }
}
