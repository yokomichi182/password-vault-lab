package dev.yokomichi.pwvault.core

import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

private const val CANARY = "CANARY-7f3e9a1c"

/** テスト用の端末内の記録。 */
internal class FakeRecorder : AuditRecorder {
    override var lastRunAt = 0L
    val results = mutableMapOf<String, BreachResult>()
    val touched = mutableListOf<String>()
    val forgotten = mutableListOf<String>()
    override fun record(uuid: String, result: BreachResult, at: Long) {
        if (result != BreachResult.Skipped) results[uuid] = result
    }
    override fun touch(uuid: String, at: Long) { touched += uuid }
    override fun forget(uuid: String) { forgotten += uuid; results.remove(uuid) }
}

/** ローカルのモックサーバー。実 API へは接続しない。 */
internal class MockHibp {
    val server = MockWebServer()
    val seen = mutableListOf<RecordedRequest>()
    val ranges = mutableMapOf<String, String>()

    fun start() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                synchronized(seen) { seen += request }
                return MockResponse().setBody(ranges[request.path!!.substringAfterLast('/')] ?: "")
            }
        }
        server.start()
    }

    fun serve(password: String, count: Int) {
        val h = BreachChecker.sha1Hex(password)
        ranges[h.substring(0, 5)] = "${h.substring(5)}:$count"
    }

    fun checker() = BreachChecker(server.url("/").toString(), minIntervalMs = 0, sleep = {})
}

private fun login(id: String, pw: String) = Entry(id, "login-$id", "u", pw, "", modifiedAt = 0)
private fun apikey(id: String, pw: String) = Entry(id, "key-$id", "kid", pw, "", modifiedAt = 0, itemType = ItemTypes.APIKEY, environment = "本番")
private fun other(id: String, pw: String) = Entry(id, "other-$id", "u", pw, "", modifiedAt = 0, itemType = "note")

/** 設計書 §14-3: 保存後・手動の経路で、種類がパスワードの項目だけを送る。 */
class AuditRouteTest {
    private val hibp = MockHibp()
    private val rec = FakeRecorder()
    private lateinit var audits: AuditCoordinator

    @BeforeEach fun up() {
        hibp.start()
        audits = AuditCoordinator({ hibp.checker() }, rec, now = { 1_000L })
    }
    @AfterEach fun down() = runCatching { hibp.server.shutdown() }.let { }

    // テスト13
    @Test
    fun apikey_を保存しても_ハッシュを計算せず_サーバーに要求が届かない() {
        val k = apikey("k1", "$CANARY-key")
        assertNull(audits.onSaved(null, k), "新規の API キー")
        assertNull(audits.onSaved(k, k.copy(password = "$CANARY-key-2")), "API キーの値を変えたとき")
        assertNull(audits.onSaved(k, k.copy(title = "x")), "API キーの別の欄を変えたとき")
        assertNull(audits.onSaved(null, other("o1", "$CANARY-other")), "知らない種類")
        assertEquals(0, hibp.seen.size)
        assertEquals(listOf("k1", "k1", "k1", "o1"), rec.forgotten)
    }

    // テスト14
    @Test
    fun 手動のチェックは_apikey_と知らない種類を送らず_対象外として数える() {
        hibp.serve("$CANARY-leaked", 12)
        val entries = listOf(
            login("a", "$CANARY-leaked"),
            login("b", "$CANARY-fine"),
            apikey("k1", "$CANARY-key1"),
            apikey("k2", "$CANARY-key2"),
            other("o1", "$CANARY-other"),
        )
        val report = audits.auditAll(entries)
        assertEquals(3, report.excludedCount)
        assertEquals(0, report.skippedCount, "対象外はオフラインのスキップとは別の数")
        assertEquals(1, report.cleanCount)
        assertEquals(listOf("a"), report.breached.map { it.uuid })
        // 送ったのは、パスワードの2件のハッシュの先頭5文字だけ
        val sent = hibp.seen.map { it.path!!.substringAfterLast('/') }.toSet()
        val login = setOf("$CANARY-leaked", "$CANARY-fine").map { BreachChecker.sha1Hex(it).substring(0, 5) }.toSet()
        assertTrue(sent.isNotEmpty() && sent.all { it in login })
        assertFalse(rec.results.containsKey("k1") || rec.results.containsKey("o1"))
        // 結果のどこにも値が出ない
        assertFalse(CANARY in report.toString())
    }

    @Test
    fun 手動のチェックはオフラインのスキップと対象外を別々に数える() {
        val entries = listOf(login("a", "$CANARY-x"), apikey("k1", "$CANARY-key"))
        hibp.server.shutdown()
        val report = audits.auditAll(entries)
        assertEquals(1, report.skippedCount)
        assertEquals(1, report.excludedCount)
        assertEquals(0, report.cleanCount)
    }

    @Test
    fun チェッカー自身も_isLogin_でない項目は送らない() {
        BreachChecker(hibp.server.url("/").toString()).audit(listOf(apikey("k1", "$CANARY-key"), other("o1", "$CANARY-o")))
        assertEquals(0, hibp.seen.size)
    }

    // テスト15
    @Test
    fun 種類を_apikey_からパスワードに変えて保存すると_1回だけチェックが走る() {
        hibp.serve("$CANARY-key", 3)
        val k = apikey("k1", "$CANARY-key")
        val asLogin = k.copy(itemType = "", environment = "", modifiedAt = 5)
        val hash = audits.onSaved(k, asLogin)
        assertEquals(BreachChecker.sha1Hex("$CANARY-key"), hash)
        assertEquals(BreachResult.Breached(3), audits.checkOne("k1", hash!!))
        assertEquals(1, hibp.seen.size)
        assertEquals("/range/${hash.substring(0, 5)}", hibp.seen[0].path)
        assertEquals(BreachResult.Breached(3), rec.results["k1"])
        // もう一度、パスワードのまま別の欄を保存しても走らない
        assertNull(audits.onSaved(asLogin, asLogin.copy(title = "renamed")))
        assertEquals(1, hibp.seen.size)
        assertEquals(listOf("k1"), rec.touched)
    }

    @Test
    fun パスワードが新しくなった保存と_新規のパスワードは保存後に調べる() {
        val a = login("a", "$CANARY-old")
        assertEquals(BreachChecker.sha1Hex("$CANARY-new"), audits.onSaved(a, a.copy(password = "$CANARY-new")))
        assertEquals(BreachChecker.sha1Hex("$CANARY-old"), audits.onSaved(null, a))
        assertNull(audits.onSaved(null, login("e", "")), "空のパスワードは調べない")
        // パスワードから API キーに変えたときは、送らず、前回の結果を捨てる
        assertNull(audits.onSaved(a, a.copy(itemType = ItemTypes.APIKEY)))
        assertEquals(listOf("a"), rec.forgotten)
    }
}
