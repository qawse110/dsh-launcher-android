package com.dsh.nextapp1.ui

import android.content.Context
import android.view.View
import android.view.ViewGroup
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * [Ui.FlowRowLayout] 的**真实测量/布局**回归保险（驱动 onMeasure/onLayout，而非只测纯函数）。
 *
 * 背景：主界面「环境状态」芯片行原为 LinearLayout(HORIZONTAL) + Gravity.CENTER。
 * 横向 LinearLayout **不会换行**，5 枚芯片在「⚠ 授权」态下自然总宽约 423dp，超过
 * 361dp 屏的可用宽（361 - 20*2 = 321dp）后：行被 resolveSizeAndState 夹到 321dp，
 * Gravity.CENTER 再把 102dp 缺口**均分到两侧** ⇒ 左端 x ≈ -51dp。该行位于竖向
 * ScrollView 内、横向不可滚动，于是最左的「Node」芯片整枚落到屏外（看不到也点不到）、
 * 最右芯片被右边缘裁掉 —— 即用户报的「显示不全」。
 *
 * 这里用**固定尺寸**的子控件（而不是 TextView）来驱动布局：Robolectric 的字体度量
 * 与真机不同，用固定宽度才能确定性地复现真机占宽、避免测试随字体实现漂移。
 * 数值直接取真机实测的芯片占宽（dp→px 同值），可用宽取 321px。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class UiFlowRowLayoutTest {

    private val ctx: Context = ApplicationProvider.getApplicationContext()

    /** 真机 RMX3888：1264x2780 @560dpi ≈ 361dp；减 buildUi 左右各 20dp = 321dp。 */
    private val realAvailable = 321

    /** 真机实测占宽（px，与 dp 同值）：授权态 / 警告态。 */
    private val grantedWidths = listOf(57, 69, 54, 65, 65)
    private val warnedWidths = listOf(57, 69, 80, 91, 102)
    private val chipHeight = 26

    /** 按给定可用宽真实测量并布局一行（子控件为固定尺寸，保证确定性）。 */
    private fun buildRow(available: Int, widths: List<Int>): Ui.FlowRowLayout {
        val row = Ui.flowRowLayout(ctx)
        for (w in widths) {
            row.addView(View(ctx).apply {
                layoutParams = ViewGroup.MarginLayoutParams(w, chipHeight)
            })
        }
        row.measure(
            View.MeasureSpec.makeMeasureSpec(available, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED)
        )
        row.layout(0, 0, row.measuredWidth, row.measuredHeight)
        return row
    }

    /** 断言：容器不超宽，且每个子控件都完整落在内容区内（「显示不全」的直接反面）。 */
    private fun assertAllChildrenInside(row: Ui.FlowRowLayout, available: Int, where: String) {
        assertTrue(where + ": 容器宽 " + row.measuredWidth + " 不得超过可用宽 " + available,
            row.measuredWidth <= available)
        for (i in 0 until row.childCount) {
            val c = row.getChildAt(i)
            assertTrue(where + ": 子控件 #" + i + " 左边界 " + c.left + " 不得为负", c.left >= 0)
            assertTrue(where + ": 子控件 #" + i + " 右边界 " + c.right + " 不得超过 " + available,
                c.right <= available)
            assertTrue(where + ": 子控件 #" + i + " 必须有尺寸", c.width > 0 && c.height > 0)
        }
    }

    @Test
    fun realDeviceWidth_warnedState_allChipsStayInside() {
        // 修复前：该行总宽 423px > 321px，首枚芯片 x = (321-423)/2 = -51。
        val oldTotal = warnedWidths.sum() + 6 * (warnedWidths.size - 1)
        assertTrue("前提：旧布局确实溢出（" + oldTotal + " > " + realAvailable + "）",
            oldTotal > realAvailable)

        val row = buildRow(realAvailable, warnedWidths)
        assertAllChildrenInside(row, realAvailable, "361dp屏/警告态")
        assertEquals("子控件不得丢失", warnedWidths.size, row.childCount)
    }

    @Test
    fun realDeviceWidth_grantedState_allChipsStayInside() {
        val row = buildRow(realAvailable, grantedWidths)
        assertAllChildrenInside(row, realAvailable, "361dp屏/授权态")
        assertEquals("子控件不得丢失", grantedWidths.size, row.childCount)
    }

    @Test
    fun warnedState_wrapsToMultipleRows() {
        val row = buildRow(realAvailable, warnedWidths)
        val tops = (0 until row.childCount).map { row.getChildAt(it).top }.distinct()
        assertTrue("警告态在窄屏下必须换行（多个不同 top 值），实际 tops=" + tops, tops.size > 1)
    }

    @Test
    fun narrowWidths_neverPushChildrenOffScreen() {
        for (screenDp in listOf(320, 360, 361, 411, 480)) {
            val available = screenDp - 40
            for (widths in listOf(grantedWidths, warnedWidths)) {
                val row = buildRow(available, widths)
                assertAllChildrenInside(row, available, screenDp.toString() + "dp屏")
            }
        }
    }

    @Test
    fun fitsInOneRow_whenNarrowEnough() {
        // 足够宽时必须仍是单行（不引入无谓换行、保持原有观感）。
        val row = buildRow(600, grantedWidths)
        val tops = (0 until row.childCount).map { row.getChildAt(it).top }.distinct()
        assertEquals("放得下就应保持单行", 1, tops.size)
        assertAllChildrenInside(row, 600, "600dp屏")
    }

    @Test
    fun goneChildrenAreNotLaidOut() {
        val row = Ui.flowRowLayout(ctx)
        val visible = View(ctx).apply { layoutParams = ViewGroup.MarginLayoutParams(80, 26) }
        val gone = View(ctx).apply {
            layoutParams = ViewGroup.MarginLayoutParams(200, 26)
            visibility = View.GONE
        }
        row.addView(visible)
        row.addView(gone)
        row.measure(
            View.MeasureSpec.makeMeasureSpec(realAvailable, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED)
        )
        row.layout(0, 0, row.measuredWidth, row.measuredHeight)
        assertEquals("GONE 子控件不参与布局（left 保持 0）", 0, gone.left)
        assertEquals("GONE 子控件不参与布局（top 保持 0）", 0, gone.top)
        assertEquals("容器只按可见子控件撑高", 26, row.measuredHeight)
    }

    @Test
    fun oversizedFixedWidthChild_isClampedInside() {
        // 固定宽度（非 WRAP_CONTENT）的子控件不受父级 AT_MOST 约束，会原样溢出。
        // 容器必须把它压回可用宽内，否则「不越出屏幕」就不是无条件成立的。
        val row = Ui.flowRowLayout(ctx)
        row.addView(View(ctx).apply { layoutParams = ViewGroup.MarginLayoutParams(80, 26) })
        row.addView(View(ctx).apply { layoutParams = ViewGroup.MarginLayoutParams(500, 26) })
        row.measure(
            View.MeasureSpec.makeMeasureSpec(realAvailable, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED)
        )
        row.layout(0, 0, row.measuredWidth, row.measuredHeight)
        assertAllChildrenInside(row, realAvailable, "固定超宽子控件")
    }
}
