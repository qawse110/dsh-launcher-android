package com.dsh.launcher.core

import android.content.Context
import java.io.File
import org.json.JSONObject

/**
 * 统一 marker 状态存储（架构方案 P1-4 收尾）。
 *
 * 取代散落在 filesDir 根的 6 个点文件（.termux-ok / .node-ok / .prebuilt-ok /
 * .extra-plugins-ok / .harness-tools-ok / .stub-applied），收敛为
 * files/state/markers.json 单文件，原子写（tmp+rename），进程内缓存。
 *
 * 首次访问时执行一次性旧导入：读取旧点文件内容入映射后删除原文件，
 * 保证升级设备无双重真源。键名即语义：termux/node/prebuilt/
 * extra-plugins/harness-tools/stub-applied。
 */
object MarkerStore {

    private const val DIR = "state"
    private const val FILE = "markers.json"

    private val lock = Any()
    @Volatile private var loaded = false
    private val map = mutableMapOf<String, String>()

    fun get(ctx: Context, key: String): String? {
        load(ctx)
        synchronized(lock) { return map[key] }
    }

    fun has(ctx: Context, key: String): Boolean = get(ctx, key) != null

    fun put(ctx: Context, key: String, value: String) {
        load(ctx)
        synchronized(lock) {
            map[key] = value
            persist(ctx)
        }
    }

    fun remove(ctx: Context, key: String) {
        load(ctx)
        synchronized(lock) {
            if (map.remove(key) != null) persist(ctx)
        }
    }

    /** 仅供单元测试：清空进程内缓存与加载标记，下个访问重新从盘加载。 */
    internal fun resetForTest() {
        synchronized(lock) {
            loaded = false
            map.clear()
        }
    }

    // ---------------- 内部 ----------------

    private fun storeFile(ctx: Context) = File(File(ctx.filesDir, DIR), FILE)

    private fun load(ctx: Context) {
        if (loaded) return
        synchronized(lock) {
            if (loaded) return
            val f = storeFile(ctx)
            map.clear()
            if (f.isFile) {
                runCatching {
                    val obj = JSONObject(f.readText())
                    for (k in obj.keys()) map[k] = obj.optString(k)
                }
            } else {
                // 首代：导入旧散落 marker 并删除原文件（单一真源）
                map.putAll(legacyImport(ctx))
                runCatching { persist(ctx) }
            }
            loaded = true
        }
    }

    private fun legacyImport(ctx: Context): Map<String, String> {
        val out = mutableMapOf<String, String>()
        fun take(legacyName: String, key: String) {
            runCatching {
                val f = File(ctx.filesDir, legacyName)
                if (f.isFile) {
                    out[key] = f.readText().trim()
                    f.delete()
                }
            }
        }
        take(".termux-ok", "termux")
        take(".node-ok", "node")
        take(".prebuilt-ok", "prebuilt")
        take(".extra-plugins-ok", "extra-plugins")
        take(".harness-tools-ok", "harness-tools")
        take(".stub-applied", "stub-applied")
        return out
    }

    private fun persist(ctx: Context) {
        runCatching {
            val dir = File(ctx.filesDir, DIR)
            dir.mkdirs()
            val tmp = File(dir, "$FILE.tmp")
            tmp.writeText(JSONObject(map.toMap()).toString())
            val dst = File(dir, FILE)
            dst.delete()
            tmp.renameTo(dst)
        }
    }
}
