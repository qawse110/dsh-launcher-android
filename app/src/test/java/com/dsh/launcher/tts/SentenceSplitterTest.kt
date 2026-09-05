package com.dsh.launcher.tts

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 正文断句器回归（L6）：这是 TTS 播报的核心算法，历史上「改一个坏一个」
 * （1b65bfb / 9b952b5 / 580fb0c / b209f5f / ef8ee2b / 6adbe63 六连修），
 * 抽成纯函数后用 JVM 单测锁住行为。
 */
class SentenceSplitterTest {

    // ── 句界 ────────────────────────────────────────────

    @Test fun `中文句号截断，含句号本身`() {
        assertEquals("你好。", SentenceSplitter.next("你好。世界", 0, finished = false))
    }

    @Test fun `多句文本一次读到最后一个句界`() {
        // 窗口语义：读到窗口内「最后一个」句界——160 字内有多句就一次多读几句，
        // 与原实现一致（单测锁住该行为，防止日后误改成逐句读）
        assertEquals(
            "第一句。第二句！第三句？",
            SentenceSplitter.next("第一句。第二句！第三句？", 0, finished = false)
        )
    }

    @Test fun `英文问号与分号也是句界`() {
        assertEquals("ok? yes;", SentenceSplitter.next("ok? yes; more", 0, finished = false))
    }

    @Test fun `省略号是句界`() {
        assertEquals("等等……", SentenceSplitter.next("等等……然后", 0, finished = false))
    }

    @Test fun `换行是句界`() {
        assertEquals("第一行\n", SentenceSplitter.next("第一行\n第二行", 0, finished = false))
    }

    // ── 游标推进 ────────────────────────────────────────

    @Test fun `从游标处续读`() {
        val text = "第一句。第二句。"
        assertEquals("第二句。", SentenceSplitter.next(text, 4, finished = false))
    }

    @Test fun `游标到末尾返回 null`() {
        assertNull(SentenceSplitter.next("完了。", 3, finished = false))
        assertNull(SentenceSplitter.next("完了。", 10, finished = false))
    }

    // ── 生成中 vs 已完成 ────────────────────────────────

    @Test fun `生成中且尾巴无句界：等待不硬读`() {
        assertNull(SentenceSplitter.next("生成到一半的句子", 0, finished = false))
    }

    @Test fun `已完成且尾巴无句界：整个尾巴读出（短答兜底）`() {
        assertEquals("好的", SentenceSplitter.next("好的", 0, finished = true))
    }

    @Test fun `已完成且尾巴超窗：仍按超窗规则软切而非整读`() {
        val long = "x".repeat(200)
        // 200 字无任何句界/软标点 → 硬切到 160
        assertEquals(160, SentenceSplitter.next(long, 0, finished = true)!!.length)
    }

    // ── 超窗兜底 ────────────────────────────────────────

    @Test fun `超窗无句界且无软标点：硬切 160`() {
        val long = "a".repeat(300)
        assertEquals(160, SentenceSplitter.next(long, 0, finished = false)!!.length)
    }

    @Test fun `超窗有软标点：在软标点处切且切点越过最短长度`() {
        val long = "短，" + "b".repeat(150) + "，" + "c".repeat(50)
        val out = SentenceSplitter.next(long, 0, finished = false)!!
        // 第一个软标点在位置 1（<40 不可切），第二个在 152（>40 可切）
        assertEquals(long.substring(0, 153), out)
    }

    @Test fun `软标点过近则硬切而非切出碎片`() {
        // 输入须超过 160 字才会走超窗分支：4 字前缀 + 160 个 d = 164 字
        val long = "好，好，" + "d".repeat(160)
        val out = SentenceSplitter.next(long, 0, finished = false)!!
        assertEquals(160, out.length)
    }

    @Test fun `逗号也算软标点`() {
        val long = "e".repeat(100) + "，" + "f".repeat(100)
        val out = SentenceSplitter.next(long, 0, finished = false)!!
        assertEquals(101, out.length)
    }

    // ── 不变量：切块拼接覆盖原文、无重叠无遗漏 ────────────

    @Test fun `连续切块覆盖全文且游标单调前进`() {
        val text = buildString {
            repeat(40) { append("第${it}句，内容较长一些用于触发软标点兜底。\n") }
        }
        var cursor = 0
        val pieces = mutableListOf<String>()
        while (cursor < text.length) {
            val piece = SentenceSplitter.next(text, cursor, finished = true) ?: break
            assertTrue("切出空块", piece.isNotEmpty())
            assertTrue("切块超出原文边界", cursor + piece.length <= text.length)
            assertEquals("切块必须与原文在游标处对齐", text.substring(cursor, cursor + piece.length), piece)
            pieces.add(piece)
            cursor += piece.length
        }
        assertEquals("全部内容必须被读完", text.length, cursor)
        assertTrue("应切出多块", pieces.size > 5)
        // 拼接还原原文（忽略 trim 掉的空白由调用方处理，这里按原样拼接）
        assertEquals(text, pieces.joinToString(""))
    }

    @Test fun `纯空格与空白文本返回 null 或原样`() {
        assertNull(SentenceSplitter.next("", 0, finished = true))
        // 空白尾巴会原样返回：调用方 trim 后发现为空会跳过入队，但游标照常推进
        // （不推进就会死循环），这是有意的契约而非缺陷
        assertEquals("   ", SentenceSplitter.next("   ", 0, finished = true))
    }
}
