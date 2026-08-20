package com.dsh.launcher

import android.content.SharedPreferences
import android.os.Handler
import android.os.Looper
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL

/**
 * 桌宠 LLM 气泡客户端（移植自 codex-pet-live 的 llm_client.py，简化为气泡场景）：
 * - OpenAI 兼容 /chat/completions 接口（DeepSeek / Ollama / 任意兼容服务）；
 * - 异步请求，成功回调生成的台词；失败/超时回退为空串，由调用方用本地台词兜底；
 * - 无第三方依赖，使用 HttpURLConnection + org.json。
 */
object PetLlm {

    data class Config(
        val enabled: Boolean,
        val baseUrl: String,
        val apiKey: String,
        val model: String
    ) {
        /** 开关打开且 baseUrl / model 均已配置才算可用。 */
        fun usable(): Boolean = enabled && baseUrl.isNotBlank() && model.isNotBlank()
    }

    fun config(prefs: SharedPreferences): Config = Config(
        enabled = prefs.getBoolean("pet_llm", false),
        baseUrl = prefs.getString("pet_llm_base_url", "") ?: "",
        apiKey = prefs.getString("pet_llm_api_key", "") ?: "",
        model = prefs.getString("pet_llm_model", "") ?: ""
    )

    private const val SYSTEM_PROMPT =
        "你是一只小桌面宠物。请用一句温暖俏皮、简洁的气泡短句回复，不超过 40 个汉字。" +
            "不要提及你是 AI 模型，不要使用 Markdown 或引号。"

    /**
     * 按事件生成一句气泡台词。回调在主线程执行；
     * 失败时回调空字符串（调用方负责回退本地台词）。
     */
    fun bubbleReply(cfg: Config, event: String, petName: String, onResult: (String) -> Unit) {
        val mainHandler = Handler(Looper.getMainLooper())
        Thread({
            var reply: String? = null
            try {
                reply = requestChatCompletion(cfg, event, petName)
            } catch (_: Exception) {
                reply = null
            }
            val text = reply ?: ""
            mainHandler.post { onResult(text) }
        }, "dsh-pet-llm").start()
    }

    private fun requestChatCompletion(cfg: Config, event: String, petName: String): String {
        val base = cfg.baseUrl.trim().trimEnd('/')
        val urlStr = if (base.endsWith("/chat/completions")) {
            base
        } else {
            val v1 = if (base.endsWith("/v1")) base else "$base/v1"
            "$v1/chat/completions"
        }
        val conn = URL(urlStr).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.connectTimeout = 8000
            conn.readTimeout = 20_000
            conn.setRequestProperty("Content-Type", "application/json")
            if (cfg.apiKey.isNotBlank()) {
                conn.setRequestProperty("Authorization", "Bearer ${cfg.apiKey}")
            }
            conn.doOutput = true

            val messages = JSONArray()
                .put(JSONObject().put("role", "system").put("content", SYSTEM_PROMPT))
                .put(
                    JSONObject()
                        .put("role", "user")
                        .put(
                            "content",
                            "事件：$event\n" +
                                "宠物名：${petName.ifBlank { "桌宠" }}\n" +
                                "回复语言：中文\n" +
                                "只输出气泡文本。"
                        )
                )
            val body = JSONObject()
                .put("model", cfg.model)
                .put("temperature", 0.8)
                .put("max_tokens", 60)
                .put("messages", messages)
            conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }

            val code = conn.responseCode
            if (code !in 200..299) {
                throw RuntimeException("LLM HTTP $code")
            }
            val text = BufferedReader(InputStreamReader(conn.inputStream, Charsets.UTF_8)).use { it.readText() }
            val root = JSONObject(text)
            val content = root.getJSONArray("choices")
                .getJSONObject(0)
                .getJSONObject("message")
                .getString("content")
            return content.trim().trim('"').replace(Regex("\\s+"), " ").take(120)
        } finally {
            conn.disconnect()
        }
    }
}