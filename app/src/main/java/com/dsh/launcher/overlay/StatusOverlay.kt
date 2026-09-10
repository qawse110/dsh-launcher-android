package com.dsh.launcher.overlay

import com.dsh.launcher.core.*
import com.dsh.launcher.overlay.*
import com.dsh.launcher.service.*
import com.dsh.launcher.tts.*
import com.dsh.launcher.ui.*
import com.dsh.launcher.R

/**
 * dsh 状态悬浮窗的内容格式化。
 * 把 status + lastEvent 转成更可读的中文状态，并拼接最近输出片段。
 *
 * @param toolName 当前工具调用的工具名（插件 `tool/call` 上报）。有值时把
 *   「调用工具」细化为「调用 read_file」——此前壳侧只知道「在调工具」，
 *   看不到**哪个**工具（对齐参考项目 `.live.ndjson` 记录 name 的能力）。
 */
fun statusLabel(status: String, event: String? = null, toolName: String? = null): String = when (status) {
    "running" -> when (event) {
        "turn/start" -> "思考中"
        "user/message" -> "收到消息"
        "assistant/message" -> "输出中"
        "tool/call" -> if (toolName.isNullOrBlank()) "调用工具" else "调用 $toolName"
        // 插件只保留「上一个语义事件」（不再被高频 chunk 冲刷），因此 tool/result 之后
        // 会持续停在 tool/result 上——须给文案，否则退化成信息量更低的「dsh 运行中」。
        "tool/result" -> if (toolName.isNullOrBlank()) "处理工具结果" else "$toolName 完成"
        else -> "dsh 运行中"
    }
    "finished" -> "AI 输出完成"
    // 插件 turn/end(reason.kind=error) 上报 failed：此前落到 else 分支显示成
    // 「dsh 空闲」灰点，失败在悬浮窗上完全不可见（TTS 有失败台词、文案却没接上）
    "failed" -> "出错了"
    // turn/end 的另两个终态（TurnEndReason.kind = aborted | blocked）：
    // 插件不再把它们并成 finished（那会误弹「任务完成」通知），壳侧必须有对应文案，
    // 否则落到 else 显示成「dsh 空闲」，语义不准确。
    "aborted" -> "已取消"
    "blocked" -> "已阻塞"
    else -> "dsh 空闲"
}

fun buildOverlayText(
    status: String,
    event: String?,
    text: String,
    showStatus: Boolean,
    showLastText: Boolean,
    fullMode: Boolean,
    toolName: String? = null
): String {
    val statusText = if (showStatus) statusLabel(status, event, toolName) else ""
    val snippet = if (showLastText && text.isNotBlank()) {
        if (fullMode) text.take(160) else text.take(24)
    } else ""
    return listOf(statusText, snippet).filter { it.isNotBlank() }.joinToString(" · ")
}
