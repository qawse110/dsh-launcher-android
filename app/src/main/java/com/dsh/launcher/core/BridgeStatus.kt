package com.dsh.launcher.core

import org.json.JSONObject

/**
 * `dsh-status-bridge` 插件 `/status` 端点的响应模型（唯一解析点）。
 *
 * ## 为什么集中
 *
 * 该 JSON 是**插件与壳侧的跨进程契约**（插件版本 0.1.2 起增加 `toolName`）。
 * 此前壳侧有**两处各自手写解析**（`StatusBridgeService` 的轮询路径与
 * `KeepAliveAccessibilityService` 的无障碍通道），字段名与默认值分散在四处字面量里——
 * 插件加字段时极易只改一处（实测已发生过：`toolName` 上线时两处都要手改）。
 *
 * 集中后：新增字段只改本文件 + 插件 + `tools/check-plugin-contract.cjs` 门禁。
 *
 * ## 向后兼容约定
 *
 * 旧版插件不发送的字段一律取默认值（不抛异常、不伪装成空串语义）：
 * - `status` 缺省 `"idle"`（未知状态归为空闲，避免界面停在运行态）
 * - `toolName`/`lastEvent` 缺省 `null`（而非 `""`）——调用方据 null 走回退文案
 */
data class BridgeStatus(
    /** 插件上报的运行状态：idle / running / finished / failed / aborted / blocked。 */
    val status: String,
    /** 最近输出文本（插件已按上限截断）。 */
    val text: String,
    /** 最近一次**语义**事件类型；旧插件或未开始时为 null。 */
    val event: String?,
    /** 状态最后一次变更时刻（插件侧 epoch ms），用于去重「刚完成」提醒。 */
    val updatedAt: Long,
    /** 当前工具名（插件 0.1.2 起）；无工具活动时为 null。 */
    val toolName: String?,
) {
    companion object {
        /** 解析 `/status` 响应体；非 JSON 或结构异常返回 null（探测契约：失败即 null）。 */
        fun parse(json: JSONObject): BridgeStatus = BridgeStatus(
            status = json.optString("status", "idle"),
            text = json.optString("lastText", ""),
            event = json.optNullableString("lastEvent"),
            updatedAt = json.optLong("updatedAt", 0L),
            toolName = json.optNullableString("toolName"),
        )

        /** 便于测试与门禁构造字面量。 */
        val IDLE = BridgeStatus("idle", "", null, 0L, null)
    }
}

/**
 * 取可空字符串：**键不存在与值为空串都返回 null**。
 *
 * `JSONObject.optString(key, null)` 在键存在但为 JSON null 时返回字面量 `"null"`，
 * 是常见陷阱；且空串对「无此事件」的调用方语义等同缺失（都会走回退分支）。
 */
private fun JSONObject.optNullableString(key: String): String? {
    if (!has(key) || isNull(key)) return null
    return optString(key, "").takeIf { it.isNotEmpty() }
}
