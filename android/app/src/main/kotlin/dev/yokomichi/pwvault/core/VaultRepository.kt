package dev.yokomichi.pwvault.core

import java.io.File

/** 端末内の保管庫ファイル（暗号文）と、同期の状態を置く場所。平文は置かない。 */
class LocalStore(private val dir: File) {
    private val vaultFile get() = File(dir, "vault.kdbx")
    private val metaFile get() = File(dir, "sync.meta")
    private val backups get() = File(dir, "backups")

    init { dir.mkdirs() }

    fun exists() = vaultFile.exists()
    fun readVault(): ByteArray = vaultFile.readBytes()

    /** 手元の保管庫と同期の状態を一緒に書く。途中で止まっても半端なファイルが残らないよう、置き換えで書く。 */
    fun write(bytes: ByteArray, baseVersion: Int, dirty: Boolean) {
        atomic(vaultFile, bytes)
        atomic(metaFile, "$baseVersion,$dirty".toByteArray())
    }

    /** 同期の状態。保管庫が無ければ null。baseVersion は最後に同期した版（未同期は 0）。 */
    fun meta(): Meta? {
        if (!vaultFile.exists()) return null
        val p = metaFile.takeIf { it.exists() }?.readText()?.split(",")
        return Meta(p?.getOrNull(0)?.toIntOrNull() ?: 0, p?.getOrNull(1)?.toBooleanStrictOrNull() ?: true)
    }

    /** 設計書 §4-5: マージの前に手元の版を退避する。古いものから消して最大 [keep] 個残す。 */
    fun backup(bytes: ByteArray, label: String, keep: Int = 10) {
        backups.mkdirs()
        atomic(File(backups, "$label.kdbx"), bytes)
        backups.listFiles()?.sortedBy { it.name }?.dropLast(keep)?.forEach { it.delete() }
    }

    fun backupNames(): List<String> = backups.listFiles()?.map { it.name }?.sorted().orEmpty()

    private fun atomic(target: File, bytes: ByteArray) {
        val tmp = File(target.parentFile, target.name + ".tmp")
        tmp.writeBytes(bytes)
        if (!tmp.renameTo(target)) {
            target.delete()
            check(tmp.renameTo(target)) { "保存に失敗しました" }
        }
    }

    data class Meta(val baseVersion: Int, val dirty: Boolean)
}

sealed interface SyncOutcome {
    data object UpToDate : SyncOutcome
    data object Pushed : SyncOutcome
    /** サーバー側に変更があり、取り込んだ（手元に変更があればマージして送った）。 */
    data object Merged : SyncOutcome
}

class WrongPasswordException : Exception("マスターパスワードが違うか、保管庫のファイルが壊れています")

/**
 * 画面から使う保管庫の窓口。復号済みのデータはここだけが持ち、[lock] で参照ごと捨てる（設計書 §5-3）。
 * 値（パスワードなど）をログやメッセージに出さない。
 */
class VaultRepository(
    private val store: LocalStore,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private var vault: KdbxVault? = null
    private var master: String? = null
    private var data: VaultData = VaultData()

    val isUnlocked get() = vault != null
    val hasVault get() = store.exists()
    val entries: List<Entry> get() = checkUnlocked().let { data.entries }
    fun entry(uuid: String): Entry? = entries.firstOrNull { it.uuid == uuid }
    val pendingSync get() = store.meta()?.dirty ?: false

    /** 新しい保管庫を作る（初期設定）。 */
    fun create(masterPassword: String, initial: List<Entry> = emptyList()) {
        val v = KdbxVault.create(masterPassword).withData(VaultData(initial))
        store.write(v.encode(), 0, true)
        open(v, masterPassword)
    }

    /** 取り込み: 既存の .kdbx を手元の保管庫にする。 */
    fun importKdbx(bytes: ByteArray, masterPassword: String) {
        val v = try { KdbxVault.open(bytes, masterPassword) } catch (e: Exception) { throw WrongPasswordException() }
        store.write(bytes, 0, true)
        open(v, masterPassword)
    }

    fun unlock(masterPassword: String) {
        val v = try { KdbxVault.open(store.readVault(), masterPassword) } catch (e: Exception) { throw WrongPasswordException() }
        open(v, masterPassword)
    }

    fun lock() {
        vault = null
        master = null
        data = VaultData()
    }

    /** 追加と更新。uuid が既にあれば置き換える。保存は端末内だけで、同期は [sync] が行う。 */
    fun upsert(e: Entry) {
        val stamped = e.copy(modifiedAt = now())
        val next = data.copy(
            entries = data.entries.filter { it.uuid != e.uuid } + stamped,
            deleted = data.deleted - e.uuid,
        )
        commit(next)
    }

    fun delete(uuid: String) {
        commit(data.copy(entries = data.entries.filter { it.uuid != uuid }, deleted = data.deleted + (uuid to now())))
    }

    fun addAll(list: List<Entry>) {
        commit(data.copy(entries = data.entries + list.map { it.copy(modifiedAt = now()) }))
    }

    /**
     * 設計書 §3-3: 履歴の版(暗号文)の中身に戻す。手元の版は先に退避する。
     * 戻した項目は「いまの更新」として積み直し、いまあって戻し先に無い項目は削除として記録する。
     * こうしておくと、次の同期でサーバー側の新しい版のマージに負けない。
     */
    fun restoreFrom(bytes: ByteArray, label: String) {
        val current = checkUnlocked()
        val old = try { KdbxVault.open(bytes, checkNotNull(master)).data() } catch (e: Exception) { throw WrongPasswordException() }
        store.backup(current.encode(), "%013d-restore-%s".format(now(), label))
        val t = now()
        val oldIds = old.entries.map { it.uuid }.toSet()
        val removed = data.entries.filter { it.uuid !in oldIds }.associate { it.uuid to t }
        val deleted = (data.deleted + old.deleted).filterKeys { it !in oldIds } + removed
        commit(VaultData(old.entries.map { it.copy(modifiedAt = t + 1) }, deleted))
    }

    /** 生体認証の登録用。マスターパスワードを返すので、呼び出し側は保管庫の暗号化以外に使わない。 */
    fun masterForBiometric(): String = checkUnlocked().let { checkNotNull(master) }

    /** 書き出し用の .kdbx（暗号化済み）。 */
    fun exportKdbx(): ByteArray = checkUnlocked().encode()

    /**
     * 設計書 §4: GET して版を比べ、必要ならマージして PUT する。409 のときは取り直して最大 [maxRetry] 回やり直す。
     * 通信の失敗は例外で返り、手元の変更（dirty）は残る。
     */
    fun sync(client: SyncClient, maxRetry: Int = 4): SyncOutcome {
        checkUnlocked()
        var merged = false
        repeat(maxRetry) {
            val meta = store.meta()!!
            when (val r = client.get()) {
                GetResult.Empty -> {
                    if (put(client, 0)) return SyncOutcome.Pushed
                }
                is GetResult.Found -> {
                    if (r.version == meta.baseVersion) {
                        if (!meta.dirty) return if (merged) SyncOutcome.Merged else SyncOutcome.UpToDate
                        if (put(client, r.version)) return if (merged) SyncOutcome.Merged else SyncOutcome.Pushed
                    } else {
                        merged = true
                        adopt(r, meta)
                        if (!store.meta()!!.dirty) return SyncOutcome.Merged
                        if (put(client, r.version)) return SyncOutcome.Merged
                    }
                }
            }
        }
        throw SyncException("同期の競合が解消しませんでした。時間をおいてやり直してください")
    }

    /** サーバーの版を取り込む。手元に未送信の変更があれば、退避してからマージする。 */
    private fun adopt(r: GetResult.Found, meta: LocalStore.Meta) {
        val remote = try { KdbxVault.open(r.bytes, checkNotNull(master)) } catch (e: Exception) { throw WrongPasswordException() }
        if (!meta.dirty) {
            store.write(r.bytes, r.version, false)
            open(remote, checkNotNull(master))
            return
        }
        store.backup(store.readVault(), "%013d-base%d".format(now(), meta.baseVersion))
        val mergedData = VaultMerge.merge(data, remote.data())
        val next = remote.withData(mergedData)
        store.write(next.encode(), r.version, true)
        open(next, checkNotNull(master))
    }

    private fun put(client: SyncClient, ifMatch: Int): Boolean {
        val bytes = store.readVault()
        return when (val res = client.put(ifMatch, bytes)) {
            is PutResult.Saved -> { store.write(bytes, res.version, false); true }
            is PutResult.Conflict -> false
        }
    }

    private fun commit(next: VaultData) {
        val v = checkUnlocked().withData(next)
        val base = store.meta()?.baseVersion ?: 0
        store.write(v.encode(), base, true)
        vault = v
        data = next
    }

    private fun open(v: KdbxVault, pw: String) {
        vault = v
        master = pw
        data = v.data()
    }

    private fun checkUnlocked(): KdbxVault = vault ?: error("保管庫がロックされています")
}
