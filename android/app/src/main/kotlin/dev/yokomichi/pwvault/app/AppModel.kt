package dev.yokomichi.pwvault.app

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.yokomichi.pwvault.R
import dev.yokomichi.pwvault.core.AuditCoordinator
import dev.yokomichi.pwvault.core.AuditReport
import dev.yokomichi.pwvault.core.AutoLock
import dev.yokomichi.pwvault.core.BreachChecker
import dev.yokomichi.pwvault.core.CsvFormatException
import dev.yokomichi.pwvault.core.CsvImport
import dev.yokomichi.pwvault.core.HistoryItem
import dev.yokomichi.pwvault.core.Entry
import dev.yokomichi.pwvault.core.LocalStore
import dev.yokomichi.pwvault.core.SyncClient
import dev.yokomichi.pwvault.core.SyncOutcome
import dev.yokomichi.pwvault.core.VaultRepository
import dev.yokomichi.pwvault.core.WrongPasswordException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.withContext
import java.io.File
import java.util.UUID

sealed interface Screen {
    data object Setup : Screen
    data object Unlock : Screen
    data object List : Screen
    data class Detail(val uuid: String) : Screen
    data class Edit(val uuid: String?) : Screen
    data object Settings : Screen
}

/**
 * 画面の状態。保管庫への操作はすべて1本のスレッドに順番に流す（同期中の編集と競合しない）。
 * 画面に出すメッセージには、パスワードや URL・トークンの値を入れない。
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AppModel(ctx: Context) {
    private val repo = VaultRepository(LocalStore(File(ctx.filesDir, "vault")))
    private val app = ctx.applicationContext
    val settings = AppSettings(ctx)
    val biometric = BiometricVault(ctx)
    val auditLog = AuditLog(ctx)
    // 漏洩チェックの3つの経路(保存後・手動・ロック解除時)は、ここを通して isLogin で絞る
    private val audits = AuditCoordinator(
        checker = { BreachChecker(baseUrl = breachBaseUrl(app), http = auditHttp()) },
        recorder = auditLog,
        notifier = SystemBreachNotifier(ctx.applicationContext),
    )
    private val background = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    // 画面の切り替えで取り消されないように、操作の直後の同期はアプリの寿命のスコープで走らせる
    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val io: CoroutineDispatcher = Dispatchers.IO.limitedParallelism(1)

    var screen by mutableStateOf<Screen>(if (repo.hasVault) Screen.Unlock else Screen.Setup)
    var entries by mutableStateOf<List<Entry>>(emptyList())
    var busy by mutableStateOf(false)
    var message by mutableStateOf<String?>(null)
    var pendingSync by mutableStateOf(repo.pendingSync)
    var lastSync by mutableStateOf<String?>(null)
    var auditing by mutableStateOf(false)
    var auditReport by mutableStateOf<AuditReport?>(null)
    // ロック解除時の自動チェックで漏洩が見つかったとき、一覧の上に出す。通知の許可がなくても出る
    var autoAuditReport by mutableStateOf<AuditReport?>(null)
    // 詳細画面の「最終チェック」を、結果が変わったときに描き直すための印
    var auditStamp by mutableStateOf(0)
    private var backgroundedAt = 0L

    // 画面の言語は端末の設定に従う。文言はリソースから引く
    private fun t(id: Int, vararg args: Any): String = app.getString(id, *args)

    private suspend fun <T> op(block: VaultRepository.() -> T): T {
        busy = true
        try {
            return withContext(io) { repo.block() }
        } finally {
            busy = false
        }
    }

    private fun refresh() {
        entries = if (repo.isUnlocked) repo.entries.sortedBy { it.title.lowercase() } else emptyList()
        pendingSync = repo.pendingSync
    }

    private suspend fun guarded(failure: String, block: suspend () -> Unit) {
        message = null
        try {
            block()
        } catch (e: WrongPasswordException) {
            message = t(R.string.wrong_password)
        } catch (e: Exception) {
            message = failure
        }
    }

    suspend fun create(master: String, csvText: String?) = guarded(t(R.string.err_create)) {
        op {
            create(master)
            if (csvText != null) addAll(CsvImport.import(csvText, emptyList(), System.currentTimeMillis()).entries)
        }
        refresh()
        screen = Screen.List
    }

    suspend fun importKdbx(bytes: ByteArray, master: String) = guarded(t(R.string.err_import)) {
        op { importKdbx(bytes, master) }
        refresh()
        screen = Screen.List
    }

    suspend fun unlock(master: String) = guarded(t(R.string.err_unlock)) {
        op { unlock(master) }
        refresh()
        screen = Screen.List
        if (settings.syncConfigured) appScope.launch { sync() }
        autoAuditIfDue()
    }

    /**
     * 設計書 §14-2: ロック解除のとき、設定が有効で Wi-Fi で前回から 7 日以上なら調べる。
     * パスワードで開いても生体認証で開いても [unlock] を通るので、同じ条件になる。
     */
    private fun autoAuditIfDue() {
        if (!settings.autoAudit) return
        val target = entries
        val enabled = settings.autoAudit
        val wifi = isOnWifi(app)
        background.launch {
            val report = runCatching { audits.runAuto(target, enabled, wifi) }.getOrNull() ?: return@launch
            // 画面の状態はメインスレッドで書く
            withContext(Dispatchers.Main) {
                if (repo.isUnlocked) {
                    autoAuditReport = report.takeIf { it.breached.isNotEmpty() }
                    auditStamp++
                }
            }
        }
    }

    /** 生体認証の登録。保管庫が開いているときだけ、マスターパスワードを取り出して渡す。 */
    fun masterForBiometric(): String? = if (repo.isUnlocked) repo.masterForBiometric() else null

    suspend fun history(): List<HistoryItem>? = try {
        withContext(io) { SyncClient(settings.syncUrl, settings.syncToken, "main", settings.deviceName).history() }
    } catch (e: Exception) {
        message = t(R.string.err_history)
        null
    }

    /** 設計書 §3-3: 履歴の版に戻し、そのまま同期して他の端末にも反映する。 */
    suspend fun restore(item: HistoryItem): String {
        try {
            val bytes = withContext(io) {
                SyncClient(settings.syncUrl, settings.syncToken, "main", settings.deviceName).getVersion(item.version)
            }
            op { restoreFrom(bytes, item.version.toString()) }
        } catch (e: WrongPasswordException) {
            return t(R.string.err_restore_wrong_pw)
        } catch (e: Exception) {
            return t(R.string.err_restore)
        }
        refresh()
        sync()
        return t(R.string.restored, item.version)
    }

    fun lock() {
        // 復号済みデータの参照を、まず画面側から外す
        entries = emptyList()
        autoAuditReport = null
        screen = if (repo.hasVault) Screen.Unlock else Screen.Setup
        repo.lock()
    }

    suspend fun save(e: Entry) = guarded(t(R.string.err_save)) {
        val old = repo.entry(e.uuid)
        op { upsert(e) }
        refresh()
        // 設計書 §14-3: パスワードが新しくなったとき(API キーからの変更を含む)は、保存の直後に1回だけ調べる。
        // 種類がパスワードでない項目は、SHA-1 も計算せず送らない
        audits.onSaved(old, e)?.let { checkOneInBackground(e.uuid, it) }
        auditStamp++
        screen = Screen.Detail(e.uuid)
        if (settings.syncConfigured) appScope.launch { sync() }
    }

    suspend fun delete(uuid: String) = guarded(t(R.string.err_delete)) {
        op { delete(uuid) }
        auditLog.forget(uuid)
        refresh()
        screen = Screen.List
        if (settings.syncConfigured) appScope.launch { sync() }
    }

    suspend fun importCsv(text: String): String = try {
        val r = CsvImport.import(text, entries, System.currentTimeMillis())
        op { addAll(r.entries) }
        refresh()
        t(R.string.csv_imported, r.entries.size, r.duplicates.size)
    } catch (e: CsvFormatException) {
        t(if (e.reason == CsvFormatException.Reason.EMPTY) R.string.csv_empty else R.string.csv_unsupported)
    } catch (e: Exception) {
        t(R.string.csv_failed)
    }

    suspend fun export(): ByteArray? = try {
        op { exportKdbx() }
    } catch (e: Exception) {
        message = t(R.string.err_export)
        null
    }

    suspend fun sync() {
        if (!settings.syncConfigured) {
            message = t(R.string.no_sync_config)
            return
        }
        try {
            val client = SyncClient(settings.syncUrl, settings.syncToken, "main", settings.deviceName)
            lastSync = when (op { sync(client) }) {
                SyncOutcome.UpToDate -> t(R.string.sync_nochange)
                SyncOutcome.Pushed -> t(R.string.sync_pushed)
                SyncOutcome.Merged -> t(R.string.sync_merged)
            }
        } catch (e: WrongPasswordException) {
            lastSync = t(R.string.sync_wrong_pw)
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            // 通信の失敗では手元の変更は残る。例外の本文は出さず、種類だけ残す
            android.util.Log.w("pwvault", "sync failed: ${e.javaClass.simpleName}")
            lastSync = t(R.string.sync_failed)
        }
        refresh()
    }

    /** 設計書 §14-2: 設定画面の「漏洩チェック」。全項目を調べ、結果を端末内に記録する。 */
    suspend fun audit() {
        if (auditing || !repo.isUnlocked) return
        auditing = true
        message = null
        try {
            val target = entries
            auditReport = withContext(Dispatchers.IO) { audits.auditAll(target) }
            auditStamp++
        } catch (e: Exception) {
            message = t(R.string.err_audit)
        } finally {
            auditing = false
        }
    }

    // 保存の時点で SHA-1 を計算し、バックグラウンドにはハッシュだけを渡す（通信の間、パスワードをメモリに残さない）
    private fun checkOneInBackground(uuid: String, hash: String) {
        background.launch {
            audits.checkOne(uuid, hash)
            withContext(Dispatchers.Main) { auditStamp++ }
        }
    }

    // 設計書 §14: 通信できないときに長く待たせない
    private fun auditHttp() = okhttp3.OkHttpClient.Builder()
        .connectTimeout(5, java.util.concurrent.TimeUnit.SECONDS)
        .callTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
        .build()

    // 設計書 §5-3: 自動ロック。画面オフは即時、バックグラウンドは設定の時間を過ぎたら
    fun onBackground() {
        backgroundedAt = System.currentTimeMillis()
    }

    fun onForeground() {
        enforceAutoLock()
        backgroundedAt = 0
    }

    /**
     * バックグラウンドに回ってから設定の時間を過ぎていればロックする。アプリの画面と自動入力の両方から呼ぶ。
     * メインスレッドで呼ぶこと(画面の状態を書き換えるため)。
     */
    fun enforceAutoLock(now: Long = System.currentTimeMillis()) {
        if (AutoLock.due(repo.isUnlocked, backgroundedAt, now, settings.autoLockMinutes * 60_000L)) lock()
    }

    val isUnlocked: Boolean get() = repo.isUnlocked

    /** 自動入力用の読み取り。アプリの画面と同じ1本のスレッドを通す。ロック中は null。 */
    suspend fun autofillEntries(): List<Entry>? = withContext(io) {
        if (repo.isUnlocked) runCatching { repo.entries }.getOrNull() else null
    }

    fun newEntry() = Entry(UUID.randomUUID().toString(), "", "", "", "", modifiedAt = 0)
}
