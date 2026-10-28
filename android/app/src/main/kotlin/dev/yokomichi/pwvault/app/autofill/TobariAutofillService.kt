package dev.yokomichi.pwvault.app.autofill

import android.app.PendingIntent
import android.app.assist.AssistStructure
import android.content.Intent
import android.os.CancellationSignal
import android.service.autofill.AutofillService
import android.service.autofill.FillCallback
import android.service.autofill.FillRequest
import android.service.autofill.SaveCallback
import android.service.autofill.SaveRequest
import android.util.Log
import dev.yokomichi.pwvault.PwApplication
import dev.yokomichi.pwvault.core.AutofillMatch
import dev.yokomichi.pwvault.core.PendingLogin
import dev.yokomichi.pwvault.core.PendingSaveStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * 設計書 §5-4: 自動入力。コールバックはメインスレッドで呼ばれるので、保管庫の読み取りは AppModel の
 * 1本のスレッドに回し、結果は取り消されなければコールバックで返す。
 * AssistStructure・FillRequest・Dataset・AutofillValue・URL・ユーザー名をログや例外に出さない。
 */
class TobariAutofillService : AutofillService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val model get() = (application as PwApplication).model

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    override fun onFillRequest(request: FillRequest, cancellationSignal: CancellationSignal, callback: FillCallback) {
        try {
            // 自動ロックを先に確かめる(バックグラウンドの間に時間を過ぎていれば、ここでロックされる)
            model.enforceAutoLock()
            val structure = request.fillContexts.lastOrNull()?.structure
            if (structure == null) {
                callback.onSuccess(null)
                return
            }
            val login = ScreenParser.resolve(ScreenParser.parse(structure, withValues = false))
            // Tobari 自身の画面と、ログイン欄のない画面には何も出さない
            if (login == null || login.packageName == AutofillMatch.SELF_PACKAGE) {
                callback.onSuccess(null)
                return
            }
            // 入力する欄(現在のパスワード)がなければ、読み取りもせず保存の情報だけ
            if (login.password == null) {
                callback.onSuccess(AutofillResponses.fill(this, login, emptyList()))
                return
            }
            if (!model.isUnlocked) {
                callback.onSuccess(AutofillResponses.locked(this, login))
                return
            }
            val job = scope.launch {
                val response = try {
                    val entries = model.autofillEntries()
                    if (entries == null) AutofillResponses.locked(this@TobariAutofillService, login)
                    else AutofillResponses.fill(
                        this@TobariAutofillService, login,
                        AutofillMatch.candidates(entries, login.packageName, login.webDomain),
                    )
                } catch (e: kotlinx.coroutines.CancellationException) {
                    throw e
                } catch (e: Exception) {
                    Log.w(TAG, "fill failed: ${e.javaClass.simpleName}")
                    null
                }
                callback.onSuccess(response)
            }
            // 取り消されたら応答しない
            cancellationSignal.setOnCancelListener { job.cancel() }
        } catch (e: Exception) {
            Log.w(TAG, "fill request failed: ${e.javaClass.simpleName}")
            callback.onSuccess(null)
        }
    }

    override fun onSaveRequest(request: SaveRequest, callback: SaveCallback) {
        try {
            val structure = request.fillContexts.lastOrNull()?.structure
            val picked = structure?.let { pickSaved(it) }
            if (picked == null) {
                callback.onSuccess()
                return
            }
            // 受け取った値はメモリの置き場だけに置き、画面には合言葉だけを渡す
            val token = PendingSaveStore.shared.put(picked)
            val intent = Intent(this, AutofillAuthActivity::class.java).putExtra(AutofillResponses.EXTRA_SAVE_TOKEN, token)
            val sender = PendingIntent.getActivity(
                this, AutofillResponses.nextRequestCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_CANCEL_CURRENT,
            ).intentSender
            callback.onSuccess(sender)
        } catch (e: Exception) {
            Log.w(TAG, "save request failed: ${e.javaClass.simpleName}")
            callback.onSuccess()
        }
    }

    /**
     * 保存する値を画面から取り出す。まず見える欄だけで判定し、値が取れなければ(送信後に欄が消えた画面など)
     * 見えない欄も含めて判定する。パスワードが空なら保存しない。
     */
    private fun pickSaved(structure: AssistStructure): PendingLogin? {
        for (ignoreVisibility in listOf(false, true)) {
            val screen = ScreenParser.parse(structure, withValues = true, ignoreVisibility = ignoreVisibility)
            val login = ScreenParser.resolve(screen) ?: continue
            if (login.packageName == AutofillMatch.SELF_PACKAGE) return null
            val password = ScreenParser.valueOf(screen, login.newPassword ?: login.password)
            if (password.isNullOrEmpty()) continue
            val username = ScreenParser.valueOf(screen, login.username).orEmpty().trim()
            return PendingLogin(username, password, login.packageName, login.webDomain, appLabel(login.packageName))
        }
        return null
    }

    // 表示名が引けないときは空(タイトルはパッケージ名になる)
    private fun appLabel(packageName: String): String = try {
        packageManager.getApplicationLabel(packageManager.getApplicationInfo(packageName, 0)).toString()
    } catch (e: Exception) {
        ""
    }

    private companion object {
        const val TAG = "pwvault-autofill"
    }
}
