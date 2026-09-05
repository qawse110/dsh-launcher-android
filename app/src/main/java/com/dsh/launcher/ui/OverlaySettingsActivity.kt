package com.dsh.launcher.ui

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.documentfile.provider.DocumentFile
import com.google.android.material.card.MaterialCardView
import com.google.android.material.color.DynamicColors
import com.google.android.material.switchmaterial.SwitchMaterial
import java.io.File
import com.dsh.launcher.core.*
import com.dsh.launcher.overlay.*
import com.dsh.launcher.service.*
import com.dsh.launcher.tts.*
import com.dsh.launcher.ui.*
import com.dsh.launcher.R

/**
 * dsh 状态桥接配置页：
 * - 悬浮窗样式（状态条 / 桌宠模式）与桌宠包选择/导入；
 * - 悬浮窗 / 声音 / 通知开关；
 * - 显示内容（状态、最近 AI 输出、紧凑/完整模式）；
 * - 启动/停止桥接服务、授予悬浮窗权限。
 */
class OverlaySettingsActivity : AppCompatActivity() {

    private lateinit var overlaySwitch: SwitchMaterial
    private lateinit var soundSwitch: SwitchMaterial
    private lateinit var notifySwitch: SwitchMaterial
    private lateinit var showStatusSwitch: SwitchMaterial
    private lateinit var showLastTextSwitch: SwitchMaterial
    private lateinit var displayModeSwitch: SwitchMaterial
    private lateinit var autoModeSwitch: SwitchMaterial
    private lateinit var hideWhenIdleSwitch: SwitchMaterial
    private lateinit var permissionHint: TextView
    private var importHint: TextView? = null
    /** TTS 试听结果提示（失败时告知已回退系统引擎，别让用户对着没声音的按钮发愣）。 */
    private var previewHint: TextView? = null
    /** 试听用的系统 TTS（懒初始化，页面销毁时释放）。 */
    private var previewTts: android.speech.tts.TextToSpeech? = null
    /** 本页是否已登记过 EdgeTts 持有者（决定 onDestroy 是否需要 release）。 */
    private var previewBtnUsed = false
    /** 试听状态文案（跨 rebuild 保留：切换引擎/音色会重建 View 树，提示不该被冲掉）。 */
    private var previewStatus: Pair<String, Int>? = null

    private val importPet = registerForActivityResult(
        ActivityResultContracts.OpenDocumentTree()
    ) { uri ->
        if (uri != null) importFromTree(uri)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        DynamicColors.applyToActivityIfAvailable(this)
        super.onCreate(savedInstanceState)
        Ui.applyDynamicColors(this)
        setContentView(buildUi())
    }

    private fun prefs() = getSharedPreferences(AppState.Prefs.BRIDGE, Context.MODE_PRIVATE)

    private fun buildUi(): ViewGroup {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Ui.BG)
            setPadding(dp(16), dp(14), dp(16), dp(16))
        }

        root.addView(TextView(this).apply {
            text = "⛅ dsh 状态桥接"
            textSize = 22f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            setTextColor(Ui.TEXT_PRIMARY)
        })
        root.addView(TextView(this).apply {
            text = "悬浮窗显示运行情况 · 点击打开 Web · AI 结束可提示"
            textSize = 12f
            setTextColor(Ui.TEXT_SECONDARY)
            setPadding(0, dp(2), 0, dp(8))
        })

        fun section(text: String): TextView = Ui.sectionLabel(this, text).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(6) }
        }

        fun card(block: LinearLayout.() -> Unit): MaterialCardView {
            val c = Ui.card(this, radiusDp = 16, background = Ui.SURFACE_CONTAINER, elevationDp = 1f)
            val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; block() }
            c.addView(list)
            root.addView(c, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(4) })
            return c
        }

        // 悬浮窗样式：状态条 / 桌宠（单选 Chip 组，宽度贴合内容不再挤压）
        val style = prefs().getString("overlay_style", "pill") ?: "pill"
        root.addView(section("悬浮窗样式"))
        card {
            addView(Ui.optionChips(
                this@OverlaySettingsActivity,
                listOf("状态条" to "pill", "桌宠" to "pet"),
                style
            ) { setStyle(it) }, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ))
            addView(TextView(this@OverlaySettingsActivity).apply {
                text = "状态条：紧凑文字悬浮窗；桌宠：动画角色跟随 dsh 状态（兼容 Codex 桌宠包）。长按悬浮窗可快速切换。"
                textSize = 11f
                setTextColor(Ui.TEXT_MUTED)
                setPadding(0, dp(6), 0, 0)
            })
        }

        if (style == "pet") {
            root.addView(section("桌宠"))
            card {
                // 桌宠大小（单选 Chip 组）
                val currentSize = prefs().getString("pet_size", "medium") ?: "medium"
                addView(Ui.optionChips(
                    this@OverlaySettingsActivity,
                    listOf("小" to "small", "中" to "medium", "大" to "large"),
                    currentSize
                ) { value ->
                    prefs().edit().putString("pet_size", value).apply()
                    rebuild()
                }, LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ))
                addSwitch(this, "显示气泡", "桌宠上方显示状态气泡；点击气泡打开 dsh Web", "pet_show_bubble", true)
                addSwitch(this, "桌宠发声（TTS）", "任务完成/出错/新任务/调用工具时语音播报，互动台词也会朗读（需系统 TTS 引擎）", "pet_tts", true)
                addSwitch(this, "显示桌宠名称", "气泡中显示桌宠名字（与状态、最近输出一起）", "pet_show_name", true)
                addSwitch(this, "闲时主动冒泡", "dsh 空闲时桌宠每隔几分钟随机说一句台词（可关闭），说时会朗读", "pet_ambient_bubble", true)
                addSwitch(this, "拖拽抛落", "松手后桌宠沿抛出方向做抛物线坠落，落地带小弹跳（可关闭改为普通拖动定位）", "pet_fall", true)

                // 任务完成气泡停留时长（单选 Chip 组；<=0 = 不自动收起）
                val holdOptions = linkedMapOf(
                    10_000L to "10秒",
                    30_000L to "30秒",
                    60_000L to "1分钟",
                    120_000L to "2分钟",
                    0L to "不收起"
                )
                val holdCur = prefs().getLong("pet_completion_hold_ms", 30_000L)
                addView(Ui.optionChips(
                    this@OverlaySettingsActivity,
                    holdOptions.map { (ms, label) -> label to ms },
                    holdCur
                ) { ms ->
                    prefs().edit().putLong("pet_completion_hold_ms", ms).apply()
                }, LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ))
                addView(TextView(this@OverlaySettingsActivity).apply {
                    text = "任务完成后「已完成」气泡的停留时长；「不收起」则一直显示到新任务开始。"
                    textSize = 11f
                    setTextColor(Ui.TEXT_MUTED)
                    setPadding(0, dp(4), 0, dp(4))
                })

                val pets = CodexPetStore.scanPets(this@OverlaySettingsActivity)
                val selected = prefs().getString("pet_id", CodexPetStore.DEFAULT_PET_ID)
                for (pet in pets) {
                    addPetRow(this, pet, pet.id == selected)
                }
                if (pets.size <= 1) {
                    addView(TextView(this@OverlaySettingsActivity).apply {
                        text = "目前只有内置默认桌宠。可导入社区桌宠包（awesome-codex-pet / petdex 的 pet.json + spritesheet 格式）。"
                        textSize = 11f
                        setTextColor(Ui.TEXT_MUTED)
                        setPadding(0, 0, 0, dp(4))
                    })
                }
                addView(Ui.button(
                    this@OverlaySettingsActivity,
                    "导入桌宠包（选择含 pet.json 的文件夹）",
                    { importPet.launch(null) },
                    filled = false
                ), LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { topMargin = dp(4) })
                addView(Ui.button(
                    this@OverlaySettingsActivity,
                    "刷新列表",
                    { rebuild() },
                    filled = false
                ), LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { topMargin = dp(8) })
                importHint = TextView(this@OverlaySettingsActivity).apply {
                    textSize = 11f
                    setTextColor(Ui.TEXT_MUTED)
                    setPadding(0, dp(8), 0, 0)
                }
                addView(importHint, LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ))
                addView(TextView(this@OverlaySettingsActivity).apply {
                    text = "也可直接把桌宠包文件夹复制到 /sdcard/Download/DshLauncher/codex-pets/ 下（需含 pet.json 与 spritesheet.webp/.png）。"
                    textSize = 11f
                    setTextColor(Ui.TEXT_MUTED)
                    setPadding(0, dp(4), 0, 0)
                })
            }
        }

        // 显示内容
        root.addView(section("显示内容"))
        card {
            overlaySwitch = addSwitch(this, "悬浮窗显示", "在其它应用上层显示 dsh 运行状态（关闭后普通与无障碍通道的悬浮窗一并隐藏）", "overlay_enabled", true) { checked ->
                if (checked) StatusBridgeService.resetDismissed(this@OverlaySettingsActivity)
            }
            showStatusSwitch = addSwitch(this, "显示状态", "显示思考中 / 输出中 / 调用工具等状态", "show_status", true)
            showLastTextSwitch = addSwitch(this, "显示最近输出", "悬浮窗中附带最近 AI 文本", "show_last_text", true)
            hideWhenIdleSwitch = addSwitch(this, "空闲时隐藏", "dsh 空闲时自动隐藏悬浮窗，减少打扰", "hide_when_idle", false)
            autoModeSwitch = addSwitch(this, "智能适配内容", "内容少时紧凑显示，内容多时自动展开 3 行", "display_mode_auto", true) { checked ->
                displayModeSwitch.isEnabled = !checked
            }
            displayModeSwitch = addSwitch(this, "完整模式", "内容较多时固定显示 3 行（智能适配关闭时生效）", "display_mode_full", false)
            displayModeSwitch.isChecked = prefs().getString("display_mode", "compact") == "full"
            displayModeSwitch.isEnabled = !prefs().getBoolean("display_mode_auto", true)
            displayModeSwitch.setOnCheckedChangeListener { _, checked ->
                prefs().edit().putString("display_mode", if (checked) "full" else "compact").apply()
            }
        }

        // 提醒方式
        root.addView(section("提醒方式"))
        card {
            soundSwitch = addSwitch(this, "声音提示", "AI 输出结束后由应用自身播放提示音", "sound_enabled", true)
            notifySwitch = addSwitch(this, "通知提示", "发送静默通知（不附带提示音）", "notify_enabled", true)
        }

        // TTS 播报引擎
        root.addView(section("TTS 播报"))
        card {
            val engines = linkedMapOf(
                "system" to "系统引擎（离线）",
                "edge" to "Edge 在线语音（音质佳，需联网）"
            )
            val voices = linkedMapOf(
                "zh-CN-XiaoxiaoNeural" to "晓晓 · 女声自然",
                "en-US-EmmaMultilingualNeural" to "艾玛 · 中英双语",
                "zh-CN-XiaoyiNeural" to "晓伊 · 女声活泼",
                "zh-CN-YunxiNeural" to "云希 · 男声年轻",
                "zh-CN-YunjianNeural" to "云健 · 男声运动",
                "zh-CN-YunyangNeural" to "云扬 · 男声新闻",
                "zh-CN-liaoning-XiaobeiNeural" to "晓北 · 女声东北",
                "zh-CN-shaanxi-XiaoniNeural" to "晓妮 · 女声陕西"
            )
            val engineBtn = Ui.button(this@OverlaySettingsActivity, "", { }, filled = false)
            val voiceBtn = Ui.button(this@OverlaySettingsActivity, "", { }, filled = false)
            fun setPreviewStatus(text: String, color: Int) {
                previewStatus = text to color
                applyPreviewStatus()
            }
            val previewBtn = Ui.button(this@OverlaySettingsActivity, "▶ 试听当前音色", {
                val ctx = this@OverlaySettingsActivity
                val v = prefs().getString("tts_edge_voice", "zh-CN-XiaoxiaoNeural")
                    ?: "zh-CN-XiaoxiaoNeural"
                // 试听也走持有者登记（S2/L4）：旧实现每次点击都调 init 会覆盖桌宠注册的
                // fallback，试听一次之后桌宠的 Edge 失败回落就断了；而且计数会虚高，
                // 页面销毁后仍有残留持有者，EdgeTts 永远停不了机。
                setPreviewStatus("正在合成…", Ui.TEXT_MUTED)
                if (!previewBtnUsed) {
                    previewBtnUsed = true
                    EdgeTts.init(ctx) { text, flush ->
                        runOnUiThread {
                            setPreviewStatus(
                                "在线合成失败，已回退系统引擎播放（检查网络）",
                                Ui.WARNING
                            )
                            speakFallback(text, flush)
                        }
                    }
                }
                EdgeTts.enqueue("你好，这是当前的语音效果。", v, EdgeTts.Mode.FLUSH)
            }, filled = false)
            fun refresh() {
                val cur = prefs().getString("tts_engine", "system") ?: "system"
                engineBtn.text = "引擎：" + (engines[cur] ?: engines["system"]!!)
                val v = prefs().getString("tts_edge_voice", "zh-CN-XiaoxiaoNeural")
                    ?: "zh-CN-XiaoxiaoNeural"
                voiceBtn.text = "音色：" + (voices[v] ?: v) + "  ▸"
                val edge = cur == "edge"
                voiceBtn.visibility = if (edge) View.VISIBLE else View.GONE
                previewBtn.visibility = if (edge) View.VISIBLE else View.GONE
            }
            engineBtn.setOnClickListener {
                val next = if ((prefs().getString("tts_engine", "system") ?: "system") == "edge") "system" else "edge"
                prefs().edit().putString("tts_engine", next).apply()
                refresh()
            }
            // 音色一次弹窗全列出、单选直达——不再逐个点击轮换
            voiceBtn.setOnClickListener {
                val cur = prefs().getString("tts_edge_voice", "zh-CN-XiaoxiaoNeural")
                    ?: "zh-CN-XiaoxiaoNeural"
                val keys = voices.keys.toList()
                val labels = voices.values.toTypedArray()
                val checked = keys.indexOf(cur).coerceAtLeast(0)
                AlertDialog.Builder(this@OverlaySettingsActivity)
                    .setTitle("选择 Edge 音色")
                    .setSingleChoiceItems(labels, checked) { dlg, which ->
                        prefs().edit().putString("tts_edge_voice", keys[which]).apply()
                        dlg.dismiss()
                        refresh()
                    }
                    .setNegativeButton("取消", null)
                    .show()
            }
            refresh()
            addView(engineBtn, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(4) })
            addView(voiceBtn, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(8) })
            addView(previewBtn, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(8) })
            previewHint = TextView(this@OverlaySettingsActivity).apply {
                text = "音色点击弹窗直选；试听与播报均需联网，失败自动回退系统引擎。"
                textSize = 11f
                setTextColor(Ui.TEXT_MUTED)
                setPadding(0, dp(8), 0, 0)
            }
            addView(previewHint, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            ))
            applyPreviewStatus() // rebuild 后回填上一次的试听状态
        }

        permissionHint = TextView(this).apply {
            textSize = 12f
            setTextColor(Ui.WARNING)
            setPadding(dp(2), dp(10), dp(2), dp(4))
        }
        root.addView(permissionHint)
        refreshPermissionHint()

        // 服务控制
        root.addView(section("服务控制"))
        card {
            val startBtn = Ui.button(this@OverlaySettingsActivity, "启动桥接服务", {
                if (Build.VERSION.SDK_INT >= 33 &&
                    checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                ) {
                    requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 200)
                }
                StatusBridgeService.resetDismissed(this@OverlaySettingsActivity)
                StatusBridgeService.start(this@OverlaySettingsActivity)
                val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
                if (Build.VERSION.SDK_INT >= 23 && !pm.isIgnoringBatteryOptimizations(packageName)) {
                    permissionHint.text = "⚠ 建议开启“忽略电池优化”，否则后台可能被系统杀死"
                    permissionHint.setTextColor(Ui.WARNING)
                }
            }, filled = true)
            val stopBtn = Ui.button(this@OverlaySettingsActivity, "停止服务", {
                StatusBridgeService.stop(this@OverlaySettingsActivity)
            }, filled = false, color = Ui.DANGER)
            addView(startBtn, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(4) })
            addView(stopBtn, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(8) })
        }

        // 后台保活（灭屏空闲保活窗，单选 Chip 组：五档文案不再挤成一排窄按钮）
        root.addView(section("后台保活"))
        card {
            val options = linkedMapOf(
                0 to "关闭",
                15 to "15分钟",
                PowerGovernor.DEFAULT_IDLE_KEEPALIVE_MIN to "30分钟",
                60 to "1小时",
                -1 to "常驻"
            )
            val current = prefs().getInt("idle_keepalive_min", PowerGovernor.DEFAULT_IDLE_KEEPALIVE_MIN)
            addView(Ui.optionChips(
                this@OverlaySettingsActivity,
                options.map { (minutes, label) -> label to minutes },
                current
            ) { minutes ->
                prefs().edit().putInt("idle_keepalive_min", minutes).apply()
                PowerGovernor.setIdleKeepAliveMinutes(minutes) // 立即生效
            }, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ))
            addView(TextView(this@OverlaySettingsActivity).apply {
                text = "灭屏且无任务时，在所选时长内保持 dsh 与状态桥接活跃（唤醒锁 + 看门狗可唤醒），亮屏回来立即可用；到期后转入系统深度省电。任务运行中始终全程保活、不受此时长限制。「常驻」会增加待机耗电。"
                textSize = 11f
                setTextColor(Ui.TEXT_MUTED)
                setPadding(0, dp(6), 0, 0)
            })
        }

        // 权限与保活
        root.addView(section("权限与保活"))
        card {
            val permBtn = Ui.button(this@OverlaySettingsActivity, "授予悬浮窗权限", {
                openOverlaySettings()
            }, filled = false)
            val batteryBtn = Ui.button(this@OverlaySettingsActivity, "忽略电池优化（防后台杀）", {
                openBatteryOptimizationSettings()
            }, filled = false)
            val a11yBtn = Ui.button(this@OverlaySettingsActivity, "无障碍保活（可选，强烈推荐）", {
                startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            }, filled = false)
            val a11yFixBtn = Ui.button(this@OverlaySettingsActivity, "一键修复无障碍通道（悬浮窗不出现时用）", {
                repairA11yChannel()
            }, filled = false)
            val webBtn = Ui.button(this@OverlaySettingsActivity, "打开 dsh Web", {
                startActivity(Intent(this@OverlaySettingsActivity, WebViewActivity::class.java))
            }, filled = false)
            addView(permBtn, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(4) })
            addView(batteryBtn, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(8) })
            addView(a11yBtn, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(8) })
            addView(a11yFixBtn, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(8) })
            addView(webBtn, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(8) })
        }

        return ScrollView(this).apply { addView(root) }
    }

    private fun setStyle(style: String) {
        prefs().edit().putString("overlay_style", style).apply()
        rebuild()
    }

    private fun rebuild() {
        runOnUiThread { setContentView(buildUi()) }
    }

    private fun addPetRow(container: LinearLayout, pet: CodexPetInfo, selected: Boolean) {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(6), 0, dp(6))
            isClickable = true
            isFocusable = true
            setOnClickListener {
                prefs().edit().putString("pet_id", pet.id).apply()
                rebuild()
            }
        }
        val textWrap = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        textWrap.addView(TextView(this).apply {
            text = pet.displayName
            textSize = 15f
            setTextColor(Ui.TEXT_PRIMARY)
        })
        val metaLine = buildString {
            if (pet.description.isNotBlank()) append(pet.description)
            val by = listOf(pet.author, pet.version)
                .filter { it.isNotBlank() }
                .joinToString(" · ")
            if (by.isNotBlank()) {
                if (isNotEmpty()) append("  ·  ")
                append(by)
            }
        }
        if (metaLine.isNotBlank()) {
            textWrap.addView(TextView(this).apply {
                text = metaLine
                textSize = 11f
                setTextColor(Ui.TEXT_MUTED)
            })
        }
        row.addView(textWrap, LinearLayout.LayoutParams(
            0,
            ViewGroup.LayoutParams.WRAP_CONTENT,
            1f
        ))
        if (selected) {
            row.addView(TextView(this).apply {
                text = "✓ 使用中"
                textSize = 12f
                setTextColor(Ui.SUCCESS)
            })
        }
        container.addView(row, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ))
    }

    /** 从 SAF 树导入桌宠包：所选文件夹本身或其一子文件夹含 pet.json 即视为一个桌宠包。 */
    private fun importFromTree(uri: Uri) {
        val root = DocumentFile.fromTreeUri(this, uri)
        if (root == null) {
            importHint?.text = "无法读取所选文件夹"
            return
        }
        val candidates = mutableListOf<DocumentFile>()
        if (root.findFile("pet.json") != null) candidates.add(root)
        root.listFiles().forEach { child ->
            if (child.isDirectory && child.findFile("pet.json") != null) candidates.add(child)
        }
        val imported = mutableListOf<String>()
        for (dir in candidates) {
            val name = sanitizeFileName(dir.name ?: "pet")
            val targetDir = File(filesDir, "${CodexPetStore.DIR_NAME}/$name")
            val petJson = dir.findFile("pet.json") ?: continue
            if (!targetDir.exists() && !targetDir.mkdirs()) continue
            copyDocFile(petJson, File(targetDir, "pet.json"))
            for (ext in listOf("webp", "png")) {
                dir.findFile("spritesheet.$ext")?.let {
                    copyDocFile(it, File(targetDir, "spritesheet.$ext"))
                }
            }
            imported.add(name)
        }
        rebuild()
        importHint?.text = if (imported.isNotEmpty()) {
            "已导入：${imported.joinToString("、")}"
        } else {
            "未找到含 pet.json 的桌宠包"
        }
    }

    private fun copyDocFile(src: DocumentFile, dst: File) {
        try {
            contentResolver.openInputStream(src.uri)?.use { input ->
                dst.outputStream().use { output -> input.copyTo(output) }
            }
        } catch (e: Exception) {
            // 单文件拷贝失败不中断其它文件
        }
    }

    private fun sanitizeFileName(name: String): String =
        name.replace(Regex("[^A-Za-z0-9._-]"), "_")

    private fun addSwitch(
        container: LinearLayout,
        title: String,
        desc: String,
        key: String,
        default: Boolean,
        onChecked: ((Boolean) -> Unit)? = null
    ): SwitchMaterial {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(6), 0, dp(6))
        }
        val textWrap = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        textWrap.addView(TextView(this).apply {
            text = title
            textSize = 15f
            setTextColor(Ui.TEXT_PRIMARY)
        })
        textWrap.addView(TextView(this).apply {
            text = desc
            textSize = 11f
            setTextColor(Ui.TEXT_MUTED)
        })
        val sw = SwitchMaterial(this)
        sw.isChecked = prefs().getBoolean(key, default)
        sw.setOnCheckedChangeListener { _, checked ->
            prefs().edit().putBoolean(key, checked).apply()
            onChecked?.invoke(checked)
        }
        row.addView(textWrap, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        row.addView(sw, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ))
        container.addView(row, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ))
        return sw
    }

    /** 双通道健康度提示：悬浮窗权限 + 无障碍连接状态。
     *  连接判定用 90s 诊断窗口（isA11yActiveForDiag）：灭屏深睡会冻结轮询线程几十秒，
     *  用 5s 让位窗口会把「正在深睡」误报成「已开启但未连接」，让用户误以为权限出问题。
     *  真·掉线（ROM 懒绑定/强停后未重绑）才提示，并指向下方「一键修复」。 */
    private fun refreshPermissionHint() {
        val can = Settings.canDrawOverlays(this)
        val a11yEnabled = KeepAliveAccessibilityService.isEnabledInSystemSettings(this)
        val a11yFresh = a11yEnabled && KeepAliveAccessibilityService.isA11yActiveForDiag(this)
        val overlayPart = if (can) "✓ 悬浮窗权限已授予" else "⚠ 未授予悬浮窗权限，悬浮窗不会显示"
        val a11yPart = when {
            !a11yEnabled -> "无障碍通道未开启（可选，强烈推荐）"
            a11yFresh -> "✓ 无障碍通道已连接"
            else -> "⚠ 无障碍已开启但未连接（可点下方「一键修复」，或到系统设置关闭再打开）"
        }
        permissionHint.text = "$overlayPart\n$a11yPart"
        permissionHint.setTextColor(
            when {
                !can -> Ui.WARNING
                a11yEnabled && !a11yFresh -> Ui.WARNING
                can || a11yFresh -> Ui.SUCCESS
                else -> Ui.TEXT_MUTED
            }
        )
    }

    /**
     * 一键修复无障碍通道：应用被杀后 ROM 可能保持「开关已登记、服务未连接」的死状态。
     * 已授予 WRITE_SECURE_SETTINGS（adb 一次性授权）时直接重置服务强制系统重绑；
     * 否则弹出引导（展示可复制的授权命令 + 跳转系统无障碍设置手动开关）。
     */
    private fun repairA11yChannel() {
        val granted = try {
            checkSelfPermission(android.Manifest.permission.WRITE_SECURE_SETTINGS) ==
                PackageManager.PERMISSION_GRANTED
        } catch (_: Exception) {
            false
        }
        if (granted) {
            permissionHint.text = "正在重置无障碍服务…"
            permissionHint.setTextColor(Ui.TEXT_MUTED)
            Thread {
                val ok = KeepAliveAccessibilityService.repairViaSecureSettings(this)
                runOnUiThread {
                    if (ok) {
                        permissionHint.text = "✓ 已重置无障碍服务，系统将在数秒内重新连接；若悬浮窗仍未出现请稍候或重启应用"
                        permissionHint.setTextColor(Ui.SUCCESS)
                    } else {
                        permissionHint.text = "⚠ 重置失败，请到系统无障碍设置手动关闭再打开"
                        permissionHint.setTextColor(Ui.WARNING)
                    }
                }
            }.start()
        } else {
            AlertDialog.Builder(this)
                .setTitle("一键修复需要一次授权")
                .setMessage(
                    "修复原理：把本应用的无障碍服务从系统设置中摘除再写回，强制系统重新绑定。\n\n" +
                        "需要电脑执行一次 adb 授权（永久有效）：\n" +
                        "adb shell pm grant $packageName android.permission.WRITE_SECURE_SETTINGS\n\n" +
                        "未授权也可手动修复：到系统无障碍设置把本服务关闭再打开。"
                )
                .setPositiveButton("复制命令") { _, _ ->
                    val cb = getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                    cb.setPrimaryClip(android.content.ClipData.newPlainText(
                        "adb", "adb shell pm grant $packageName android.permission.WRITE_SECURE_SETTINGS"
                    ))
                    permissionHint.text = "✓ 命令已复制，电脑执行后再点「一键修复」"
                    permissionHint.setTextColor(Ui.SUCCESS)
                }
                .setNeutralButton("打开无障碍设置") { _, _ ->
                    startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
                }
                .setNegativeButton("取消", null)
                .show()
        }
    }

    private fun openOverlaySettings() {
        if (Build.VERSION.SDK_INT >= 23) {
            try {
                startActivity(Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:$packageName")
                ))
            } catch (e: Exception) {
                startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION))
            }
        }
    }

    private fun openBatteryOptimizationSettings() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        if (Build.VERSION.SDK_INT >= 23 && !pm.isIgnoringBatteryOptimizations(packageName)) {
            try {
                startActivity(Intent(
                    Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:$packageName")
                ))
            } catch (e: Exception) {
                startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            }
        } else {
            permissionHint.text = "✓ 已忽略电池优化"
            permissionHint.setTextColor(Ui.SUCCESS)
        }
    }

    /** 把 [previewStatus] 写进当前 hint 视图（rebuild 后视图换了也要回填）。 */
    private fun applyPreviewStatus() {
        val (text, color) = previewStatus ?: return
        val tv = previewHint ?: return
        tv.text = text
        tv.setTextColor(color)
    }

    /**
     * 试听失败时的系统引擎兜底播放：与桌宠共用同一套系统 TTS 语义
     * （flush=true 打断，false 排队），失败原因已由 EdgeTts 写入 dsh.log。
     */
    private fun speakFallback(text: String, flush: Boolean) {
        val queueMode = if (flush) android.speech.tts.TextToSpeech.QUEUE_FLUSH
        else android.speech.tts.TextToSpeech.QUEUE_ADD
        val existing = previewTts
        if (existing != null) {
            runCatching { existing.speak(text, queueMode, null, "dsh_preview") }
            return
        }
        // 初始化是异步的：回调里的 speak 才是安全的第一句；若回调前已销毁则跳过
        var pending: String? = text
        previewTts = android.speech.tts.TextToSpeech(this) { status: Int ->
            val tts = previewTts
            if (tts != null && status == android.speech.tts.TextToSpeech.SUCCESS) {
                val ok = tts.isLanguageAvailable(java.util.Locale.CHINA)
                tts.setLanguage(
                    if (ok >= android.speech.tts.TextToSpeech.LANG_AVAILABLE) java.util.Locale.CHINA
                    else java.util.Locale.getDefault()
                )
                pending?.let { runCatching { tts.speak(it, queueMode, null, "dsh_preview") } }
                pending = null
            }
        }
    }

    override fun onResume() {
        super.onResume()
        refreshPermissionHint()
    }

    override fun onDestroy() {
        // 试听登记过 EdgeTts 持有者：不 release 会永久占着计数，
        // 让真正该停机的通道停机失效（S2）
        if (previewBtnUsed) {
            previewBtnUsed = false
            EdgeTts.release()
        }
        runCatching { previewTts?.shutdown() }
        previewTts = null
        previewHint = null
        super.onDestroy()
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
}