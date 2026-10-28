package dev.yokomichi.pwvault.app.autofill

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.service.autofill.Dataset
import android.service.autofill.FillResponse
import android.service.autofill.SaveInfo
import android.view.View
import android.view.autofill.AutofillId
import android.view.autofill.AutofillValue
import android.widget.RemoteViews
import dev.yokomichi.pwvault.R
import dev.yokomichi.pwvault.core.Entry
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.util.concurrent.atomic.AtomicInteger

/**
 * FillResponse / Dataset の組み立て。候補の表示に出すのはタイトルとユーザー名だけで、パスワードは表示に入れない。
 * Dataset や AutofillValue を toString・ログに出さない。
 */
object AutofillResponses {
    const val EXTRA_PACKAGE = "dev.yokomichi.pwvault.autofill.PACKAGE"
    const val EXTRA_WEB_DOMAIN = "dev.yokomichi.pwvault.autofill.WEB_DOMAIN"
    const val EXTRA_USERNAME_ID = "dev.yokomichi.pwvault.autofill.USERNAME_ID"
    const val EXTRA_PASSWORD_ID = "dev.yokomichi.pwvault.autofill.PASSWORD_ID"
    const val EXTRA_NEW_PASSWORD_ID = "dev.yokomichi.pwvault.autofill.NEW_PASSWORD_ID"
    const val EXTRA_SAVE_TOKEN = "dev.yokomichi.pwvault.autofill.SAVE_TOKEN"

    private val requestCodes = AtomicInteger(1)

    /** 同じ Intent(extras を除く)の PendingIntent が使い回されないよう、毎回違う requestCode にする。 */
    fun nextRequestCode(): Int = requestCodes.getAndIncrement()

    /** 表示用のタイトル。空なら URL のホスト、なければパッケージ名。 */
    fun displayTitle(ctx: Context, e: Entry): String {
        if (e.title.isNotBlank()) return e.title
        val host = e.url.takeIf { it.isNotBlank() }?.let {
            (if (it.contains("://")) it else "https://$it").toHttpUrlOrNull()?.host
        }
        return host ?: e.androidPackage.takeIf { it.isNotBlank() } ?: ctx.getString(R.string.untitled)
    }

    fun presentation(ctx: Context, title: String, subtitle: String?): RemoteViews =
        RemoteViews(ctx.packageName, R.layout.autofill_item).apply {
            setTextViewText(R.id.af_title, title)
            if (subtitle.isNullOrEmpty()) setViewVisibility(R.id.af_sub, View.GONE) else setTextViewText(R.id.af_sub, subtitle)
        }

    /** 保存の対象。パスワードの欄(新しいパスワードがあればそちら)が必須、ユーザー名は任意。 */
    fun saveInfo(login: ScreenLogin): SaveInfo? {
        val required = login.newPassword ?: login.password ?: return null
        return SaveInfo.Builder(SaveInfo.SAVE_DATA_TYPE_PASSWORD, arrayOf(required)).apply {
            login.username?.let { setOptionalIds(arrayOf(it)) }
        }.build()
    }

    private fun dataset(ctx: Context, e: Entry, username: AutofillId?, password: AutofillId): Dataset {
        val b = Dataset.Builder(presentation(ctx, displayTitle(ctx, e), e.username.ifBlank { null }))
        if (username != null) b.setValue(username, AutofillValue.forText(e.username))
        b.setValue(password, AutofillValue.forText(e.password))
        return b.build()
    }

    /**
     * 開いているときの応答。候補がなければ、候補は出さずに保存の情報だけ付ける(新しいログインの保存を尋ねるため)。
     * 入力する欄(現在のパスワード)がなければ、保存の情報だけ。付けるものが何もなければ null。
     */
    fun fill(ctx: Context, login: ScreenLogin, candidates: List<Entry>): FillResponse? {
        val b = FillResponse.Builder()
        val pw = login.password
        var datasets = 0
        if (pw != null) for (e in candidates) {
            b.addDataset(dataset(ctx, e, login.username, pw))
            datasets++
        }
        val save = saveInfo(login)
        if (save != null) b.setSaveInfo(save)
        if (datasets == 0 && save == null) return null
        return b.build()
    }

    /** ロック中の応答。照合せず、「ロックを解除して入力」の1つだけを出す(件数・項目名は出さない)。 */
    fun locked(ctx: Context, login: ScreenLogin): FillResponse {
        val ids = listOfNotNull(login.username, login.password).toTypedArray()
        val intent = Intent(ctx, AutofillAuthActivity::class.java)
            .putExtra(EXTRA_PACKAGE, login.packageName)
            .putExtra(EXTRA_WEB_DOMAIN, login.webDomain)
            .putExtra(EXTRA_USERNAME_ID, login.username)
            .putExtra(EXTRA_PASSWORD_ID, login.password)
            .putExtra(EXTRA_NEW_PASSWORD_ID, login.newPassword)
        // フレームワークが結果の受け取りに要る情報を足せるよう、変更可能にする
        val sender = PendingIntent.getActivity(
            ctx, nextRequestCode(), intent, PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_CANCEL_CURRENT,
        ).intentSender
        val b = FillResponse.Builder()
            .setAuthentication(ids, sender, presentation(ctx, ctx.getString(R.string.autofill_unlock_and_fill), null))
        saveInfo(login)?.let { b.setSaveInfo(it) }
        return b.build()
    }

    /** 認証画面に渡された extras から、欄の情報を組み直す。 */
    fun loginFrom(intent: Intent): ScreenLogin? {
        val pkg = intent.getStringExtra(EXTRA_PACKAGE) ?: return null
        @Suppress("DEPRECATION")
        fun id(name: String): AutofillId? = intent.getParcelableExtra(name)
        val pw = id(EXTRA_PASSWORD_ID)
        val newPw = id(EXTRA_NEW_PASSWORD_ID)
        if (pw == null && newPw == null) return null
        return ScreenLogin(pkg, intent.getStringExtra(EXTRA_WEB_DOMAIN), id(EXTRA_USERNAME_ID), pw, newPw)
    }
}
