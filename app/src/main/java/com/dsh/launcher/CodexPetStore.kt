package com.dsh.launcher

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Environment
import org.json.JSONObject
import java.io.File
import java.io.InputStream

/**
 * Codex 桌宠包加载器。
 *
 * 兼容 Codex Pet Contract（awesome-codex-pet / petdex 桌宠格式）：
 * 每个桌宠是一个目录，内含 pet.json（id / displayName / description / spritesheetPath）
 * 与精灵表 spritesheet.webp 或 .png（v1：1536x1872，8 列 x 9 行，单元格 192x208；
 * v2：1536x2288，8 列 x 11 行，前 9 行动画布局相同）。
 *
 * 搜索顺序：
 * 1. 应用私有目录 filesDir/codex-pets/<id>/（导入的桌宠包放这里）；
 * 2. 共享目录 /sdcard/Download/DshLauncher/codex-pets/<id>/（文件管理器直接拷贝）；
 * 3. 内置默认桌宠 assets/codex-pets/default/（Codex 格式，兜底始终可用）。
 */
data class CodexPetInfo(
    val id: String,
    val displayName: String,
    val description: String,
    val source: PetSource
)

sealed class PetSource {
    object BundledDefault : PetSource()
    data class Folder(val dir: File) : PetSource()
}

/** 解码后的精灵表（已按屏幕密度采样），cellW/cellH 为采样后的单元格尺寸。 */
class CodexPetAtlas(val bitmap: Bitmap, val cellW: Int, val cellH: Int) {
    val rows: Int get() = if (cellH > 0) bitmap.height / cellH else 0
}

object CodexPetStore {

    const val DEFAULT_PET_ID = "dsh-default"
    const val DIR_NAME = "codex-pets"
    const val BUNDLED_DIR = "codex-pets/default"

    fun defaultPet(): CodexPetInfo = CodexPetInfo(
        id = DEFAULT_PET_ID,
        displayName = "小豆丁",
        description = "DshLauncher 内置默认桌宠（Codex 桌宠格式）",
        source = PetSource.BundledDefault
    )

    /** 扫描全部可用桌宠：私有目录 + 共享目录 + 内置默认。同 id 时用户包优先。 */
    fun scanPets(context: Context): List<CodexPetInfo> {
        val found = LinkedHashMap<String, CodexPetInfo>()
        scanDir(File(context.filesDir, DIR_NAME), found)
        try {
            val shared = File(
                Environment.getExternalStorageDirectory(),
                "Download/DshLauncher/$DIR_NAME"
            )
            scanDir(shared, found)
        } catch (_: Exception) {
            // 共享目录不可读时忽略
        }
        val list = found.values.toMutableList()
        if (list.none { it.id == DEFAULT_PET_ID }) list.add(0, defaultPet())
        return list
    }

    private fun scanDir(dir: File, out: LinkedHashMap<String, CodexPetInfo>) {
        if (!dir.isDirectory) return
        val children = dir.listFiles() ?: return
        for (child in children) {
            if (!child.isDirectory) continue
            val meta = readMeta(child) ?: continue
            val id = meta.optString("id").ifBlank { child.name }
            if (out.containsKey(id)) continue
            out[id] = CodexPetInfo(
                id = id,
                displayName = meta.optString("displayName").ifBlank { id },
                description = meta.optString("description"),
                source = PetSource.Folder(child)
            )
        }
    }

    /** 读取目录中的 pet.json，失败返回 null。 */
    fun readMeta(dir: File): JSONObject? = try {
        val f = File(dir, "pet.json")
        if (!f.isFile) null else JSONObject(f.readText())
    } catch (e: Exception) {
        null
    }

    /** 打开精灵表（按目标显示尺寸采样解码），失败返回 null。 */
    fun openAtlas(context: Context, pet: CodexPetInfo): CodexPetAtlas? {
        return try {
            openSheetStream(context, pet)?.use { first ->
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeStream(first, null, bounds)
                if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
                val baseCellW: Int
                val baseCellH: Int
                if (bounds.outWidth == 1536 && (bounds.outHeight == 1872 || bounds.outHeight == 2288)) {
                    baseCellW = 192
                    baseCellH = 208
                } else {
                    baseCellW = bounds.outWidth / 8
                    baseCellH = bounds.outHeight / 9
                }
                if (baseCellW <= 0 || baseCellH <= 0) return null
                // 采样使解码后的单元格像素数不低于目标显示尺寸，控制内存占用
                val targetPx = (context.resources.displayMetrics.density * 132f).toInt()
                var sample = 1
                while (sample * 2 <= 16 && bounds.outWidth / (sample * 2) >= targetPx) {
                    sample *= 2
                }
                openSheetStream(context, pet)?.use { second ->
                    val opts = BitmapFactory.Options().apply {
                        inSampleSize = sample
                        inPreferredConfig = Bitmap.Config.ARGB_8888
                    }
                    val bmp = BitmapFactory.decodeStream(second, null, opts) ?: return null
                    // v1/v2 均按采样后的基准单元格尺寸计算，避免 8x11（v2）表按 height/9 错切
                    CodexPetAtlas(bmp, baseCellW / sample, baseCellH / sample)
                }
            }
        } catch (e: Exception) {
            null
        }
    }

    private fun openSheetStream(context: Context, pet: CodexPetInfo): InputStream? {
        return when (val src = pet.source) {
            is PetSource.BundledDefault -> {
                try {
                    val meta = JSONObject(
                        context.assets.open("$BUNDLED_DIR/pet.json")
                            .bufferedReader().use { it.readText() }
                    )
                    val path = meta.optString("spritesheetPath", "spritesheet.png")
                    context.assets.open("$BUNDLED_DIR/$path")
                } catch (e: Exception) {
                    null
                }
            }
            is PetSource.Folder -> {
                val meta = readMeta(src.dir)
                val path = meta?.optString("spritesheetPath", "spritesheet.webp") ?: "spritesheet.webp"
                val file = when {
                    File(src.dir, path).isFile -> File(src.dir, path)
                    File(src.dir, "spritesheet.webp").isFile -> File(src.dir, "spritesheet.webp")
                    File(src.dir, "spritesheet.png").isFile -> File(src.dir, "spritesheet.png")
                    else -> null
                }
                file?.inputStream()
            }
        }
    }
}
