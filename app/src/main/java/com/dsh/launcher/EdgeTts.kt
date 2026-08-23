package com.dsh.launcher

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
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Edge TTS —— 参考 rany2/edge-tts 的微软 Edge「大声朗读」接口实现：
 * wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1
 * 经 WebSocket 提交 SSML，回收 audio-24khz-48kbitrate-mono-mp3 音频帧。
 *
 * - WebSocket 用 OkHttp：Android 平台从未移植 OpenJDK 的 java.net.http
 *   （android.jar 编译桩有、真机运行时没有，曾导致 NoClassDefFoundError 闪退），
 *   OkHttp 全 API 版本可用；
 * - 防滥用令牌 Sec-MS-GEC：Windows 文件时间按 5 分钟取整后拼接 TrustedClientToken
 *   再 SHA-256 大写（与 rany2 v6.x 的 DRM 校验一致，缺了会被 403）；
 * - 单飞流水线：合成 → MediaPlayer 播放 → 完成后才取下一条；flush 清队并打断当前；
 * - 合成/播放失败回调 fallback（管理器回退系统 TTS），播报永不哑火；
 * - 临时 MP3 落在 cacheDir，播完即删。
 */
object EdgeTts {

    private const val TRUSTED_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4"
    private const val GEC_VERSION = "1-130.0.2849.68"
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

    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)   // 帧间最大静默；总时长由外层超时兜底
            .build()
    }

    /** 注册上下文与系统 TTS 回退通道。 */
    fun init(context: Context, onFallback: (text: String, flush: Boolean) -> Unit) {
        appCtx = context.applicationContext
        fallback = onFallback
    }

    /** 提交一条播报。flush=true：清空队列并打断当前播放/合成，本条插队最前。 */
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

    /** 全部停止并清空（管理器 release 时调用）。 */
    fun shutdown() {
        synchronized(queue) { queue.clear(); abortCurrent() }
        main.post { stopPlayer() }
    }

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

    private fun failToSystem(item: Item) {
        busy.set(false)
        fallback?.invoke(item.text, item.flush)
        pump()
    }

    // ── WebSocket 合成 ────────────────────────────────────

    private fun gecToken(): String {
        // Windows 文件时间（100ns）；rany2/edge-tts：对齐到 300s 边界再拼 token 取 SHA256 大写
        var ticks = System.currentTimeMillis() / 1000L + 11_644_473_600L
        ticks -= ticks % 300L
        ticks *= 10_000_000L
        val digest = MessageDigest.getInstance("SHA-256")
            .digest((ticks.toString() + TRUSTED_TOKEN).toByteArray())
        return digest.joinToString("") { "%02X".format(it) }
    }

    private fun httpDate(): String =
        SimpleDateFormat("EEE MMM dd yyyy HH:mm:ss 'GMT+0000 (Coordinated Universal Time)'", Locale.US)
            .format(Date())

    private fun ssml(text: String, voice: String): String {
        val escaped = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace("\"", "&quot;").replace("'", "&apos;")
        return "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>" +
            "<voice name='$voice'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>$escaped</prosody></voice></speak>"
    }

    private fun wssUrl(): String =
        "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1" +
            "?TrustedClientToken=$TRUSTED_TOKEN&Sec-MS-GEC=" + gecToken() +
            "&Sec-MS-GEC-Version=$GEC_VERSION"

    private fun startSynth(item: Item) {
        val ctx = appCtx ?: run { failToSystem(item); return }
        val myGen = gen.incrementAndGet()
        val audio = ByteArrayOutputStream()

        val config = "{\"context\":{\"synthesis\":{\"audio\":{\"metadataoptions\":" +
            "{\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"false\"}," +
            "\"outputFormat\":\"audio-24khz-48kbitrate-mono-mp3\"}}}}"
        val configMsg = "X-Timestamp:" + httpDate() +
            "\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n" + config
        val requestMsg = "X-RequestId:" + UUID.randomUUID().toString().replace("-", "") +
            "\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:" + httpDate() + "Z" +
            "\r\nPath:ssml\r\n\r\n" + ssml(item.text, item.voice)

        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (stale(myGen)) { webSocket.cancel(); return }
                webSocket.send(configMsg)
                webSocket.send(requestMsg)
                armTimeout(myGen, item)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (stale(myGen)) { webSocket.cancel(); return }
                if (text.contains("Path:turn.end")) {
                    disarmTimeout()
                    webSocket.close(1000, null)
                    finishSynth(myGen, item, ctx, audio.toByteArray())
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

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (!stale(myGen)) failToSystem(item)
            }
        }

        try {
            val request = Request.Builder()
                .url(wssUrl())
                .header("Origin", "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold")
                .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.68")
                .header("Pragma", "no-cache")
                .header("Cache-Control", "no-cache")
                .build()
            ws = client.newWebSocket(request, listener)
        } catch (t: Throwable) {
            failToSystem(item)
        }
    }

    private fun finishSynth(myGen: Int, item: Item, ctx: Context, audioBytes: ByteArray) {
        disarmTimeout()
        if (audioBytes.isEmpty()) { failToSystem(item); return }
        val out = File(ctx.cacheDir, "edge_tts_$myGen.mp3")
        runCatching { out.writeBytes(audioBytes) }
            .onFailure { failToSystem(item); return }
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
                    file.delete(); failToSystem(item); true
                }
                mp.prepare()
                mp.start()
                player = mp
            } catch (t: Throwable) {
                file.delete()
                failToSystem(item)
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
        gen.incrementAndGet()          // 使所有在途回调失效
        runCatching { ws?.cancel() }   // OkHttp 取消语义
        ws = null
        disarmTimeout()
        stopPlayer()
    }

    private fun armTimeout(myGen: Int, item: Item) {
        disarmTimeout()
        val r = Runnable {
            if (!stale(myGen)) {
                runCatching { ws?.cancel() }
                failToSystem(item)
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
