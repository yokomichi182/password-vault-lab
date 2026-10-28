package dev.yokomichi.pwvault.app.autofill

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import android.view.autofill.AutofillManager
import android.widget.Toast
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import dev.yokomichi.pwvault.PwApplication
import dev.yokomichi.pwvault.R
import dev.yokomichi.pwvault.app.AppModel
import dev.yokomichi.pwvault.app.PasswordField
import dev.yokomichi.pwvault.app.authenticate
import dev.yokomichi.pwvault.app.findActivity
import dev.yokomichi.pwvault.core.AutofillMatch
import dev.yokomichi.pwvault.core.AutofillSave
import dev.yokomichi.pwvault.core.PendingSaveStore
import dev.yokomichi.pwvault.core.SavePlan
import kotlinx.coroutines.launch
import java.util.UUID

/**
 * ロック中の解除(と、解除したあとの入力の応答)。設計書 §5-4。
 * インテントで受け取るのは入力欄の AutofillId・要求元のパッケージ名・webDomain だけ。値は受け取らない。
 */
class AutofillAuthActivity : FragmentActivity() {
    private val model get() = (application as PwApplication).model

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 設計書 §5-3: スクリーンショットと最近のアプリ一覧に中身を出さない
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        val saveToken = intent.getStringExtra(AutofillResponses.EXTRA_SAVE_TOKEN)
        val login = if (saveToken == null) AutofillResponses.loginFrom(intent) else null
        if (saveToken == null && (login == null || login.packageName == AutofillMatch.SELF_PACKAGE)) {
            cancel()
            return
        }
        setContent {
            MaterialTheme {
                Scaffold { pad ->
                    Column(Modifier.fillMaxSize().padding(pad).padding(16.dp)) {
                        if (saveToken != null) SaveFlow(model, saveToken, onDone = { finish() })
                        else FillFlow(model, login!!, ::deliver, ::cancel)
                    }
                }
            }
        }
    }

    private fun deliver(response: android.service.autofill.FillResponse?) {
        if (response == null) {
            setResult(Activity.RESULT_CANCELED)
        } else {
            setResult(RESULT_OK, Intent().putExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, response))
        }
        finish()
    }

    private fun cancel() {
        setResult(Activity.RESULT_CANCELED)
        finish()
    }

    // MainActivity と同じに、前面に戻ったときに自動ロックの時間を確かめる
    override fun onStart() {
        super.onStart()
        model.onForeground()
    }

    override fun onStop() {
        super.onStop()
        model.onBackground()
    }
}

/** 解除 → 照合 → 応答、の流れ。 */
@Composable
private fun FillFlow(
    m: AppModel,
    login: ScreenLogin,
    onResult: (android.service.autofill.FillResponse?) -> Unit,
    onCancel: () -> Unit,
) {
    val ctx = LocalContext.current
    var unlocked by remember { mutableStateOf(m.isUnlocked) }
    LaunchedEffect(unlocked) {
        if (!unlocked) return@LaunchedEffect
        val entries = m.autofillEntries()
        if (entries == null) {
            // 読む直前にロックされた。解除からやり直す
            unlocked = false
            return@LaunchedEffect
        }
        val candidates = AutofillMatch.candidates(entries, login.packageName, login.webDomain)
        if (candidates.isEmpty()) Toast.makeText(ctx, R.string.autofill_no_match, Toast.LENGTH_SHORT).show()
        onResult(AutofillResponses.fill(ctx, login, candidates))
    }
    if (!unlocked) {
        UnlockPanel(m, onUnlocked = { unlocked = true }, onCancel = onCancel)
    } else {
        Text(stringResource(R.string.processing))
    }
}

/** アプリの解除画面と同じ手順(マスターパスワード、または設定で有効にした生体認証)。 */
@Composable
internal fun UnlockPanel(m: AppModel, onUnlocked: () -> Unit, onCancel: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var master by remember { mutableStateOf("") }
    val bio = m.biometric.enabled
    fun finishUnlock() {
        if (m.isUnlocked) onUnlocked()
    }
    fun unlockWithBiometric() {
        val activity = ctx.findActivity() ?: return
        val cipher = m.biometric.decryptCipher()
        if (cipher == null) {
            m.message = ctx.getString(R.string.bio_invalidated)
            return
        }
        authenticate(
            activity, cipher, ctx.getString(R.string.open_vault),
            onSuccess = { c ->
                val pw = m.biometric.open(c)
                if (pw == null) m.message = ctx.getString(R.string.bio_open_failed)
                else scope.launch {
                    m.unlock(pw)
                    finishUnlock()
                }
            },
            onFailure = { if (it.isNotEmpty()) m.message = it },
        )
    }
    LaunchedEffect(Unit) {
        m.message = null
        if (bio) unlockWithBiometric()
    }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(stringResource(R.string.autofill_unlock_title), style = MaterialTheme.typography.headlineSmall)
        m.message?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        PasswordField(master, { master = it }, stringResource(R.string.master_password))
        Button(
            onClick = {
                scope.launch {
                    m.unlock(master)
                    master = ""
                    finishUnlock()
                }
            },
            enabled = master.isNotEmpty() && !m.busy,
        ) { Text(stringResource(R.string.open_action)) }
        if (bio) OutlinedButton({ unlockWithBiometric() }, enabled = !m.busy) { Text(stringResource(R.string.open_with_bio)) }
        OutlinedButton(onCancel) { Text(stringResource(R.string.cancel)) }
    }
}

/** 保存の流れ: (ロック中なら解除) → 確認 → 利用者が押したときだけ書く。値は置き場から取り、画面の状態に長く持たない。 */
@Composable
private fun SaveFlow(m: AppModel, token: String, onDone: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val store = PendingSaveStore.shared
    val pending = remember { store.peek(token) }
    if (pending == null) {
        LaunchedEffect(Unit) {
            Toast.makeText(ctx, R.string.autofill_expired, Toast.LENGTH_SHORT).show()
            onDone()
        }
        return
    }
    fun giveUp() {
        store.discard(token)
        onDone()
    }
    var unlocked by remember { mutableStateOf(m.isUnlocked) }
    var plan by remember { mutableStateOf<SavePlan?>(null) }
    var saving by remember { mutableStateOf(false) }
    LaunchedEffect(unlocked) {
        if (!unlocked) return@LaunchedEffect
        val entries = m.autofillEntries()
        if (entries == null) unlocked = false else plan = AutofillSave.plan(entries, pending, UUID.randomUUID().toString())
    }
    val p = plan
    if (!unlocked || p == null) {
        if (!unlocked) UnlockPanel(m, onUnlocked = { unlocked = true }, onCancel = ::giveUp) else Text(stringResource(R.string.processing))
        return
    }
    val e = p.entry
    val where = if (e.androidPackage.isNotEmpty()) stringResource(R.string.autofill_app) to e.androidPackage
    else stringResource(R.string.autofill_site) to e.url
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(
            stringResource(if (p.isUpdate) R.string.autofill_update_title else R.string.autofill_save_title),
            style = MaterialTheme.typography.headlineSmall,
        )
        m.message?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        ConfirmRow(stringResource(R.string.title), AutofillResponses.displayTitle(ctx, e))
        ConfirmRow(stringResource(R.string.username), e.username)
        ConfirmRow(where.first, where.second)
        ConfirmRow(stringResource(R.string.password), "••••••••")
        Button(
            onClick = {
                saving = true
                scope.launch {
                    if (!m.isUnlocked) {
                        // 確認の間に自動ロックされた。値は置き場に残したまま、解除からやり直す
                        saving = false
                        unlocked = false
                        return@launch
                    }
                    // 利用者が押したときだけ、置き場から取り出して書く(取り出したあとは置き場から消える)
                    if (store.take(token) == null) {
                        Toast.makeText(ctx, R.string.autofill_expired, Toast.LENGTH_SHORT).show()
                        onDone()
                        return@launch
                    }
                    m.save(p.entry)
                    if (m.message == null) Toast.makeText(ctx, R.string.autofill_saved, Toast.LENGTH_SHORT).show()
                    onDone()
                }
            },
            enabled = !saving && !m.busy,
        ) { Text(stringResource(if (p.isUpdate) R.string.autofill_update else R.string.save)) }
        OutlinedButton(::giveUp, enabled = !saving) { Text(stringResource(R.string.cancel)) }
    }
}

@Composable
private fun ConfirmRow(label: String, value: String) {
    Column {
        Text(label, style = MaterialTheme.typography.labelMedium)
        Text(value.ifEmpty { "-" })
    }
}
