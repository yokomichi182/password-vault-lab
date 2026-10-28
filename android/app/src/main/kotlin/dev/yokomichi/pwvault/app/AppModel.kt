package dev.yokomichi.pwvault.app

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.yokomichi.pwvault.core.CsvImport
import dev.yokomichi.pwvault.core.Entry
import dev.yokomichi.pwvault.core.LocalStore
import dev.yokomichi.pwvault.core.SyncClient
import dev.yokomichi.pwvault.core.SyncOutcome
import dev.yokomichi.pwvault.core.VaultRepository
import dev.yokomichi.pwvault.core.WrongPasswordException
import kotlinx.coroutines.CoroutineDispatcher
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
    val settings = AppSettings(ctx)
    private val io: CoroutineDispatcher = Dispatchers.IO.limitedParallelism(1)

    var screen by mutableStateOf<Screen>(if (repo.hasVault) Screen.Unlock else Screen.Setup)
    var entries by mutableStateOf<List<Entry>>(emptyList())
    var busy by mutableStateOf(false)
    var message by mutableStateOf<String?>(null)
    var pendingSync by mutableStateOf(repo.pendingSync)
    var lastSync by mutableStateOf<String?>(null)
    private var backgroundedAt = 0L

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
            message = e.message
        } catch (e: Exception) {
            message = failure
        }
    }

    suspend fun create(master: String, csvText: String?) = guarded("作成に失敗しました") {
        op {
            create(master)
            if (csvText != null) addAll(CsvImport.import(csvText, emptyList(), System.currentTimeMillis()).entries)
        }
        refresh()
        screen = Screen.List
    }

    suspend fun importKdbx(bytes: ByteArray, master: String) = guarded("取り込みに失敗しました") {
        op { importKdbx(bytes, master) }
        refresh()
        screen = Screen.List
    }

    suspend fun unlock(master: String) = guarded("ロック解除に失敗しました") {
        op { unlock(master) }
        refresh()
        screen = Screen.List
        if (settings.syncConfigured) sync()
    }

    fun lock() {
        // 復号済みデータの参照を、まず画面側から外す
        entries = emptyList()
        screen = if (repo.hasVault) Screen.Unlock else Screen.Setup
        repo.lock()
    }

    suspend fun save(e: Entry) = guarded("保存に失敗しました") {
        op { upsert(e) }
        refresh()
        screen = Screen.Detail(e.uuid)
        if (settings.syncConfigured) sync()
    }

    suspend fun delete(uuid: String) = guarded("削除に失敗しました") {
        op { delete(uuid) }
        refresh()
        screen = Screen.List
        if (settings.syncConfigured) sync()
    }

    suspend fun importCsv(text: String): String = try {
        val r = CsvImport.import(text, entries, System.currentTimeMillis())
        op { addAll(r.entries) }
        refresh()
        "${r.entries.size} 件を取り込みました(重複 ${r.duplicates.size} 件は除きました)"
    } catch (e: IllegalArgumentException) {
        e.message ?: "取り込めませんでした"
    } catch (e: Exception) {
        "取り込めませんでした"
    }

    suspend fun export(): ByteArray? = try {
        op { exportKdbx() }
    } catch (e: Exception) {
        message = "書き出しに失敗しました"
        null
    }

    suspend fun sync() {
        if (!settings.syncConfigured) {
            message = "同期の設定がありません"
            return
        }
        try {
            val client = SyncClient(settings.syncUrl, settings.syncToken, "main", settings.deviceName)
            lastSync = when (op { sync(client) }) {
                SyncOutcome.UpToDate -> "変更なし"
                SyncOutcome.Pushed -> "送信しました"
                SyncOutcome.Merged -> "サーバーの変更を取り込みました"
            }
        } catch (e: WrongPasswordException) {
            lastSync = "サーバーの保管庫を開けません(マスターパスワードが違います)"
        } catch (e: Exception) {
            // 通信の失敗では手元の変更は残る。例外の本文は出さない
            lastSync = "同期できませんでした。手元には保存されています"
        }
        refresh()
    }

    // 設計書 §5-3: 自動ロック。画面オフは即時、バックグラウンドは設定の時間を過ぎたら
    fun onBackground() {
        backgroundedAt = System.currentTimeMillis()
    }

    fun onForeground() {
        val limit = settings.autoLockMinutes * 60_000L
        if (repo.isUnlocked && backgroundedAt > 0 && System.currentTimeMillis() - backgroundedAt >= limit) lock()
        backgroundedAt = 0
    }

    fun newEntry() = Entry(UUID.randomUUID().toString(), "", "", "", "", modifiedAt = 0)
}
