package com.dsh.launcher.tts

/**
 * 正文逐句断句器（L6）：把 [PetSpeaker.speakContent] 的「从游标处切出下一段可播文本」
 * 逻辑抽成纯函数，脱离 Android 依赖，可被 JVM 单测覆盖。
 *
 * 规则与原实现一致：
 * - 句界（[SENTENCE_END]）优先：凑齐一句即返回；
 * - 积压超限（> [MAX_WINDOW]）仍无句界时按软标点（且切点必须越过 [MIN_HARD_CUT]）兜底，
 *   再不行硬切到 [MAX_WINDOW]；
 * - 尾巴无句界时：`finished=true` 读完整尾巴（短答兜底），否则等待更多文本（返回 null）。
 */
object SentenceSplitter {

    /** 单次朗读上限：超过则按软标点/硬切兜底。 */
    const val MAX_WINDOW = 160

    /** 软标点切点的最小长度：避免切出「好的，」这种过短的碎片。 */
    const val MIN_HARD_CUT = 40

    /** 句界标点：。！？!?…；; 与换行。 */
    private val SENTENCE_END = Regex("[。！？!?…；;]|\\n")

    /** 软标点：句界缺失时的次级断句依据。 */
    val SOFT_PUNCTS = charArrayOf('，', ',', '、', '：', ':', ' ')

    /**
     * 从 [text] 的 [start] 偏移处切出下一段可朗读文本。
     *
     * @param finished 任务是否已完成：完成时允许把无句界的尾巴整个读出。
     * @return 切出的文本（不含游标推进），无完整句可读时返回 null（调用方应等待下一轮）。
     */
    fun next(text: String, start: Int, finished: Boolean): String? {
        if (start >= text.length) return null
        val remain = text.substring(start)
        val window = remain.substring(0, minOf(remain.length, MAX_WINDOW))
        val ends = SENTENCE_END.findAll(window).toList()
        return when {
            ends.isNotEmpty() -> window.substring(0, ends.last().range.last + 1)
            remain.length > MAX_WINDOW -> {
                // 积压超限仍无句界：软标点兜底断句，再不行硬切
                val softIdx = window.lastIndexOfAny(SOFT_PUNCTS)
                if (softIdx > MIN_HARD_CUT) window.substring(0, softIdx + 1) else window
            }
            finished -> window
            else -> null // 生成中句子尚未写完，等下一轮轮询
        }
    }
}
