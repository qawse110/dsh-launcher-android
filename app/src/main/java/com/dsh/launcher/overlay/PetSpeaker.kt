package com.dsh.launcher.overlay

import android.content.Context
import android.os.SystemClock
import android.speech.tts.TextToSpeech
import com.dsh.launcher.tts.EdgeTts
import com.dsh.launcher.tts.SentenceSplitter
import java.util.Locale

/**
 * 桌宠语音域封装（架构方案 P1-6 第二刀）。
 *
 * 职责：系统 TTS 生命周期与懒初始化补播、Edge 在线引擎分流、状态转折固定台词
 * （4 秒节流）、正文整句增量播报（句界/软标点断句，游标内部持有）。
 * 偏好经 [BridgePrefs] 读取；释放由服务销毁路径调用 [release]。
 *
 * 每个实例都是 EdgeTts 的独立持有者（S2）：两个桥接通道同进程并存，
 * [release] 只注销自己，不会掐断另一个通道的播报。
 */
internal class PetSpeaker(
    private val context: Context,
    private val prefs: BridgePrefs,
) {
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var ttsReleased = false
    /** 懒初始化期间积压的待播句（按序补播；旧实现是单值，首轮多句只剩最后一句）。 */
    private val pendingQueue = ArrayDeque<String>()
    private var edgeTtsInited = false
    private var lastSpokenKey: String? = null
    private var lastSpokeAt = 0L
    private var spokenLen = 0
    /**
     * 已朗读部分的**前缀**（长度 [spokenLen]）：用于区分「同消息续写」与「换新消息」。
     *
     * M2：旧实现存的是「上次读到的整条 text」。一旦上游对尾部做微调（换行归一、
     * 末尾标点变化、长度截断），`text.startsWith(全文)` 立刻为假 → 游标归零，
     * 长任务下表现为「读到一半突然从头重读一遍」。改存已读前缀后，只有开头部分
     * 被改动才判定为换新消息，尾部波动不再影响续读。
     */
    private var prevRead: String? = null
    /**
     * 已入队但**尚未播出**的正文句（S4）。FLUSH/打断会清掉这些句子，
     * 需要据此把游标回退到未播位置，否则被清掉的段落永远不再朗读。
     */
    private val unspoken = ArrayDeque<String>()


    /**
     * 状态转折固定台词——播报优先级：
     *  - failed（错误）最高：绕过 4s 节流立即播，且**只打断当前这一句**
     *    （INTERRUPT）——排队中的正文仍需继续播，否则用户听不到正文后半段；
     *  - finished（成功）与正文同级：排队接续播（不打断积压正文）；
     *  - tool/call（调用工具）最低：有任何内容在播/排队则直接不读；
     *  - turn/start：新任务开始，上一条消息的遗留队列已过时（游标同步归零）→
     *    清队后播——属「过期内容作废」，不是优先级插队。
     * 4 秒节流与同 key 去重仍适用（错误除外）。
     */
    fun speakForStatus(status: String, event: String?) {
        val key = "$status|${event ?: ""}"
        if (key == lastSpokenKey) return
        lastSpokenKey = key
        if (status == "failed") {
            // 错误最高优先级：不等节流，只打断当前这一句，保留尚未播出的排队内容
            lastSpokeAt = SystemClock.uptimeMillis()
            speak("出错了，快打开 Web 看看吧", EdgeTts.Mode.INTERRUPT)
            return
        }
        if (SystemClock.uptimeMillis() - lastSpokeAt < 4000L) return
        when {
            status == "finished" -> {
                lastSpokeAt = SystemClock.uptimeMillis()
                speak("任务完成，太棒了！", EdgeTts.Mode.APPEND) // 与正文同级：排队接续
            }
            status == "running" && event == "turn/start" -> {
                lastSpokeAt = SystemClock.uptimeMillis()
                speak("收到新任务，开始干活！", EdgeTts.Mode.FLUSH) // 遗留队列作废
            }
            status == "running" && event == "tool/call" -> {
                // 最低优先级：有内容在播/排队就不读（key 已记录，本轮事件内不重试）
                if (isSpeakingActive()) return
                lastSpokeAt = SystemClock.uptimeMillis()
                speak("正在调用工具，稍等一下", EdgeTts.Mode.APPEND)
            }
        }
    }

    /**
     * 是否有播报在进行或排队（低优先级让路判断）。
     * Edge 引擎除查自身队列外还要看系统 TTS：Edge 失败会回落系统引擎播放，
     * 此刻 busy 已释放但音频仍占着声道。
     */
    private fun isSpeakingActive(): Boolean =
        tts?.isSpeaking == true || pendingQueue.isNotEmpty() || when (prefs.ttsEngine()) {
            "edge" -> EdgeTts.isActive()
            else -> false
        }

    /**
     * 正文增量朗读：只读「上次读到之后」的新增完整句。
     * - 句界：。！？!?…；; 换行；凑齐一句即入队（QUEUE_ADD 接续）；
     * - 160 字内无句界按软标点兜底，硬切上限 160；
     * - 换新消息（当前文本不以已读内容开头）或 turn/start/user/message 重置游标；
     *   完成/失败不追加正文。
     */
    fun speakContent(text: String?, status: String, event: String?) {
        // 游标归零必须发生在「是否启用 TTS」的门禁之前（S3）：旧实现先判 petTts/release
        // 再归零，关闭 TTS 或释放后 lastText 清空时游标残留，复用实例会带着旧偏移跳读。
        if (text.isNullOrEmpty()) {
            // 新任务清空 lastText：归零游标与已读记录，等待新正文
            spokenLen = 0
            prevRead = null
            unspoken.clear()
            return
        }
        if (!prefs.petTts() || ttsReleased) return
        val prev = prevRead // 局部副本：避免可变属性导致智能转换失败
        if (event == "turn/start" || event == "user/message") {
            spokenLen = 0
            prevRead = null
            unspoken.clear()
        } else if (prev != null && !text.startsWith(prev)) {
            // 换新消息（已读前缀不再匹配新文本开头）：旧游标可能落在新文本中间
            // （尤其新消息更长时），跳读开头——归零重读
            spokenLen = 0
            prevRead = null
            unspoken.clear()
        }
        // 关键门禁修正：dsh 的 assistant/message 在整条消息组装完成后才发射一次，随后立刻被
        // turn/end（或 tool/call）顶掉——1s 轮询几乎永远看不到「running + assistant/message」
        // 这个瞬时状态，旧门禁让正文永远不读。改为按任务态放行：
        //  - running：生成中（流式 text-delta 让 lastText 实时增长）或轮询偶遇正文事件；
        //  - finished：整条答案已落盘在 lastText，补读兜底；
        //  - idle / failed 不读正文（failed 的 lastText 是错误前缀，固定台词已覆盖）。
        if (status != "running" && status != "finished") return
        if (spokenLen >= text.length) return

        var start = spokenLen
        var advanced = false
        while (start < text.length) {
            // 断句规则抽至 [SentenceSplitter]（L6）：纯函数、可被 JVM 单测覆盖
            val utterance = SentenceSplitter.next(text, start, finished = status == "finished")
                ?: break // 生成中句子尚未写完，等下一轮轮询
            val trimmed = utterance.trim()
            if (trimmed.isNotEmpty()) {
                speak(trimmed, EdgeTts.Mode.APPEND)
                unspoken.addLast(trimmed)
            }
            start += utterance.length
            advanced = true
        }
        if (advanced) {
            // 只记已读前缀，不记整条（M2）：见 [prevRead] 注释
            prevRead = if (start > 0 && start <= text.length) text.substring(0, start) else null
            spokenLen = start
        }
    }

    /**
     * 把游标回退到尚未播出的正文起点（S4）。
     * FLUSH 会清空队列：若不回退，被清掉的句子既没播过、游标又已越过它们，
     * 这段内容就永久丢失（正文读到一半被台词打断后不再续播）。
     */
    private fun rewindCursor(pendingFromEngine: Int) {
        // Edge 引擎的队列里可能混有固定台词，取「引擎排队数」与「本地未播正文数」的较小值，
        // 只按确实属于正文、且确实被清掉的那些句子回退
        val dropped = minOf(pendingFromEngine, unspoken.size)
        if (dropped <= 0) return
        repeat(dropped) {
            val s = unspoken.removeLast()
            spokenLen = (spokenLen - s.length).coerceAtLeast(0)
        }
        // prevRead 是「已读前缀」，长度必须始终等于 spokenLen（M2）：回退后同步截断，
        // 否则下次会拿更长的旧前缀去比，误判成「换新消息」而整段重读
        val p = prevRead
        prevRead = if (p != null && spokenLen > 0 && spokenLen <= p.length) p.substring(0, spokenLen)
        else null
    }

    /**
     * 播报总入口：按设置分流 Edge 在线语音 / 系统引擎。
     *
     * @param mode 打断语义：
     *  - [EdgeTts.Mode.APPEND]：排队接续，不打断任何在播/排队内容；
     *  - [EdgeTts.Mode.INTERRUPT]：只打断**当前这一句**，保留尚未播出的排队句；
     *  - [EdgeTts.Mode.FLUSH]：清空排队并打断当前（新任务开始 → 遗留队列作废）。
     *  旧实现只有布尔 append，导致「错误插播」与「互动台词」都走 FLUSH——
     *  排队中的正文整队被清掉，用户听到台词后正文再也不续播（见 S4'）。
     *
     * 注意：系统 TextToSpeech 只有 QUEUE_ADD / QUEUE_FLUSH 两态，INTERRUPT 会退化为
     * ADD（保住排队内容，代价是「立即插播」做不到）。三态语义只在 Edge 引擎上完整生效。
     */
    fun speak(text: String, mode: EdgeTts.Mode = EdgeTts.Mode.APPEND) {
        if (!prefs.petTts() || ttsReleased || text.isBlank()) return
        val engine = prefs.ttsEngine()
        val flush = mode == EdgeTts.Mode.FLUSH
        // FLUSH 会清掉尚未播出的排队正文：把游标回退到未播位置，
        // 使这些句子在后续轮询里被重新读出，而不是永久跳过（S4）。
        // 必须在入队前读排队数——此刻读到的正是即将被清掉的那批。
        if (flush) rewindCursor(if (engine == "edge") EdgeTts.pendingCount() else unspoken.size)
        if (engine == "edge") {
            if (!edgeTtsInited) {
                edgeTtsInited = true
                EdgeTts.init(context.applicationContext) { t, fl -> speakSystem(t, fl) }
            }
            EdgeTts.enqueue(text, prefs.ttsEdgeVoice(), mode)
            return
        }
        speakSystem(text, !flush)
    }

    /** 系统 TextToSpeech 播报（含懒初始化与初始化期补播）。 */
    private fun speakSystem(text: String, append: Boolean) {
        if (ttsReleased || text.isBlank()) return
        if (tts == null) {
            pendingQueue.addLast(text)
            tts = TextToSpeech(context) { status ->
                ttsReady = status == TextToSpeech.SUCCESS
                if (ttsReady) {
                    val ok = (tts?.isLanguageAvailable(Locale.CHINA) ?: -1) >= TextToSpeech.LANG_AVAILABLE
                    tts?.setLanguage(if (ok) Locale.CHINA else Locale.getDefault())
                    // 初始化期间积压的句子按序补播（不再只补最后一局）
                    while (pendingQueue.isNotEmpty()) {
                        val p = pendingQueue.removeFirst()
                        try {
                            tts?.speak(p, TextToSpeech.QUEUE_ADD, null, "dsh_pet")
                        } catch (_: Exception) {
                        }
                    }
                } else {
                    pendingQueue.clear()
                }
            }
            return
        }
        if (!ttsReady) {
            pendingQueue.addLast(text)
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
        pendingQueue.clear()
        unspoken.clear()
        spokenLen = 0
        prevRead = null
        if (edgeTtsInited) {
            edgeTtsInited = false
            // 引用计数释放（S2）：仅本持有者退出，不掐断另一个通道正在播的语音
            EdgeTts.release()
        }
        tts?.shutdown()
        tts = null
        ttsReady = false
    }
}
