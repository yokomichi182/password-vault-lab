package dev.yokomichi.pwvault.app

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
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
    val syncConfigured get() = syncUrl.isNotEmpty() && syncToken.isNotEmpty()
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
