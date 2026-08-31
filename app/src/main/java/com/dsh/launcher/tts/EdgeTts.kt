package com.dsh.launcher.tts

import android.content.Context
import android.media.MediaPlayer
import android.os.Handler
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.ArrayDeque
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import com.dsh.launcher.core.*
import com.dsh.launcher.overlay.*
import com.dsh.launcher.service.*
import com.dsh.launcher.tts.*
import com.dsh.launcher.ui.*
import com.dsh.launcher.R

/**
 * Edge TTS —— 严格对齐 rany2/edge-tts 上游实现（v7.x）：
 *
 * - WebSocket：OkHttp（Android 平台没有 OpenJDK java.net.http，桩有真机无）；
 * - Sec-MS-GEC：unix_ts + WIN_EPOCH 后按 300s 取整 ×1e7 拼 TrustedClientToken，
 *   SHA256 大写；403 时读响应 Date 头自动校正本机时钟偏移后即可恢复；
 * - URL：base?TrustedClientToken&ConnectionId&Sec-MS-GEC&Sec-MS-GEC-Version；
 * - 必要头：Origin(扩展 id)/UA(Chromium 主版本)/Pragma/Cache-Control/Accept-Language/
 *   Cookie:muid=<随机 32 位大写 hex>；speech.config 消息尾部带 "\r\n"；
 * - SSML 前剥离服务不兼容的控制字符并做 XML 转义；
 * - 单飞流水线 + flush 打断 + 失败回退系统 TTS（原因写入 dsh.log）。
 */
object EdgeTts {

    private const val TRUSTED_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4"

    /** 与 rany2/edge-tts constants.py 同步的 Edge/Chromium 版本（过期会被 403）。 */
    private const val CHROMIUM_FULL_VERSION = "143.0.3650.75"
    private const val CHROMIUM_MAJOR = "143"
    private const val SEC_MS_GEC_VERSION = "1-$CHROMIUM_FULL_VERSION"
    private const val USER_AGENT =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/$CHROMIUM_MAJOR.0.0.0 Safari/537.36 Edg/$CHROMIUM_MAJOR.0.0.0"

    private const val WIN_EPOCH = 11_644_473_600L
    private const val TIMEOUT_MS = 12_000L

    private class Item(val text: String, val voice: String, val flush: Boolean)

    private val queue = ArrayDeque<Item>()
    private var appCtx: Context? = null
    private var fallback: ((text: String, flush: Boolean) -> Unit)? = null
    private val main = Handler(Looper.getMainLooper())
    private val gen = AtomicInteger(0)
    private val busy = AtomicBoolean(false)
    private var ws: WebSocket? = null
    private var player: MediaPlayer? = null
    private var timeoutRunnable: Runnable? = null

    /** 时钟偏移（秒）：403 时依据响应 Date 头自动校正。 */
    @Volatile private var clockSkewSec = 0L

    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .build()
    }

    fun init(context: Context, onFallback: (text: String, flush: Boolean) -> Unit) {
        appCtx = context.applicationContext
        fallback = onFallback
    }

    fun enqueue(text: String, voice: String, flush: Boolean) {
        if (text.isBlank()) return
        synchronized(queue) {
            if (flush) {
                queue.clear()
                abortCurrent()
            }
            if (flush) queue.addFirst(Item(text, voice, true)) else queue.addLast(Item(text, voice, false))
        }
        pump()
    }

    fun shutdown() {
        synchronized(queue) { queue.clear(); abortCurrent() }
        main.post { stopPlayer() }
    }

    /** 是否有播报在进行（合成中或播放中）或有排队句：低优先级播报让路判断用。 */
    fun isActive(): Boolean = busy.get() || synchronized(queue) { queue.isNotEmpty() }

    // ── 流水线 ────────────────────────────────────────────

    private fun pump() {
        if (!busy.compareAndSet(false, true)) return
        val item = synchronized(queue) { queue.pollFirst() }
        if (item == null) {
            busy.set(false)
            return
        }
        startSynth(item)
    }

    private fun finishItem(item: Item?) {
        busy.set(false)
        pump()
    }

    private fun failToSystem(item: Item, reason: String) {
        AppLog.e("EdgeTts", "synth failed ($reason): " + item.text.take(40))
        busy.set(false)
        fallback?.invoke(item.text, item.flush)
        pump()
    }

    // ── DRM：Sec-MS-GEC 与时钟偏移 ────────────────────────

    private fun gecToken(): String {
        var ticks = System.currentTimeMillis() / 1000L + clockSkewSec + WIN_EPOCH
        ticks -= ticks % 300L                       // 向下取整到最近 5 分钟
        ticks *= 10_000_000L                        // 转 Windows 文件时间（100ns）
        val digest = MessageDigest.getInstance("SHA-256")
            .digest((ticks.toString() + TRUSTED_TOKEN).toByteArray())
        return digest.joinToString("") { "%02X".format(it) }
    }

    /** 403 时用服务器 Date 头校正本地时钟偏移（上游 handle_client_response_error 等价物）。 */
    private fun adjustSkewFrom(response: Response?) {
        val dateHeader = response?.header("Date") ?: return
        runCatching {
            val fmt = SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss 'GMT'", Locale.US)
            fmt.timeZone = TimeZone.getTimeZone("UTC")
            val serverMs = fmt.parse(dateHeader)?.time ?: return
            val deltaSec = (serverMs - System.currentTimeMillis()) / 1000L
            if (Math.abs(deltaSec) > 60L) {
                clockSkewSec += deltaSec
                AppLog.i("EdgeTts", "clock skew adjusted +" + deltaSec + "s")
            }
        }
    }

    // ── 消息构造 ──────────────────────────────────────────

    private fun httpDate(): String =
        SimpleDateFormat("EEE MMM dd yyyy HH:mm:ss 'GMT+0000 (Coordinated Universal Time)'", Locale.US)
            .format(Date())

    /** 服务不支持的控制字符（含垂直制表符）必须剔除，否则接口报错。 */
    private fun sanitize(text: String): String = buildString {
        for (ch in text) {
            val c = ch.code
            if (c <= 8 || c == 11 || c == 12 || c in 14..31) continue
            append(ch)
        }
    }

    private fun ssml(rawText: String, voice: String): String {
        val escaped = sanitize(rawText)
            .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace("\"", "&quot;").replace("'", "&apos;")
        // xml:lang 固定 en-US 为上游行为，中文音色不受影响
        return "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
            "<voice name='$voice'>" +
            "<prosody pitch='+0Hz' rate='+0%' volume='+0%'>$escaped</prosody></voice></speak>"
    }

    private fun wssUrl(connectionId: String): String =
        "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1" +
            "?TrustedClientToken=$TRUSTED_TOKEN" +
            "&ConnectionId=$connectionId" +
            "&Sec-MS-GEC=" + gecToken() +
            "&Sec-MS-GEC-Version=$SEC_MS_GEC_VERSION"

    // ── 合成 ─────────────────────────────────────────────

    private fun startSynth(item: Item) {
        val ctx = appCtx ?: run { failToSystem(item, "no context"); return }
        val myGen = gen.incrementAndGet()
        val audio = ByteArrayOutputStream()

        val configMsg = "X-Timestamp:" + httpDate() +
            "\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n" +
            "{\"context\":{\"synthesis\":{\"audio\":{\"metadataoptions\":" +
            "{\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"false\"}," +
            "\"outputFormat\":\"audio-24khz-48kbitrate-mono-mp3\"}}}}\r\n"
        val requestMsg = "X-RequestId:" + UUID.randomUUID().toString().replace("-", "") +
            "\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:" + httpDate() + "Z" +
            "\r\nPath:ssml\r\n\r\n" + ssml(item.text, item.voice)
        // 本监听器只允许结算一次：turn.end 正常路径 close 后 onClosed 也会回调
        var settled = false
        fun settleOnce(fail: Boolean, why: String) {
            if (settled) return
            settled = true
            if (fail) failToSystem(item, why)
            else finishSynth(myGen, item, ctx, audio.toByteArray())
        }

        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (stale(myGen)) { webSocket.cancel(); return }
                webSocket.send(configMsg)
                webSocket.send(requestMsg)
                armTimeout(myGen, item) { settleOnce(fail = true, why = "timeout") }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (stale(myGen)) { webSocket.cancel(); return }
                if (text.contains("Path:turn.end")) {
                    disarmTimeout()
                    webSocket.close(1000, null)
                    settleOnce(fail = false, why = "")
                }
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                if (stale(myGen)) { webSocket.cancel(); return }
                val arr = bytes.toByteArray()
                if (arr.size > 2) {
                    val headerLen = ((arr[0].toInt() and 0xFF) shl 8) or (arr[1].toInt() and 0xFF)
                    if (arr.size > headerLen + 2) audio.write(arr, headerLen + 2, arr.size - headerLen - 2)
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                // 服务器干净断开但未到 turn.end（截断/连接复用超时）：不处理会让流水线
                // 卡到 12s 超时才释放，正文逐句合成会持续落后于生成速度
                if (stale(myGen)) return
                disarmTimeout()
                settleOnce(fail = audio.size() == 0, why = "closed before audio: $code")
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (stale(myGen)) return
                if (response != null && response.code == 403) {
                    adjustSkewFrom(response)
                }
                val reason = t.message ?: response?.code?.toString() ?: "unknown"
                disarmTimeout()
                settleOnce(fail = true, why = "ws failure: $reason")
            }
        }

        try {
            val request = Request.Builder()
                .url(wssUrl(UUID.randomUUID().toString()))
                .header("Origin", "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold")
                .header("User-Agent", USER_AGENT)
                .header("Accept-Language", "en-US,en;q=0.9")
                .header("Pragma", "no-cache")
                .header("Cache-Control", "no-cache")
                .header("Cookie", "muid=" + randHex32() + ";")
                .build()
            ws = client.newWebSocket(request, listener)
        } catch (t: Throwable) {
            failToSystem(item, "connect: " + t.message)
        }
    }

    private fun randHex32(): String =
        buildString { repeat(16) { append("%02X".format((Math.random() * 256).toInt())) } }

    private fun finishSynth(myGen: Int, item: Item, ctx: Context, audioBytes: ByteArray) {
        disarmTimeout()
        if (audioBytes.isEmpty()) { failToSystem(item, "empty audio"); return }
        val out = File(ctx.cacheDir, "edge_tts_$myGen.mp3")
        runCatching { out.writeBytes(audioBytes) }
            .onFailure { failToSystem(item, "cache write: " + it.message); return }
        play(ctx, out, myGen, item)
    }

    // ── 播放 ──────────────────────────────────────────────

    private fun play(ctx: Context, file: File, myGen: Int, item: Item) {
        main.post {
            if (stale(myGen)) { file.delete(); pump(); return@post }
            try {
                stopPlayer()
                val mp = MediaPlayer()
                mp.setDataSource(file.absolutePath)
                mp.setOnCompletionListener {
                    it.release(); player = null; file.delete(); finishItem(item)
                }
                mp.setOnErrorListener { _, _, _ ->
                    file.delete(); failToSystem(item, "playback error"); true
                }
                mp.prepare()
                mp.start()
                player = mp
            } catch (t: Throwable) {
                file.delete()
                failToSystem(item, "player prepare: " + t.message)
            }
        }
    }

    private fun stopPlayer() {
        runCatching { player?.stop() }
        runCatching { player?.release() }
        player = null
    }

    // ── 超时/代数 ────────────────────────────────────────

    private fun stale(myGen: Int): Boolean = gen.get() != myGen

    private fun abortCurrent() {
        gen.incrementAndGet()
        runCatching { ws?.cancel() }
        ws = null
        disarmTimeout()
        stopPlayer()
        // 关键：被打断的旧任务不会再走 finish/fail 回调，必须在这里释放流水线，
        // 否则 busy 永远卡在 true，后续所有 enqueue 都被静默丢弃（换音色即触发）
        busy.set(false)
    }

    private fun armTimeout(myGen: Int, item: Item, settleTimeout: () -> Unit) {
        disarmTimeout()
        val r = Runnable {
            if (!stale(myGen)) {
                runCatching { ws?.cancel() }
                settleTimeout()
            }
        }
        timeoutRunnable = r
        main.postDelayed(r, TIMEOUT_MS)
    }

    private fun disarmTimeout() {
        timeoutRunnable?.let { main.removeCallbacks(it) }
        timeoutRunnable = null
    }
}
