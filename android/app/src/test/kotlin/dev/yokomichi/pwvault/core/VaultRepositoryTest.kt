package dev.yokomichi.pwvault.core

import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

private const val CANARY = "CANARY-7f3e9a1c"
private const val MASTER = "master-$CANARY-dummy"

/** Worker の GET / PUT（If-Match と版）をまねた偽サーバー。 */
private class FakeWorker : Dispatcher() {
    var version = 0
    var blob: ByteArray? = null
    val history = mutableMapOf<Int, ByteArray>()
    override fun dispatch(request: RecordedRequest): MockResponse = when {
        request.method == "GET" && request.path!!.endsWith("/history") ->
            MockResponse().setBody(
                history.keys.sortedDescending().joinToString(",", "[", "]") {
                    """{"version":$it,"sha256":"x","device":"dev\"$it","created_at":"2026-10-28 00:00:0$it","size":${history[it]!!.size}}"""
                },
            )
        request.method == "GET" && "/history/" in request.path!! ->
            history[request.path!!.substringAfterLast('/').toInt()]
                ?.let { MockResponse().setBody(Buffer().write(it)) } ?: MockResponse().setResponseCode(404)
        else -> main(request)
    }

    private fun main(request: RecordedRequest): MockResponse = when (request.method) {
        "GET" -> if (blob == null) MockResponse().setResponseCode(404)
        else MockResponse().setHeader("x-vault-version", version.toString()).setBody(Buffer().write(blob!!))
        "PUT" -> if (request.getHeader("If-Match")?.toIntOrNull() == version) {
            version++
            blob = request.body.readByteArray()
            history[version] = blob!!
            MockResponse().setBody("""{"version":$version}""")
        } else MockResponse().setResponseCode(409).setBody("""{"version":$version}""")
        else -> MockResponse().setResponseCode(405)
    }
}

class VaultRepositoryTest {
    @TempDir lateinit var tmp: File
    private lateinit var server: MockWebServer
    private lateinit var worker: FakeWorker
    private var clock = 1_700_000_000_000L

    @BeforeEach fun up() {
        worker = FakeWorker()
        server = MockWebServer().apply { dispatcher = worker; start() }
    }
    @AfterEach fun down() = server.shutdown()

    private fun client(device: String) = SyncClient(server.url("/").toString(), "t", "main", device)
    private fun repo(name: String) = VaultRepository(LocalStore(File(tmp, name))) { clock.also { clock += 10_000 } }
    private fun item(n: Int) = Entry("00000000-0000-0000-0000-00000000000$n", "title$n", "u$n", "$CANARY-$n", "https://s$n.example", modifiedAt = 0)

    @Test
    fun 作成してロックし_マスターパスワードで開き直せる() {
        val r = repo("a")
        r.create(MASTER)
        r.upsert(item(1))
        r.lock()
        assertFalse(r.isUnlocked)
        assertThrows(IllegalStateException::class.java) { r.entries }
        assertThrows(WrongPasswordException::class.java) { r.unlock("wrong") }
        r.unlock(MASTER)
        assertEquals(listOf("title1"), r.entries.map { it.title })
    }

    @Test
    fun 編集は更新時刻が入り_削除は記録される() {
        val r = repo("a")
        r.create(MASTER)
        r.upsert(item(1))
        val t1 = r.entry(item(1).uuid)!!.modifiedAt
        r.upsert(item(1).copy(title = "changed"))
        assertTrue(r.entry(item(1).uuid)!!.modifiedAt > t1)
        r.delete(item(1).uuid)
        r.lock(); r.unlock(MASTER)
        assertTrue(r.entries.isEmpty())
    }

    @Test
    fun 空のサーバーへ最初の同期で保存され_次は変更なし() {
        val r = repo("a")
        r.create(MASTER); r.upsert(item(1))
        assertTrue(r.pendingSync)
        assertEquals(SyncOutcome.Pushed, r.sync(client("a")))
        assertFalse(r.pendingSync)
        assertEquals(1, worker.version)
        assertEquals(SyncOutcome.UpToDate, r.sync(client("a")))
        assertEquals(1, worker.version)
    }

    @Test
    fun サーバーにパスワードの平文は送られない() {
        val r = repo("a"); r.create(MASTER); r.upsert(item(1)); r.sync(client("a"))
        assertFalse(CANARY in String(worker.blob!!, Charsets.ISO_8859_1))
    }

    @Test
    fun 別の端末の変更を取り込む() {
        val a = repo("a"); a.create(MASTER); a.upsert(item(1)); a.sync(client("a"))
        val b = repo("b")
        b.importKdbx(worker.blob!!, MASTER)          // 端末Bは同じ保管庫を持つ（版は0扱い）
        b.sync(client("b"))
        assertEquals(listOf("title1"), b.entries.map { it.title })
        a.upsert(item(2)); a.sync(client("a"))
        assertEquals(SyncOutcome.Merged, b.sync(client("b")))
        assertEquals(setOf("title1", "title2"), b.entries.map { it.title }.toSet())
        assertFalse(b.pendingSync)
    }

    @Test
    fun 両端末が別々に編集してもマージで項目が消えない() {
        val a = repo("a"); a.create(MASTER); a.upsert(item(1)); a.sync(client("a"))
        val b = repo("b"); b.importKdbx(worker.blob!!, MASTER); b.sync(client("b"))
        a.upsert(item(2)); a.sync(client("a"))       // サーバーは先へ進む
        b.upsert(item(3))                            // Bは古い版のまま未送信の変更を持つ
        assertEquals(SyncOutcome.Merged, b.sync(client("b")))
        assertEquals(setOf("title1", "title2", "title3"), b.entries.map { it.title }.toSet())
        a.sync(client("a"))
        assertEquals(setOf("title1", "title2", "title3"), a.entries.map { it.title }.toSet())
    }

    @Test
    fun マージの前に手元の版が退避される() {
        val a = repo("a"); a.create(MASTER); a.upsert(item(1)); a.sync(client("a"))
        val b = repo("b"); b.importKdbx(worker.blob!!, MASTER); b.sync(client("b"))
        a.upsert(item(2)); a.sync(client("a"))
        val before = LocalStore(File(tmp, "b")).backupNames().size
        b.upsert(item(3)); b.sync(client("b"))
        assertEquals(before + 1, LocalStore(File(tmp, "b")).backupNames().size)
    }

    @Test
    fun 片方で消した項目は他方でも消える() {
        val a = repo("a"); a.create(MASTER); a.upsert(item(1)); a.upsert(item(2)); a.sync(client("a"))
        val b = repo("b"); b.importKdbx(worker.blob!!, MASTER); b.sync(client("b"))
        a.delete(item(1).uuid); a.sync(client("a"))
        b.sync(client("b"))
        assertEquals(listOf("title2"), b.entries.map { it.title })
    }

    @Test
    fun 通信できなくても手元の変更は残り_次回に送られる() {
        val r = repo("a"); r.create(MASTER); r.upsert(item(1))
        server.shutdown()
        assertThrows(Exception::class.java) { r.sync(client("a")) }
        assertTrue(r.pendingSync)
        assertEquals(listOf("title1"), r.entries.map { it.title })
        r.lock(); r.unlock(MASTER)
        assertEquals(listOf("title1"), r.entries.map { it.title })
    }

    @Test
    fun 別のマスターパスワードの保管庫は取り込まず_手元を壊さない() {
        val a = repo("a"); a.create(MASTER); a.upsert(item(1)); a.sync(client("a"))
        val c = repo("c"); c.create("other-$CANARY"); c.upsert(item(9))
        assertThrows(WrongPasswordException::class.java) { c.sync(client("c")) }
        assertEquals(listOf("title9"), c.entries.map { it.title })
    }

    @Test
    fun ロック中は一覧に触れず_ファイルに平文がない() {
        val r = repo("a"); r.create(MASTER); r.upsert(item(1)); r.lock()
        assertThrows(IllegalStateException::class.java) { r.upsert(item(2)) }
        val raw = String(File(tmp, "a/vault.kdbx").readBytes(), Charsets.ISO_8859_1)
        assertFalse(CANARY in raw)
    }

    @Test
    fun 履歴の一覧と過去の版を取得できる() {
        val r = repo("a"); r.create(MASTER); r.upsert(item(1)); r.sync(client("a"))
        r.upsert(item(2)); r.sync(client("a"))
        val h = client("a").history()
        assertEquals(listOf(2, 1), h.map { it.version })
        assertEquals("dev\"2", h[0].device)
        assertTrue(client("a").getVersion(1).isNotEmpty())
        assertThrows(SyncException::class.java) { client("a").getVersion(9) }
    }

    @Test
    fun 履歴から復元すると_以後の追加は消え_削除した項目は戻り_次の同期で他端末にも届く() {
        val a = repo("a"); a.create(MASTER); a.upsert(item(1)); a.upsert(item(2)); a.sync(client("a"))   // 版1
        a.delete(item(2).uuid); a.upsert(item(3)); a.upsert(item(1).copy(title = "changed")); a.sync(client("a")) // 版2
        val b = repo("b"); b.importKdbx(worker.blob!!, MASTER); b.sync(client("b"))
        assertEquals(setOf("changed", "title3"), b.entries.map { it.title }.toSet())

        val versionBefore = worker.version
        a.restoreFrom(client("a").getVersion(1), "1")
        assertEquals(setOf("title1", "title2"), a.entries.map { it.title }.toSet())
        assertTrue(a.pendingSync)
        a.sync(client("a"))
        assertEquals(setOf("title1", "title2"), a.entries.map { it.title }.toSet())
        assertEquals(versionBefore + 1, worker.version)

        b.sync(client("b"))
        assertEquals(setOf("title1", "title2"), b.entries.map { it.title }.toSet())
    }

    @Test
    fun 復元の前に手元の版が退避され_別のマスターパスワードの版は拒む() {
        val a = repo("a"); a.create(MASTER); a.upsert(item(1)); a.sync(client("a"))
        val before = LocalStore(File(tmp, "a")).backupNames().size
        a.restoreFrom(client("a").getVersion(1), "1")
        assertEquals(before + 1, LocalStore(File(tmp, "a")).backupNames().size)

        val other = repo("o"); other.create("other-$CANARY"); other.upsert(item(9))
        val foreign = other.exportKdbx()
        assertThrows(WrongPasswordException::class.java) { a.restoreFrom(foreign, "x") }
        assertEquals(listOf("title1"), a.entries.map { it.title })
    }
}
