package com.dsh.nextapp1.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 主界面状态芯片行的排版回归保险。
 *
 * 真机缺陷（361dp 宽竖屏）：环境状态区原本是 `LinearLayout(HORIZONTAL)` +
 * `Gravity.CENTER`，5 枚芯片在「⚠ 授权」态下自然总宽约 415dp，超过可用宽
 * （361 - 20*2 = 321dp）。横向 LinearLayout **不会换行**，`resolveSizeAndState`
 * 把行夹到 321dp，`Gravity.CENTER` 再把 94dp 的缺口均分到两侧 ⇒ 左端
 * x ≈ -47dp。该行位于竖向 ScrollView 内、横向不可滚动，于是最左边的
 * 「Node」芯片整枚落到屏幕外（看不到也点不到），最右边的芯片被右边缘裁掉
 * —— 就是用户说的「显示不全」。
 *
 * 这里锁住 [Ui.FlowPacker] 的不变式：
 *  1. **任何一行都不会超过可用宽**（除非单个子控件本身就超宽）；
 *  2. 子控件顺序与分组稳定，不丢控件；
 *  3. 行高/总高按行累加正确；
 *  4. GONE 的子控件（SKIP）不参与排版。
 */
class UiFlowRowTest {

    private val spacing = 6

    @Test
    fun realDeviceChipRow_wrapsInsteadOfOverflowing() {
        // 361dp 屏 - 20dp*2 内边距 = 321dp 可用宽；以下为 5 枚芯片的实测占宽（dp）。
        val available = 321
        val widths = listOf(57, 69, 80, 91, 102)
        val heights = widths.map { 26 }

        val pack = Ui.FlowPacker.pack(widths, heights, spacing, spacing, available)

        // 旧实现下这一行总宽 415dp > 321dp，首枚芯片被推到负坐标。
        val oldTotal = widths.sum() + spacing * (widths.size - 1)
        assertTrue("前提：旧布局确实会溢出（$oldTotal > $available）", oldTotal > available)

        assertTrue("换行后必须产生多行", pack.rows.size > 1)
        for (row in pack.rows) {
            val rowWidth = row.sumOf { widths[it] } + spacing * (row.size - 1)
            assertTrue(
                "每一行都不能超过可用宽：row=$row width=$rowWidth available=$available",
                rowWidth <= available
            )
        }
        // 所有控件都必须被排进某一行，且保持原有顺序。
        assertEquals(widths.indices.toList(), pack.rows.flatten())
        assertTrue("最宽行也不得超过可用宽", pack.widest <= available)
    }

    @Test
    fun singleRowWhenEverythingFits() {
        val available = 321
        val widths = listOf(50, 60, 70)
        val pack = Ui.FlowPacker.pack(widths, listOf(20, 20, 20), spacing, spacing, available)
        assertEquals("放得下就应当只有一行", 1, pack.rows.size)
        assertEquals(listOf(0, 1, 2), pack.rows[0])
        assertEquals(widths.sum() + spacing * 2, pack.widest)
        assertEquals(20, pack.totalHeight)
    }

    @Test
    fun oversizedSingleChildDoesNotSplitItself() {
        // 单个子控件比可用宽还宽：它自己独占一行（是否压缩由调用方/子控件负责），
        // 排版核心不得因此丢控件或产生空行。
        val pack = Ui.FlowPacker.pack(listOf(500), listOf(30), spacing, spacing, 321)
        assertEquals(1, pack.rows.size)
        assertEquals(listOf(0), pack.rows[0])
    }

    @Test
    fun goneChildrenAreSkipped() {
        val widths = listOf(100, Ui.FlowPacker.SKIP, 100)
        val heights = listOf(20, 0, 20)
        val pack = Ui.FlowPacker.pack(widths, heights, spacing, spacing, 321)
        assertEquals(1, pack.rows.size)
        assertEquals("GONE 的子控件不应出现在任何一行", listOf(0, 2), pack.rows[0])
    }

    @Test
    fun lineSpacingCountedBetweenRowsOnly() {
        val widths = listOf(200, 200)
        val pack = Ui.FlowPacker.pack(widths, listOf(10, 20), spacing, 4, 321)
        assertEquals(2, pack.rows.size)
        // 两行：10 + 20，行间再加一次 lineSpacing（4）。
        assertEquals(34, pack.totalHeight)
        assertEquals(listOf(10, 20), pack.rowHeights)
    }
}
