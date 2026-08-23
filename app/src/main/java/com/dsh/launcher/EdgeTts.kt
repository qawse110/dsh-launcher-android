package com.dsh.launcher

import android.content.Context
import android.media.MediaPlayer
import android.os.Handler
import android.os.Looper
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.URI
import java.net.http.HttpClient
import java.net.http.WebSocket
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.ArrayDeque
import java.util.Date
import java.util.Locale
import java.util.UUID
import java.util.concurrent.CompletionStage
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Edge TTS —— 参考 rany2/edge-tts 的微软 Edge「大声朗读」接口实现：
 * wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1
 * 经 WebSocket 提交 SSML，回收 audio-24khz-48kbitrate-mono-mp3 音频帧。
 *
 * - 零第三方依赖：WebSocket 用 API 24+ 的 java.net.http（minSdk 24 恰好覆盖）；
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
    private var playing = false
    private var timeoutRunnable: Runnable? = null

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

    private fun startSynth(item: Item) {
        val ctx = appCtx ?: run { failToSystem(item); return }
        val myGen = gen.incrementAndGet()
        val audio = ByteArrayOutputStream()

        val config = "{\"context\":{\"synthesis\":{\"audio\":{\"metadataoptions\":" +
            "{\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"false\"}," +
            "\"outputFormat\":\"audio-24khz-48kbitrate-mono-mp3\"}}}}"
        val requestMsg = "X-RequestId:" + UUID.randomUUID().toString().replace("-", "") +
            "\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:" + httpDate() + "Z" +
            "\r\nPath:ssml\r\n\r\n" + ssml(item.text, item.voice)

        val listener = object : WebSocket.Listener {
            // android-35 桩里 Listener.onOpen 返回 void（与 OpenJDK 的 CompletionStage 不同），按平台签名覆写
            override fun onOpen(webSocket: WebSocket) {
                if (stale(myGen)) { webSocket.abort(); return null }
                webSocket.sendText("X-Timestamp:" + httpDate() + "\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n$config", true)
                webSocket.sendText(requestMsg, true)
                armTimeout(myGen, item)
                webSocket.request(1)
            }

            override fun onText(webSocket: WebSocket, data: CharSequence, last: Boolean): CompletionStage<Void>? {
                if (stale(myGen)) { webSocket.abort(); return null }
                if (data.contains("Path:turn.end")) {
                    finishSynth(myGen, item, ctx, audio.toByteArray())
                    webSocket.sendClose(WebSocket.NORMAL_CLOSURE, "done")
                    return null
                }
                webSocket.request(1)
                return null
            }

            override fun onBinary(webSocket: WebSocket, data: ByteBuffer, last: Boolean): CompletionStage<Void>? {
                if (stale(myGen)) { webSocket.abort(); return null }
                val arr = ByteArray(data.remaining())
                data.get(arr)
                if (arr.size > 2) {
                    val headerLen = ((arr[0].toInt() and 0xFF) shl 8) or (arr[1].toInt() and 0xFF)
                    if (arr.size > headerLen + 2) audio.write(arr, headerLen + 2, arr.size - headerLen - 2)
                }
                webSocket.request(1)
                return null
            }

            override fun onError(webSocket: WebSocket, error: Throwable) {
                if (!stale(myGen)) failToSystem(item)
            }
        }

        try {
            HttpClient.newHttpClient().newWebSocketBuilder()
                .header("Origin", "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold")
                .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.68")
                .header("Pragma", "no-cache")
                .header("Cache-Control", "no-cache")
                .header("Sec-MS-GEC", gecToken())
                .header("Sec-MS-GEC-Version", GEC_VERSION)
                .buildAsync(
                    URI("wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=$TRUSTED_TOKEN"),
                    listener
                )
                .whenComplete { w, err ->
                    if (err != null || stale(myGen)) {
                        runCatching { w?.abort() }
                        if (!stale(myGen)) failToSystem(item)
                    } else {
                        ws = w
                    }
                }
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
        playing = false
    }

    // ── 超时/代数 ────────────────────────────────────────

    private fun stale(myGen: Int): Boolean = gen.get() != myGen

    private fun abortCurrent() {
        gen.incrementAndGet()          // 使所有在途回调失效
        runCatching { ws?.abort() }
        ws = null
        disarmTimeout()
        stopPlayer()
    }

    private fun armTimeout(myGen: Int, item: Item) {
        disarmTimeout()
        val r = Runnable {
            if (!stale(myGen)) {
                runCatching { ws?.abort() }
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
