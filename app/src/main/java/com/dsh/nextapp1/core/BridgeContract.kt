package com.dsh.nextapp1.core

import android.content.Context
import org.json.JSONObject
import java.io.File

/**
 * dsh-status-bridge 的**端口与 token 单一真源**。
 *
 * 为什么需要（审查项 X1）：端口 3190 原先硬编码在三处 —— 插件默认值、
 * [com.dsh.nextapp1.service.StatusBridgeService]、[com.dsh.nextapp1.service.KeepAliveAccessibilityService]；
 * 而插件**支持** `DSH_STATUS_BRIDGE_PORT` 覆盖、Kotlin 侧不支持 ⇒ 一旦有人设了该环境变量，
 * Kotlin 静默连不上，且因为轮询异常被吞掉，表现只是「dsh 不可达」，无法归因。
 *
 * 现在插件每次启动把 `{port, token}` 写进 `<filesDir>/status-bridge.json`（0600），
 * 两侧都从这里读；token 同时解决审查项 S2（回环无鉴权 + CORS 通配外泄正文）。
 *
 * 文件缺失或损坏时退回 `(3190, null)`：那是**未装配**或**旧版插件**的形态，
 * 与改动前行为一致（向后兼容）。
 */
object BridgeContract {
    const val DEFAULT_PORT = 3190
    const val FILE_NAME = "status-bridge.json"

    /**
     * @param token   为 null 表示对端不要求鉴权（旧版插件）。
     * @param present 契约文件是否存在 —— 即**桥接插件是否装配过**。
     *                用于把「桥接没装」与「装了但掉线」区分开（审查项 X3）：
     *                两者以前都只表现为 poll-null，无法归因。
     */
    data class Spec(val port: Int, val token: String?, val present: Boolean)

    fun read(context: Context): Spec {
        val f = File(context.filesDir, FILE_NAME)
        if (!f.isFile) return Spec(DEFAULT_PORT, null, present = false)
        return try {
            val j = JSONObject(f.readText())
            Spec(j.optInt("port", DEFAULT_PORT), j.optString("token", "").ifBlank { null }, present = true)
        } catch (t: Throwable) {
            Spec(DEFAULT_PORT, null, present = true)
        }
    }

    /** /status 的完整 URL；token 走 query（便于日志辨认），调用方**同时**用同名请求头发一次。 */
    fun statusUrl(spec: Spec): String =
        if (spec.token == null) "http://127.0.0.1:${spec.port}/status"
        else "http://127.0.0.1:${spec.port}/status?token=${spec.token}"
}
