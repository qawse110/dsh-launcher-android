package com.dsh.launcher.overlay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [PetSpeaker.computeRewind]：FLUSH 打断后的游标回退量（review-r12）。
 *
 * 这个量是「正文被永久跳过」与「重复朗读」两种后果的分界点，此前完全无测试覆盖
 * （它藏在私有方法里，依赖 `unspoken` 队列与 EdgeTts 的排队数）。
 *
 * 为什么值得单测：`unspoken` 记录的是「**已入队**的句子」而非「**尚未播出**的句子」
 * ——句子播完后不会出队（系统 TTS 无逐句完成回调）。因此回退量只能是近似值，
 * 而两个方向的代价**不对称**：
 *   - 多回退 → 已播过的句子再读一遍：烦人，但信息无损；
 *   - 少回退 → 游标越过未播内容：**这段永远不再朗读**，不可恢复。
 * 故实现刻意把误差落在安全侧（宁可重复），测试锁定这一取向，防止后人"优化"成
 * 看似更精确、实则会丢内容的写法。
 *
 * 纯函数（挂在 companion 上，无需构造 PetSpeaker）→ 不碰 android 类，无需 Robolectric。
 */
class PetSpeakerRewindTest {

    private fun rewind(pending: Int, unspoken: Int) =
        PetSpeaker.computeRewind(pendingFromEngine = pending, unspokenCount = unspoken)

    /** 取 min：不超过「引擎排队数」——引擎队列里可能混有固定台词，不能按本地句数全退。 */
    @Test fun `引擎排队数更小时按其回退`() {
        assertEquals(2, rewind(2, 5))
    }

    /** 取 min：不超过「本地未播正文数」——本地只有 3 句正文，就不该退 9 句。 */
    @Test fun `本地未播数更小时按其回退`() {
        assertEquals(3, rewind(9, 3))
    }

    @Test fun `两者相等时原样返回`() {
        assertEquals(4, rewind(4, 4))
    }

    /** 引擎侧为 0（无排队）→ 无需回退。 */
    @Test fun `引擎无排队时不回退`() {
        assertEquals(0, rewind(0, 5))
    }

    /** 本地无未播正文 → 无需回退（被清掉的只是固定台词，不影响正文游标）。 */
    @Test fun `本地未播正文为空时不回退`() {
        assertEquals(0, rewind(5, 0))
    }

    @Test fun `两侧都为空时不回退`() {
        assertEquals(0, rewind(0, 0))
    }

    /** 负数（异常输入）不得产生无中生有的回退。 */
    @Test fun `负值输入按零处理`() {
        assertEquals(0, rewind(-1, 5))
        assertEquals(0, rewind(5, -1))
        assertEquals(0, rewind(-3, -3))
    }

    /**
     * 不变量总览：结果恒落在 [0, min(两侧)]。
     * 用穷举锁定，避免后续改动破坏边界（例如被改成 max、或加上偏移量）。
     */
    @Test fun `穷举锁定不变量 结果不超过任一输入且非负`() {
        for (pending in -2..12) {
            for (unspoken in -2..12) {
                val r = rewind(pending, unspoken)
                assertTrue("结果非负：rewind($pending,$unspoken)=$r", r >= 0)
                assertTrue(
                    "不超过引擎侧：rewind($pending,$unspoken)=$r",
                    r <= pending.coerceAtLeast(0),
                )
                assertTrue(
                    "不超过本地侧：rewind($pending,$unspoken)=$r",
                    r <= unspoken.coerceAtLeast(0),
                )
            }
        }
    }
}
