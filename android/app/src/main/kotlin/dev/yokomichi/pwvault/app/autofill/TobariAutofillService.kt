package dev.yokomichi.pwvault.app.autofill

import android.os.CancellationSignal
import android.service.autofill.AutofillService
import android.service.autofill.FillCallback
import android.service.autofill.FillRequest
import android.service.autofill.SaveCallback
import android.service.autofill.SaveRequest
import android.util.Log
import dev.yokomichi.pwvault.PwApplication
import dev.yokomichi.pwvault.core.AutofillMatch
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
        // 段 2-3 で実装する
        callback.onSuccess()
    }

    private companion object {
        const val TAG = "pwvault-autofill"
    }
}
