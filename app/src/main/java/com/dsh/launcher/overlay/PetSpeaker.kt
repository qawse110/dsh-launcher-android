package com.dsh.launcher.overlay

import android.content.Context
import android.os.SystemClock
import android.speech.tts.TextToSpeech
import java.util.Locale

/**
 * 桌宠语音域封装（架构方案 P1-6 第二刀）。
 *
 * 职责：系统 TTS 生命周期与懒初始化补播、Edge 在线引擎分流、状态转折固定台词
 * （4 秒节流）、正文整句增量播报（句界/软标点断句，游标内部持有）。
 * 偏好经 [BridgePrefs] 读取；释放由服务销毁路径调用 [release]。
 */
internal class PetSpeaker(
    private val context: Context,
    private val prefs: BridgePrefs,
) {
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var ttsReleased = false
    private var pendingSpeak: String? = null
    private var edgeTtsInited = false
    private var lastSpokenKey: String? = null
    private var lastSpokeAt = 0L
    private var spokenLen = 0

    private val sentenceEndRe = Regex("[。！？!?…；;]|\\n")
    private val softPuncts = charArrayOf('，', ',', '、', '：', ':', ' ')

    /** 状态转折固定台词（4 秒节流；同一 key 不重复播）。 */
    fun speakForStatus(status: String, event: String?) {
        val key = "$status|${event ?: ""}"
        if (key == lastSpokenKey) return
        lastSpokenKey = key
        if (SystemClock.uptimeMillis() - lastSpokeAt < 4000L) return
        val phrase = when {
            status == "finished" -> "任务完成，太棒了！"
            status == "failed" -> "出错了，快打开 Web 看看吧"
            status == "running" && event == "tool/call" -> "正在调用工具，稍等一下"
            status == "running" && event == "turn/start" -> "收到新任务，开始干活！"
            else -> null
        }
        if (phrase != null) {
            lastSpokeAt = SystemClock.uptimeMillis()
            speak(phrase)
        }
    }

    /**
     * 正文增量朗读：只读「上次读到之后」的新增完整句。
     * - 句界：。！？!?…；; 换行；凑齐一句即入队（QUEUE_ADD 接续）；
     * - 160 字内无句界按软标点兜底，硬切上限 160；
     * - 新消息变短或 turn/start 重置游标；完成/失败不追加正文。
     */
    fun speakContent(text: String?, status: String, event: String?) {
        if (!prefs.petTts() || ttsReleased) return
        if (text.isNullOrEmpty()) return
        if (event == "turn/start" || event == "user/message") spokenLen = 0
        if (text.length < spokenLen) spokenLen = 0
        if (status != "running" || event != "assistant/message") return
        if (spokenLen >= text.length) return

        var start = spokenLen
        var advanced = false
        while (start < text.length) {
            val remain = text.substring(start)
            val window = remain.substring(0, minOf(remain.length, 160))
            val ends = sentenceEndRe.findAll(window).toList()
            val utterance: String
            if (ends.isNotEmpty()) {
                val m = ends.last()
                utterance = window.substring(0, m.range.last + 1)
            } else if (remain.length > 160) {
                // 积压超限仍无句界：软标点兜底断句，再不行硬切
                val softIdx = window.lastIndexOfAny(softPuncts)
                utterance = if (softIdx > 40) window.substring(0, softIdx + 1) else window
            } else {
                break // 句子尚未写完，等下一轮轮询
            }
            val trimmed = utterance.trim()
            if (trimmed.isNotEmpty()) speak(trimmed, append = true)
            start += utterance.length
            advanced = true
        }
        if (advanced) spokenLen = start
    }

    /**
     * 播报总入口：按设置分流 Edge 在线语音 / 系统引擎。
     * @param append false=FLUSH（打断当前），true=ADD 接续排队。
     */
    fun speak(text: String, append: Boolean = false) {
        if (!prefs.petTts() || text.isBlank()) return
        val engine = prefs.ttsEngine()
        if (engine == "edge") {
            if (!edgeTtsInited) {
                edgeTtsInited = true
                EdgeTts.init(context.applicationContext) { t, fl -> speakSystem(t, fl) }
            }
            EdgeTts.enqueue(text, prefs.ttsEdgeVoice(), !append)
            return
        }
        speakSystem(text, append)
    }

    /** 系统 TextToSpeech 播报（含懒初始化与初始化期补播）。 */
    private fun speakSystem(text: String, append: Boolean) {
        if (ttsReleased || text.isBlank()) return
        if (tts == null) {
            pendingSpeak = text
            tts = TextToSpeech(context) { status ->
                ttsReady = status == TextToSpeech.SUCCESS
                if (ttsReady) {
                    val ok = (tts?.isLanguageAvailable(Locale.CHINA) ?: -1) >= TextToSpeech.LANG_AVAILABLE
                    tts?.setLanguage(if (ok) Locale.CHINA else Locale.getDefault())
                }
                // 初始化期间积压的最后一句话在此刻补播
                val p = pendingSpeak
                pendingSpeak = null
                if (p != null && ttsReady) {
                    try {
                        tts?.speak(p, TextToSpeech.QUEUE_FLUSH, null, "dsh_pet")
                    } catch (_: Exception) {
                    }
                }
            }
            return
        }
        if (!ttsReady) {
            pendingSpeak = text
            return
        }
        try {
            tts?.speak(text, if (append) TextToSpeech.QUEUE_ADD else TextToSpeech.QUEUE_FLUSH, null, "dsh_pet")
        } catch (_: Exception) {
            // TTS 不可用时静默
        }
    }

    /** 悬浮窗重置时清空播报节流/去重状态（保持既有行为：与视图计数一同归零）。 */
    fun resetTransientState() {
        lastSpokenKey = null
        lastSpokeAt = 0L
    }

    /** 释放 TTS 与 Edge 引擎资源（释放后不再重建）。 */
    fun release() {
        ttsReleased = true
        EdgeTts.shutdown()
        tts?.shutdown()
        tts = null
        ttsReady = false
    }
}
