package com.dsh.launcher.ui

import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.color.DynamicColors
import kotlin.concurrent.thread
import com.dsh.launcher.core.*
import com.dsh.launcher.service.*
import com.dsh.launcher.R

/**
 * 备份与恢复 —— dsh 数据 / 启动器配置 / 插件目录 的一键存档与回档。
 *
 * 页面结构：
 * ┌ 头部：标题 + 存储位置 pill（共享/私有回退）
 * ├ 备份卡：三项勾选（dsh 数据 / 启动器配置 / 插件）+ 预估体积 + 进度条 + 「创建备份」
 * ├ 备份列表：每个包一张卡（时间 · App/dsh 版本 · 各分区文件数 · 体积），
 * │           带「恢复」「删除」；恢复前强制二次确认 + 自动先备份当前状态
 * └ 日志：可折叠控制台
 *
 * 全部重活（扫描 / 打包 / 解压）在后台线程；busy 锁防并发。
 */
class BackupActivity : AppCompatActivity() {

    private lateinit var locationText: TextView
    private lateinit var estimateText: TextView
    private lateinit var progress: ProgressBar
    private lateinit var createBtn: View
    private lateinit var listBox: LinearLayout
    private lateinit var logView: TextView
    private val logSb = StringBuilder()

    @Volatile
    private var busy = false

    /** 列表代数：并发的刷新只允许最后发起者上屏，防旧结果覆盖新列表。 */
    @Volatile
    private var listGen = 0

    /** 当前勾选的备份内容。 */
    private val opts = BackupManager.Options()

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_LONG).show()

    override fun onCreate(savedInstanceState: Bundle?) {
        DynamicColors.applyToActivityIfAvailable(this)
        super.onCreate(savedInstanceState)
        Ui.applyDynamicColors(this)
        AppLog.init(this)
        setContentView(buildUi())
        appendLog("备份与恢复就绪")
        refreshLocation()
        refreshEstimate()
        refreshList()
    }

    override fun onResume() {
        super.onResume()
        refreshLocation()
        refreshList()
    }

    // ---------------- UI ----------------

    private fun buildUi(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Ui.BG)
            setPadding(dp(16), dp(14), dp(16), dp(12))
        }

        // ---- 头部 ----
        root.addView(TextView(this).apply {
            text = "备份与恢复"
            textSize = 22f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            setTextColor(Ui.TEXT_PRIMARY)
        }, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ))
        locationText = TextView(this).apply {
            textSize = 11.5f
            setTextColor(Ui.TEXT_SECONDARY)
            setLineSpacing(dp(2).toFloat(), 1f)
            setPadding(0, dp(4), 0, 0)
        }
        root.addView(locationText, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ))

        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            isIndeterminate = true
            visibility = View.GONE
            indeterminateTintList = android.content.res.ColorStateList.valueOf(Ui.BRAND)
        }
        root.addView(progress, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, dp(6)
        ).apply { topMargin = dp(10) })

        // ---- 备份卡 ----
        root.addView(buildCreateCard(), LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(10) })

        // ---- 备份列表（动态重建）----
        root.addView(TextView(this).apply {
            text = "备份列表"
            textSize = 12f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            setTextColor(Ui.TEXT_SECONDARY)
            letterSpacing = 0.06f
            setPadding(dp(2), dp(12), dp(2), dp(4))
        }, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ))
        listBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val scroll = ScrollView(this).apply { addView(listBox) }
        root.addView(scroll, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f
        ))

        // ---- 日志 ----
        logView = TextView(this).apply {
            textSize = 10.5f
            typeface = android.graphics.Typeface.MONOSPACE
            setTextColor(Ui.TEXT_MUTED)
            background = Ui.rounded(this@BackupActivity, Ui.SURFACE_CONTAINER_LOW, 10)
            setPadding(dp(8), dp(6), dp(8), dp(6))
        }
        val logScroll = ScrollView(this).apply {
            addView(logView, ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            ))
        }
        root.addView(logScroll, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, dp(110)
        ).apply { topMargin = dp(8) })

        return root
    }

    /** 备份卡：三个勾选 chip + 预估 + 创建按钮。 */
    private fun buildCreateCard(): View {
        val card = Ui.card(this, radiusDp = 16, background = Ui.SURFACE_CONTAINER_HIGH, elevationDp = 1f)
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }

        col.addView(TextView(this).apply {
            text = "创建备份"
            textSize = 14f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            setTextColor(Ui.TEXT_PRIMARY)
        })
        col.addView(TextView(this).apply {
            text = "打包为 zip，只包含不可重建的状态；node / termux / dsh-prefix / 日志不入库（这些由「一键安装」重新生成）。"
            textSize = 11.5f
            setTextColor(Ui.TEXT_SECONDARY)
            setLineSpacing(dp(2).toFloat(), 1f)
            setPadding(0, dp(6), 0, 0)
        })

        // 三个开关 chip
        val chipRow = Ui.flowRow(this).apply { setPadding(0, dp(10), 0, 0) }
        fun switchChip(label: String, get: () -> Boolean, set: (Boolean) -> Unit) =
            com.google.android.material.chip.Chip(this).apply {
                text = label
                id = View.generateViewId() // ChipGroup 勾选状态跟踪需要子视图 id
                isCheckable = true
                isChecked = get()
                setOnCheckedChangeListener { _, checked -> set(checked); refreshEstimate() }
            }
        chipRow.addView(switchChip("dsh 数据", { opts.dshData }, { opts.dshData = it }))
        chipRow.addView(switchChip("启动器配置", { opts.launcherConfig }, { opts.launcherConfig = it }))
        chipRow.addView(switchChip("插件目录", { opts.plugins }, { opts.plugins = it }))
        col.addView(chipRow)

        estimateText = TextView(this).apply {
            textSize = 11.5f
            setTextColor(Ui.TEXT_MUTED)
            setPadding(0, dp(8), 0, 0)
        }
        col.addView(estimateText)

        createBtn = Ui.button(this, "创建备份", { onCreateBackup() }, filled = true).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(46)
            ).apply { topMargin = dp(10) }
        }
        col.addView(createBtn)

        card.addView(col)
        return card
    }

    // ---------------- 刷新 ----------------

    private fun refreshLocation() {
        val dir = BackupManager.backupDir(this)
        val shared = BackupManager.isSharedDir(this, dir)
        locationText.text = buildString {
            append(if (shared) "📁 存储位置：" else "⚠ 无共享存储权限，已回退私有目录：")
            append(dir.absolutePath)
            if (shared) append("\n（换机时把整个 backup 目录拷到新机的同一路径即可）")
            else append("\n（卸载 app 会丢失；建议先在系统设置授予「所有文件访问」）")
        }
        locationText.setTextColor(if (shared) Ui.TEXT_SECONDARY else Ui.WARNING)
    }

    private fun refreshEstimate() {
        estimateText.text = "正在估算体积…"
        thread {
            val stats = runCatching { BackupManager.scan(this, opts.copy()) }
                .getOrDefault(emptyMap())
            val files = stats.values.sumOf { it.files }
            val bytes = stats.values.sumOf { it.bytes }
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                estimateText.text = if (files == 0) {
                    "所选内容为空（0 个文件）"
                } else {
                    "预计 $files 个文件 · ${BackupManager.human(bytes)}（压缩后通常更小）"
                }
            }
        }
    }

    private fun refreshList() {
        val gen = ++listGen
        thread {
            val items = runCatching { BackupManager.list(this) }.getOrDefault(emptyList())
            runOnUiThread {
                if (isFinishing || isDestroyed || gen != listGen) return@runOnUiThread
                listBox.removeAllViews()
                if (items.isEmpty()) {
                    listBox.addView(TextView(this).apply {
                        text = "暂无备份"
                        textSize = 12.5f
                        setTextColor(Ui.TEXT_MUTED)
                        setPadding(dp(4), dp(8), dp(4), dp(8))
                    })
                    return@runOnUiThread
                }
                items.forEach { listBox.addView(buildItemCard(it)) }
                listBox.addView(TextView(this).apply {
                    text = "共 ${items.size} 份（自动保留最近 ${BackupManager.KEEP_MAX} 份，超出按时间从旧到新清理）"
                    textSize = 11f
                    setTextColor(Ui.TEXT_MUTED)
                    setPadding(dp(4), dp(8), dp(4), dp(4))
                    gravity = Gravity.CENTER
                })
            }
        }
    }

    private fun buildItemCard(item: BackupManager.Item): View {
        val card = Ui.card(this, radiusDp = 14, background = Ui.SURFACE_CONTAINER, elevationDp = 0f).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = dp(8) }
        }
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }

        val meta = item.meta
        col.addView(TextView(this).apply {
            text = ((if (meta != null) BackupManager.humanTime(meta.createdAt) else "未知时间")) +
                ((if (meta?.tag != null) " · ${meta.tag}" else ""))
            textSize = 14f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            setTextColor(Ui.TEXT_PRIMARY)
        })
        col.addView(TextView(this).apply {
            text = if (meta != null) {
                val parts = meta.stats.filter { it.value.files > 0 }
                    .map { (k, v) -> "$k ${v.files} 个 / ${BackupManager.human(v.bytes)}" }
                buildString {
                    append("App v${meta.appVersionName} · dsh v${meta.dshVersion}")
                    if (parts.isNotEmpty()) append("\n").append(parts.joinToString(" · "))
                    append("\n${BackupManager.human(item.file.length())} · ${item.file.name}")
                }
            } else {
                "⚠ 无法解析（非本应用备份包或已损坏）\n${BackupManager.human(item.file.length())} · ${item.file.name}"
            }
            textSize = 11.5f
            setTextColor(if (meta != null) Ui.TEXT_SECONDARY else Ui.WARNING)
            setLineSpacing(dp(2).toFloat(), 1f)
            setPadding(0, dp(4), 0, 0)
        })

        if (meta != null) {
            col.addView(
                Ui.buttonGrid(
                    this,
                    listOf(
                        Ui.button(this, "恢复", { confirmRestore(item) }, filled = true),
                        Ui.button(this, "删除", { confirmDelete(item) }, filled = false, color = Ui.DANGER),
                    ),
                    columns = 2
                ).apply {
                    setPadding(0, dp(10), 0, 0)
                }
            )
        } else {
            col.addView(
                Ui.button(this, "删除", { confirmDelete(item) }, filled = false, color = Ui.DANGER).apply {
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, dp(40)
                    ).apply { topMargin = dp(10) }
                }
            )
        }

        card.addView(col)
        return card
    }

    // ---------------- 动作 ----------------

    private fun onCreateBackup() {
        if (!opts.any()) {
            toast("请至少勾选一项备份内容")
            return
        }
        if (!guardBusy()) return
        setBusy(true)
        appendLog(">> 开始创建备份…")
        val snapshot = opts.copy()
        thread {
            val out = BackupManager.create(this, snapshot, tag = "manual") { line ->
                runOnUiThread { appendLog(line) }
            }
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                setBusy(false)
                if (out != null) {
                    toast("备份完成：${out.name}")
                    refreshList()
                } else {
                    toast("备份失败，详见页面日志")
                }
            }
        }
    }

    private fun confirmRestore(item: BackupManager.Item) {
        val meta = item.meta ?: run { toast("该包无法解析，不能恢复"); return }
        val parts = meta.stats.filter { it.value.files > 0 }
            .map { (k, v) -> "· $k：${v.files} 个文件 / ${BackupManager.human(v.bytes)}" }
        AlertDialog.Builder(this)
            .setTitle("恢复这份备份？")
            .setMessage(
                "来源：${BackupManager.humanTime(meta.createdAt)} · App v${meta.appVersionName} · dsh v${meta.dshVersion}\n\n" +
                    (if (parts.isNotEmpty()) parts.joinToString("\n") + "\n\n" else "") +
                    "恢复方式：只覆盖包内有的文件（合并），不会删除现有额外文件。\n" +
                    "恢复前会自动为当前状态创建一份快照备份；dsh 服务会被停止，完成后请手动重启。"
            )
            .setPositiveButton("恢复") { _, _ -> doRestore(item) }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun doRestore(item: BackupManager.Item) {
        if (!guardBusy()) return
        setBusy(true)
        appendLog(">> 开始恢复（先停 dsh，再快照，再回档）…")
        thread {
            // ① 停 dsh（同步完成，避免 web 在恢复期间改写 .dsh/sessions）
            try {
                DshFlow.killAllNode(this@BackupActivity) { /* 日志走 flow */ }
            } catch (t: Throwable) {
                logQuiet("  ! 停止进程失败：${t.message}")
            }
            runCatching {
                com.dsh.launcher.service.BuildKeepAliveService.markStopped(this@BackupActivity)
                stopService(android.content.Intent(this@BackupActivity, com.dsh.launcher.service.BuildKeepAliveService::class.java))
            }
            logQuiet("✓ dsh 服务已停止")
            // ② 恢复前自动快照当前状态（防手滑，失败仅警告不中止）
            Thread.sleep(300)
            val snap = BackupManager.create(this@BackupActivity, BackupManager.Options(), tag = "pre-restore") { line ->
                runOnUiThread { appendLog(line) }
            }
            if (snap == null) {
                logQuiet("⚠ 恢复前快照失败，继续恢复（当前状态将不可回退）")
            }
            Thread.sleep(300)
            // ③ 恢复
            val ok = BackupManager.restore(this@BackupActivity, item.file) { line ->
                runOnUiThread { appendLog(line) }
            }
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                setBusy(false)
                toast(if (ok) "恢复完成，请手动启动 dsh（插件链接异常时到「插件管理」重新装配）" else "恢复失败，详见页面日志")
                if (ok) {
                    refreshEstimate()
                    refreshList()
                }
            }
        }
    }

    /** 后台线程内安全追加日志（自动切回主线程）。 */
    private fun logQuiet(line: String) {
        runOnUiThread { appendLog(line) }
    }

    private fun confirmDelete(item: BackupManager.Item) {
        AlertDialog.Builder(this)
            .setTitle("删除备份？")
            .setMessage("${item.file.name}\n\n删除后不可恢复。")
            .setPositiveButton("删除") { _, _ ->
                if (BackupManager.delete(item)) {
                    appendLog("✓ 已删除 ${item.file.name}")
                    refreshList()
                } else {
                    toast("删除失败（文件不可写？）")
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    // ---------------- 工具 ----------------

    private fun guardBusy(): Boolean =
        if (busy) { toast("操作进行中，请稍候…"); false } else { busy = true; true }

    private fun setBusy(b: Boolean) {
        busy = b
        runOnUiThread {
            progress.visibility = if (b) View.VISIBLE else View.GONE
            createBtn.isEnabled = !b
            createBtn.alpha = if (b) 0.5f else 1f
        }
    }

    private fun appendLog(line: String) {
        if (line.isBlank()) return
        logSb.append(line).append("\n")
        val lines = logSb.toString().split("\n")
        if (lines.size > 30) logSb.clear().append(lines.takeLast(30).joinToString("\n")).append("\n")
        logView.text = logSb.toString().trimEnd()
        AppLog.i("Backup", line)
    }
}
