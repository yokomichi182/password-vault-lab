package dev.yokomichi.pwvault.app

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import dev.yokomichi.pwvault.core.AuditRecorder
import dev.yokomichi.pwvault.core.BreachNotifier
import dev.yokomichi.pwvault.core.BreachResult
import dev.yokomichi.pwvault.R
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** 設計書 §3-1: 同期トークンは Android Keystore の鍵で暗号化して保存する。 */
class KeystoreBox(private val alias: String = "pwvault-settings") {
    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(alias, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    fun seal(plain: String): String {
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val ct = c.doFinal(plain.toByteArray())
        return Base64.encodeToString(c.iv + ct, Base64.NO_WRAP)
    }

    fun open(sealed: String): String? = try {
        val raw = Base64.decode(sealed, Base64.NO_WRAP)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
            .apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, raw, 0, 12)) }
        String(c.doFinal(raw, 12, raw.size - 12))
    } catch (e: Exception) {
        null
    }
}

/** 設定。同期トークンだけ Keystore で暗号化する。 */
class AppSettings(ctx: Context) {
    private val prefs = ctx.getSharedPreferences("settings", Context.MODE_PRIVATE)
    private val box = KeystoreBox()

    var syncUrl: String
        get() = prefs.getString("syncUrl", "") ?: ""
        set(v) = prefs.edit().putString("syncUrl", v.trim()).apply()
    var syncToken: String
        get() = prefs.getString("syncToken", null)?.let(box::open) ?: ""
        set(v) = prefs.edit().putString("syncToken", if (v.isEmpty()) null else box.seal(v.trim())).apply()
    var deviceName: String
        get() = prefs.getString("device", null) ?: android.os.Build.MODEL
        set(v) = prefs.edit().putString("device", v.trim()).apply()
    var autoLockMinutes: Int
        get() = prefs.getInt("autoLock", 5)
        set(v) = prefs.edit().putInt("autoLock", v).apply()
    /** 設計書 §14-2: ロック解除時の自動チェック。既定はオフ。 */
    var autoAudit: Boolean
        get() = prefs.getBoolean("autoAudit", false)
        set(v) = prefs.edit().putBoolean("autoAudit", v).apply()
    val syncConfigured get() = syncUrl.isNotEmpty() && syncToken.isNotEmpty()
}

/**
 * 設計書 §14-3: 漏洩チェックの最終結果。端末内のローカルの設定にだけ置き、保管庫には書かない。
 * 持つのは項目の UUID・日時・出現回数(0 は漏洩なし)だけで、パスワードもそのハッシュも持たない。
 */
class AuditLog(ctx: Context) : AuditRecorder {
    private val prefs = ctx.getSharedPreferences("audit", Context.MODE_PRIVATE)
    // 項目の結果(uuid が鍵)とは別のファイルに、前回のチェックの時刻だけを置く
    private val meta = ctx.getSharedPreferences("audit_meta", Context.MODE_PRIVATE)

    override var lastRunAt: Long
        get() = meta.getLong("lastRunAt", 0L)
        set(v) = meta.edit().putLong("lastRunAt", v).apply()

    /** validAt: パスワードが変わっていないと分かっている最後の時刻。項目の更新がこれより新しければ古い結果。 */
    data class Last(val checkedAt: Long, val count: Int, val validAt: Long)

    fun last(uuid: String): Last? = prefs.getString(uuid, null)?.split(',')?.let {
        val at = it.getOrNull(0)?.toLongOrNull()
        val n = it.getOrNull(1)?.toIntOrNull()
        val valid = it.getOrNull(2)?.toLongOrNull() ?: at
        if (at != null && n != null && valid != null) Last(at, n, valid) else null
    }

    /** パスワード以外だけを編集したとき。結果はそのまま有効。 */
    override fun touch(uuid: String, at: Long) {
        val l = last(uuid) ?: return
        prefs.edit().putString(uuid, "${l.checkedAt},${l.count},$at").apply()
    }

    /** 調べられなかった(Skipped)項目は記録しない。前回の結果を消さないため。 */
    override fun record(uuid: String, result: BreachResult, at: Long) {
        val n = when (result) {
            BreachResult.Clean -> 0
            is BreachResult.Breached -> result.count
            BreachResult.Skipped -> return
        }
        prefs.edit().putString(uuid, "$at,$n,$at").apply()
    }

    override fun forget(uuid: String) = prefs.edit().remove(uuid).apply()
}

/** 設計書 §5-3: コピーして 30 秒後に消す。Android 13 以降は「機密」の印を付ける。 */
object Clip {
    private val handler = Handler(Looper.getMainLooper())
    private var pending: Runnable? = null

    fun copySensitive(ctx: Context, label: String, text: String, clearAfterMs: Long = 30_000) {
        val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = ClipData.newPlainText(label, text)
        clip.description.extras = PersistableBundle().apply { putBoolean("android.content.extra.IS_SENSITIVE", true) }
        cm.setPrimaryClip(clip)
        pending?.let(handler::removeCallbacks)
        val r = Runnable {
            // 自分がコピーしたものが残っているときだけ消す
            if (cm.primaryClip?.getItemAt(0)?.text?.toString() == text) cm.setPrimaryClip(ClipData.newPlainText("", ""))
        }
        pending = r
        handler.postDelayed(r, clearAfterMs)
    }
}

/** 設計書 §14-2: 自動チェックは Wi-Fi のときだけ。 */
fun isOnWifi(ctx: Context): Boolean {
    val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as android.net.ConnectivityManager
    val caps = cm.getNetworkCapabilities(cm.activeNetwork ?: return false) ?: return false
    return caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI)
}

/** 自動チェックで漏洩を検出したときのシステム通知。項目名と出現回数まで。ロック画面には中身を出さない。 */
class SystemBreachNotifier(private val ctx: Context) : BreachNotifier {
    private val nm get() = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager

    override fun canNotify(): Boolean {
        val granted = android.os.Build.VERSION.SDK_INT < 33 ||
            ctx.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == android.content.pm.PackageManager.PERMISSION_GRANTED
        return granted && nm.areNotificationsEnabled()
    }

    override fun notifyBreached(items: List<Pair<String, Int>>) {
        if (items.isEmpty()) return
        nm.createNotificationChannel(
            android.app.NotificationChannel(CHANNEL, ctx.getString(R.string.notif_channel), android.app.NotificationManager.IMPORTANCE_DEFAULT),
        )
        val shown = items.take(5).joinToString("\n") { (title, n) ->
            ctx.getString(R.string.audit_seen, title.ifEmpty { ctx.getString(R.string.untitled) }, n)
        }
        val more = if (items.size > 5) "\n" + ctx.getString(R.string.notif_more, items.size - 5) else ""
        val open = android.app.PendingIntent.getActivity(
            ctx, 0, android.content.Intent(ctx, dev.yokomichi.pwvault.MainActivity::class.java),
            android.app.PendingIntent.FLAG_IMMUTABLE or android.app.PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val public = android.app.Notification.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_launcher_monochrome)
            .setContentTitle(ctx.getString(R.string.notif_title, items.size))
            .build()
        val n = android.app.Notification.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_launcher_monochrome)
            .setContentTitle(ctx.getString(R.string.notif_title, items.size))
            .setContentText(shown.lineSequence().first())
            .setStyle(android.app.Notification.BigTextStyle().bigText(shown + more))
            .setVisibility(android.app.Notification.VISIBILITY_PRIVATE)
            .setPublicVersion(public)
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        nm.notify(NOTIFICATION_ID, n)
    }

    private companion object {
        const val CHANNEL = "breach_check"
        const val NOTIFICATION_ID = 1
    }
}
