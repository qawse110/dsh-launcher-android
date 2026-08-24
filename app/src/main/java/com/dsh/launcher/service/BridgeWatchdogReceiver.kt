package com.dsh.launcher.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import java.io.File
import org.json.JSONObject
import com.dsh.launcher.core.*
import com.dsh.launcher.overlay.*
import com.dsh.launcher.service.*
import com.dsh.launcher.tts.*
import com.dsh.launcher.ui.*
import com.dsh.launcher.R

class BridgeWatchdogReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action != StatusBridgeService.WATCHDOG_ACTION) return
        // 用户显式停止过（「停止 dsh 服务」）就不再自续、也不拉起，
        // 否则 watchdog 会永远唤醒；下次启动服务时 scheduleWatchdog 会重新接上链条
        if (!Supervisor.desiredRunning(context)) return
        StatusBridgeService.scheduleWatchdog(context)
        val alive = try {
            val f = File(context.filesDir, "status-bridge-heartbeat.json")
            val obj = JSONObject(f.readText())
            val running = obj.optBoolean("running", false)
            val ts = obj.optLong("ts", 0L)
            running && System.currentTimeMillis() - ts < 60_000L
        } catch (e: Exception) {
            false
        }
        if (!alive) {
            StatusBridgeService.start(context)
        }
    }
}
