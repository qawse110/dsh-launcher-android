package com.dsh.launcher.core

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * [BridgeStatus]：插件 `/status` 契约的解析测试。
 *
 * 该 JSON 是**插件 ↔ 壳侧跨进程契约**，此前壳侧两处各自手写解析（字段名与默认值
 * 散落在四处字面量）。集中后本测试锁定兼容性约定，插件加字段/壳侧改默认值时
 * 会在此暴露。
 *
 * **必须带 Robolectric runner**：`app/build.gradle.kts` 设了
 * `unitTests.isReturnDefaultValues = true`，纯 JVM 测试下 `org.json.JSONObject`
 * 是被桩掉的 android 类（方法返回默认值）→ 随后任何 `optXxx` 都抛
 * `NullPointerException`。CI 实测：7 个用例全挂在 `JSONObject(...)` 那一行。
 * Robolectric 提供 android-all 的真实实现，解析语义才等于线上语义。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class BridgeStatusTest {

    @Test fun `完整响应按字段解析`() {
        val st = BridgeStatus.parse(
            JSONObject(
                """{"status":"running","lastText":"正在生成","lastEvent":"tool/call",
                   "updatedAt":1788673793811,"toolName":"read_file"}""",
            ),
        )
        assertEquals("running", st.status)
        assertEquals("正在生成", st.text)
        assertEquals("tool/call", st.event)
        assertEquals(1788673793811L, st.updatedAt)
        assertEquals("read_file", st.toolName)
    }

    @Test fun `空响应取默认值（旧插件或未开始）`() {
        val st = BridgeStatus.parse(JSONObject("{}"))
        assertEquals("idle", st.status)
        assertEquals("", st.text)
        assertNull("缺 lastEvent 必须是 null 而非空串（调用方据 null 走回退文案）", st.event)
        assertEquals(0L, st.updatedAt)
        assertNull(st.toolName)
    }

    /**
     * `optString(key, null)` 在**键存在但值为 JSON null** 时返回字面量 `"null"`——
     * 这是 JSONObject 的经典陷阱，会让下游把 `"null"` 当成真实事件名。
     */
    @Test fun `JSON null 不得被解析成字符串 null`() {
        val st = BridgeStatus.parse(JSONObject("""{"lastEvent":null,"toolName":null}"""))
        assertNull("JSON null 必须映射为 Kotlin null，而不是字面量 \"null\"", st.event)
        assertNull(st.toolName)
    }

    @Test fun `空串等同于缺失（避免下游拿到无意义空事件名）`() {
        val st = BridgeStatus.parse(JSONObject("""{"lastEvent":"","toolName":""}"""))
        assertNull(st.event)
        assertNull(st.toolName)
    }

    @Test fun `未知 status 原样保留（由壳侧决定如何展示）`() {
        // 插件将来可能新增终态；解析层不做白名单，避免新状态被静默改写
        val st = BridgeStatus.parse(JSONObject("""{"status":"brand-new"}"""))
        assertEquals("brand-new", st.status)
    }

    /**
     * 类型不匹配时**必须降级而非抛异常**——探测契约要求失败即 null/默认值，
     * 异常会打死轮询线程。
     *
     * 注意：这里不断言具体的降级结果。Android `org.json` 的 `optString` 会把非字符串
     * 值经 `JSON.toString` 转写（`{status:123}` → `"123"`）而非回落 fallback，
     * 该细节无法在本开发环境实测（设备无 JDK/jar）。本测试只锁定**不抛异常**
     * 这一必要不变量，避免把未经验证的语义写进断言。
     */
    /**
     * 类型不匹配时**必须降级而非抛异常**——探测契约要求失败即 null/默认值，
     * 异常会打死轮询线程（这是本测试真正要锁定的不变量：解析本身不炸）。
     *
     * 刻意**不**断言 `status` 经 `optString` 转写后的具体取值（org.json 会把非字符串
     * 经 `JSON.toString` 转写，属实现细节）；改为断言**未提供的字段仍走默认值**——
     * 这一点不受其它字段类型错误影响，是真正有意义的契约。
     */
    @Test fun `type 不匹配时不抛异常且未提供字段走默认值`() {
        val st = BridgeStatus.parse(JSONObject("""{"status":123,"updatedAt":"abc"}"""))
        assertEquals("未提供的 lastText 取默认空串", "", st.text)
        assertNull("未提供的 lastEvent 为 null", st.event)
        assertNull("未提供的 toolName 为 null", st.toolName)
    }

    @Test fun `IDLE 常量与空响应解析结果一致`() {
        val parsed = BridgeStatus.parse(JSONObject("{}"))
        assertEquals(BridgeStatus.IDLE, parsed)
    }
}

/** [LocalHttp]：探测语义（失败一律 null/false，不抛给轮询线程）。 */
class LocalHttpTest {

    @Test fun `未监听端口返回 false 而不抛异常`() {
        // 高位端口极可能空闲；关键是**不抛异常**——调用方是轮询线程
        assertTrue(
            "未监听端口必须返回 false",
            !LocalHttp.responds(59999, timeoutMs = 200),
        )
    }

    @Test fun `非法 URL 返回 null 而不抛异常`() {
        assertNull(LocalHttp.getText("not-a-url", timeoutMs = 200))
        assertNull(LocalHttp.getText("http://127.0.0.1:59999/", timeoutMs = 200))
    }

    @Test fun `JSON 读取失败返回 null`() {
        assertNull(LocalHttp.getJson("http://127.0.0.1:59999/status", timeoutMs = 200))
    }

    @Test fun `默认超时为本机轮询设计的固定值`() {
        assertEquals(800, LocalHttp.DEFAULT_TIMEOUT_MS)
    }
}
