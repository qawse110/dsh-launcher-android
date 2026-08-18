package com.dsh.launcher

/**
 * dsh 状态悬浮窗的内容格式化。
 * 把 status + lastEvent 转成更可读的中文状态，并拼接最近输出片段。
 */
fun statusLabel(status: String, event: String? = null): String = when (status) {
    "running" -> when (event) {
        "turn/start" -> "思考中"
        "user/message" -> "收到消息"
        "assistant/message" -> "输出中"
        "tool/call" -> "调用工具"
        else -> "dsh 运行中"
    }
    "finished" -> "AI 输出完成"
    else -> "dsh 空闲"
}

fun buildOverlayText(
    status: String,
    event: String?,
    text: String,
    showStatus: Boolean,
    showLastText: Boolean,
    fullMode: Boolean
): String {
    val statusText = if (showStatus) statusLabel(status, event) else ""
    val snippet = if (showLastText && text.isNotBlank()) {
        if (fullMode) text.take(160) else text.take(24)
    } else ""
    return listOf(statusText, snippet).filter { it.isNotBlank() }.joinToString(" · ")
}
