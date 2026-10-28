package dev.yokomichi.pwvault.app

import dev.yokomichi.pwvault.R
import android.content.Context
import android.content.ContextWrapper
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * 設計書 §5-3: 生体認証での解除。
 * マスターパスワードを、生体認証が要る Keystore の鍵(登録の変更で無効になる)で暗号化して保存し、
 * BiometricPrompt の CryptoObject を通したときだけ取り出す。値はログやメッセージに出さない。
 */
class BiometricVault(private val ctx: Context) {
    private val prefs = ctx.getSharedPreferences("biometric", Context.MODE_PRIVATE)

    val enabled get() = prefs.contains(BLOB)

    fun available() =
        BiometricManager.from(ctx).canAuthenticate(BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS

    private fun keystore() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun newKey(): SecretKey {
        val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true)
            .apply {
                // 暗号操作のたびに認証を求める(認証の有効時間を持たせない)
                if (Build.VERSION.SDK_INT >= 30) setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
                else @Suppress("DEPRECATION") setUserAuthenticationValidityDurationSeconds(-1)
            }
            .build()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
            .apply { init(spec) }.generateKey()
    }

    /** 登録用の暗号化 Cipher。鍵は作り直す(前の登録は無効にする)。 */
    fun encryptCipher(): Cipher {
        keystore().deleteEntry(ALIAS)
        return Cipher.getInstance(TRANSFORM).apply { init(Cipher.ENCRYPT_MODE, newKey()) }
    }

    fun store(cipher: Cipher, master: String) {
        val ct = cipher.doFinal(master.toByteArray())
        prefs.edit()
            .putString(BLOB, Base64.encodeToString(ct, Base64.NO_WRAP))
            .putString(IV, Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .apply()
    }

    /** 解除用の復号 Cipher。鍵が無効になっているか無いときは登録を消し、その他の失敗では登録を残して null を返す。 */
    fun decryptCipher(): Cipher? {
        val iv = prefs.getString(IV, null)?.let { Base64.decode(it, Base64.NO_WRAP) } ?: return null
        return try {
            val key = keystore().getKey(ALIAS, null) as? SecretKey ?: run { disable(); return null }
            Cipher.getInstance(TRANSFORM).apply { init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv)) }
        } catch (e: KeyPermanentlyInvalidatedException) {
            disable()
            null
        } catch (e: Exception) {
            // 一時的な失敗では登録を消さない
            null
        }
    }

    fun open(cipher: Cipher): String? = try {
        val ct = Base64.decode(prefs.getString(BLOB, null) ?: return null, Base64.NO_WRAP)
        String(cipher.doFinal(ct))
    } catch (e: Exception) {
        null
    }

    fun disable() {
        prefs.edit().clear().apply()
        runCatching { keystore().deleteEntry(ALIAS) }
    }

    private companion object {
        const val ALIAS = "pwvault-biometric"
        const val BLOB = "blob"
        const val IV = "iv"
        const val TRANSFORM = "AES/GCM/NoPadding"
    }
}

fun Context.findActivity(): FragmentActivity? {
    var c: Context? = this
    while (c is ContextWrapper) {
        if (c is FragmentActivity) return c
        c = c.baseContext
    }
    return null
}

/** BiometricPrompt を出し、認証できたら CryptoObject の Cipher を渡す。失敗の理由は文言だけ返す。 */
fun authenticate(
    activity: FragmentActivity,
    cipher: Cipher,
    title: String,
    onSuccess: (Cipher) -> Unit,
    onFailure: (String) -> Unit,
) {
    val prompt = BiometricPrompt(
        activity,
        ContextCompat.getMainExecutor(activity),
        object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                val c = result.cryptoObject?.cipher
                if (c != null) onSuccess(c) else onFailure(activity.getString(R.string.bio_unverified))
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                // ユーザーが取り消したときは何も出さない
                if (errorCode == BiometricPrompt.ERROR_USER_CANCELED || errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON ||
                    errorCode == BiometricPrompt.ERROR_CANCELED
                ) onFailure("") else onFailure(activity.getString(R.string.bio_failed))
            }
        },
    )
    val info = BiometricPrompt.PromptInfo.Builder()
        .setTitle(title)
        .setNegativeButtonText(activity.getString(R.string.bio_cancel))
        .setAllowedAuthenticators(BIOMETRIC_STRONG)
        .build()
    prompt.authenticate(info, BiometricPrompt.CryptoObject(cipher))
}
