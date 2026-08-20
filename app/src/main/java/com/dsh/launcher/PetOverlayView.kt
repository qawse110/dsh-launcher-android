package com.dsh.launcher

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.view.View

/**
 * Codex 桌宠动画视图：从 8x9（或 8x11）精灵表按行播放帧。
 * 行索引与 Codex Pet Contract 完全一致：
 *   0 idle / 1 running-right / 2 running-left / 3 waving / 4 jumping
 *   5 failed / 6 waiting / 7 running / 8 review
 *
 * 循环策略（依据官方 animation-rows.md 的行语义）：
 * - 常驻状态行（idle / running-* / waiting / running / review / failed）在状态持续期间循环；
 * - 一次性表演行（waving / jumping）播完一轮后**落地回 idle** 继续呼吸，
 *   同一动作不重播，直到状态换行（例如下一轮任务完成才再次跳跃庆祝）。
 */
class PetOverlayView(context: Context, private val atlas: CodexPetAtlas) : View(context) {

    companion object {
        const val ROW_IDLE = 0
        const val ROW_RUNNING_RIGHT = 1
        const val ROW_RUNNING_LEFT = 2
        const val ROW_WAVING = 3
        const val ROW_JUMPING = 4
        const val ROW_FAILED = 5
        const val ROW_WAITING = 6
        const val ROW_RUNNING = 7
        const val ROW_REVIEW = 8

        /** 常驻循环行：状态持续期间一直循环（规范语义 loop / idle variant）。 */
        private val LOOP_ROWS: Set<Int> = setOf(
            ROW_IDLE, ROW_RUNNING_RIGHT, ROW_RUNNING_LEFT,
            ROW_FAILED, ROW_WAITING, ROW_RUNNING, ROW_REVIEW
        )

        /** 每行动画帧时长（ms），取自 Codex 规范 animation-rows.md。 */
        private val ROW_DURATIONS: Map<Int, IntArray> = mapOf(
            ROW_IDLE to intArrayOf(280, 110, 110, 140, 140, 320),
            ROW_RUNNING_RIGHT to intArrayOf(120, 120, 120, 120, 120, 120, 120, 220),
            ROW_RUNNING_LEFT to intArrayOf(120, 120, 120, 120, 120, 120, 120, 220),
            ROW_WAVING to intArrayOf(140, 140, 140, 280),
            ROW_JUMPING to intArrayOf(140, 140, 140, 140, 280),
            ROW_FAILED to intArrayOf(140, 140, 140, 140, 140, 140, 140, 240),
            ROW_WAITING to intArrayOf(150, 150, 150, 150, 150, 260),
            ROW_RUNNING to intArrayOf(120, 120, 120, 120, 120, 220),
            ROW_REVIEW to intArrayOf(150, 150, 150, 150, 150, 280)
        )

        /** dsh 状态/事件 → 桌宠动画行。 */
        fun actionRowFor(status: String, event: String?): Int = when {
            status == "failed" || event == "error" || event?.contains("fail", true) == true ->
                ROW_FAILED
            status == "finished" -> ROW_JUMPING
            status == "running" -> when (event) {
                "tool/call" -> ROW_RUNNING
                "assistant/message" -> ROW_WAITING
                "turn/start" -> ROW_REVIEW
                else -> ROW_REVIEW
            }
            else -> ROW_IDLE
        }
    }

    private val paint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG)
    private val srcRect = Rect()
    private val dstRect = Rect()
    private val handler = Handler(Looper.getMainLooper())

    private var row = ROW_IDLE
    private var col = 0
    private var playing = false
    /** 已表演完成的一次性动作行（waving/jumping）：落地回 idle 后不重播，直到换行。 */
    private var settledRow = -1

    /** 最近表演的一次性动作所对应的状态键；互动挥手（null 键）不清除它。 */
    private var lastOneShotKey: String? = null

    private val ticker = object : Runnable {
        override fun run() {
            if (!playing) return
            val count = frameCount(row)
            col = (col + 1) % count
            if (col == 0 && settledRow == row) {
                // 一次性动作播完一轮：落地回 idle 继续呼吸，等待下一次换行再表演
                row = ROW_IDLE
                col = 0
                invalidate()
                handler.postDelayed(this, frameDuration(row, 0))
                return
            }
            invalidate()
            handler.postDelayed(this, frameDuration(row, col))
        }
    }

    /**
     * 切换动画行（动作）：循环行持续循环；一次性动作（waving/jumping）播完一轮落地回 idle。
     *
     * @param stateKey 状态键（由桥接层传入 status|event）：一次性动作在同一状态键下
     *                 只表演一次——用户互动（挥手）打断跳跃后，轮询不会把它重播。
     *                 传 null（互动/待机挥手等）不参与去重，总是可表演。
     */
    fun play(row: Int, stateKey: String? = null) {
        val safeRow = row.coerceIn(0, maxRow())
        if (playing && safeRow == this.row) {
            // 已在该行：若回到常驻行则重新武装一次性动作（落地后再次换行可再表演）
            if (safeRow in LOOP_ROWS) settledRow = -1
            return
        }
        if (safeRow !in LOOP_ROWS && settledRow == safeRow) return // 同一一次性动作已表演过
        if (safeRow !in LOOP_ROWS && stateKey != null && lastOneShotKey == stateKey) return
        if (safeRow !in LOOP_ROWS && stateKey != null) lastOneShotKey = stateKey
        this.row = safeRow
        col = 0
        settledRow = if (safeRow !in LOOP_ROWS) safeRow else -1
        invalidate()
        handler.removeCallbacks(ticker)
        handler.postDelayed(ticker, frameDuration(safeRow, 0))
    }

    fun stop() {
        playing = false
        handler.removeCallbacks(ticker)
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        if (!playing) {
            playing = true
            handler.removeCallbacks(ticker)
            handler.postDelayed(ticker, frameDuration(row, col))
        }
    }

    override fun onDetachedFromWindow() {
        stop()
        super.onDetachedFromWindow()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val w = width
        val h = height
        if (w <= 0 || h <= 0 || atlas.cellW <= 0 || atlas.cellH <= 0) return
        val durations = ROW_DURATIONS[row] ?: ROW_DURATIONS[ROW_IDLE] ?: return
        val idx = col % durations.size
        srcRect.set(
            idx * atlas.cellW,
            row * atlas.cellH,
            (idx + 1) * atlas.cellW,
            (row + 1) * atlas.cellH
        )
        dstRect.set(0, 0, w, h)
        canvas.drawBitmap(atlas.bitmap, srcRect, dstRect, paint)
    }

    private fun frameCount(row: Int): Int =
        (ROW_DURATIONS[row] ?: ROW_DURATIONS[ROW_IDLE])?.size ?: 1

    private fun frameDuration(row: Int, col: Int): Long {
        val durations = ROW_DURATIONS[row] ?: ROW_DURATIONS[ROW_IDLE] ?: return 150L
        return durations[col % durations.size].toLong()
    }

    private fun maxRow(): Int = (atlas.rows - 1).coerceAtLeast(0)
}
