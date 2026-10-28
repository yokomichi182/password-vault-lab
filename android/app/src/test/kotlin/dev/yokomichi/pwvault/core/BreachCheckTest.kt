package dev.yokomichi.pwvault.core

import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

private const val CANARY = "CANARY-7f3e9a1c"
private const val LEAKED = "leaked-$CANARY-dummy"
private const val FINE = "fine-$CANARY-dummy"

/** 設計書 §14: 実 API には触れず、ローカルの偽サーバーで確かめる。 */
class BreachCheckTest {
    private lateinit var server: MockWebServer
    private val ranges = mutableMapOf<String, String>()
    private val seen = mutableListOf<RecordedRequest>()

    @BeforeEach
    fun start() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                seen += request
                val prefix = request.path!!.substringAfterLast('/')
                return ranges[prefix]?.let { MockResponse().setBody(it) } ?: MockResponse().setBody("")
            }
        }
        server.start()
    }

    @AfterEach
    fun stop() = runCatching { server.shutdown() }.let { }

    private fun checker(sleep: (Long) -> Unit = {}, now: () -> Long = System::currentTimeMillis) =
        BreachChecker(server.url("/").toString(), sleep = sleep, now = now)

    private fun entry(id: String, pw: String) = Entry(id, "項目$id", "u", pw, "", modifiedAt = 0)

    private fun serve(password: String, count: Int) {
        val h = BreachChecker.sha1Hex(password)
        // 別の末尾と、Add-Padding の出現回数 0 の行も混ぜる
        ranges[h.substring(0, 5)] = "0000000000000000000000000000000000A:3\r\n${h.substring(5)}:$count\r\n1111111111111111111111111111111111B:0"
    }

    @Test
    fun `SHA-1 は大文字の16進で、既知の値と一致する`() {
        assertEquals("5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8", BreachChecker.sha1Hex("password"))
    }

    @Test
    fun `送るのは先頭5文字だけで、パスワードもハッシュの残りも送らない`() {
        serve(LEAKED, 7)
        checker().check(LEAKED)
        val hash = BreachChecker.sha1Hex(LEAKED)
        assertEquals(1, seen.size)
        val r = seen[0]
        assertEquals("GET", r.method)
        assertEquals("/range/${hash.substring(0, 5)}", r.path)
        assertEquals(0L, r.bodySize)
        val everything = r.requestLine + r.headers.toString()
        assertFalse(everything.contains(LEAKED))
        assertFalse(everything.contains(CANARY))
        assertFalse(everything.contains(hash.substring(5)))
        assertFalse(everything.contains("Authorization", ignoreCase = true))
    }

    @Test
    fun `漏洩済みは出現回数つきで一致し、そうでないものは一致しない`() {
        serve(LEAKED, 42)
        ranges[BreachChecker.sha1Hex(FINE).substring(0, 5)] = "0000000000000000000000000000000000A:3"
        assertEquals(BreachResult.Breached(42), checker().check(LEAKED))
        assertEquals(BreachResult.Clean, checker().check(FINE))
    }

    @Test
    fun `Add-Padding の出現回数 0 の行は漏洩として数えない`() {
        val h = BreachChecker.sha1Hex(FINE)
        ranges[h.substring(0, 5)] = "${h.substring(5)}:0"
        assertEquals(BreachResult.Clean, checker().check(FINE))
    }

    @Test
    fun `連続の要求は200ms以上空ける`() {
        serve(LEAKED, 1)
        serve(FINE, 1)
        var clock = 10_000L
        val sleeps = mutableListOf<Long>()
        val c = checker(sleep = { sleeps += it; clock += it }, now = { clock })
        c.audit(listOf(entry("a", LEAKED), entry("b", FINE)))
        assertEquals(2, seen.size)
        assertEquals(1, sleeps.size)
        assertTrue(sleeps[0] >= 200)
    }

    @Test
    fun `同じ先頭5文字は1回の要求で済ませる`() {
        serve(LEAKED, 1)
        checker().audit(listOf(entry("a", LEAKED), entry("b", LEAKED)))
        assertEquals(1, seen.size)
    }

    @Test
    fun `オフラインのときは漏洩なしでなくスキップと返し、残りを待たない`() {
        val c = checker()
        server.shutdown()
        val items = c.audit(listOf(entry("a", LEAKED), entry("b", FINE), entry("c", "third-$CANARY")))
        assertEquals(3, items.size)
        assertTrue(items.all { it.result == BreachResult.Skipped })
        assertEquals(BreachResult.Skipped, c.check(LEAKED))
    }

    @Test
    fun `APIが200以外を返したときもスキップ`() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) = MockResponse().setResponseCode(503)
        }
        assertEquals(BreachResult.Skipped, checker().check(LEAKED))
    }

    @Test
    fun `空のパスワードは対象に含めない`() {
        assertTrue(checker().audit(listOf(entry("a", ""))).isEmpty())
        assertEquals(0, seen.size)
    }

    @Test
    fun `結果の文字列にパスワードもカナリアも出ない`() {
        serve(LEAKED, 5)
        val items = checker().audit(listOf(entry("a", LEAKED)))
        val text = items.joinToString { it.toString() }
        assertTrue(text.contains("項目a"))
        assertTrue(text.contains("5"))
        assertFalse(text.contains(CANARY))
        assertFalse(text.contains(LEAKED))
    }

    @Test
    fun `ハッシュを渡す入口でも同じ結果になり、送るのは先頭5文字だけ`() {
        serve(LEAKED, 9)
        val hash = BreachChecker.sha1Hex(LEAKED)
        assertEquals(BreachResult.Breached(9), checker().checkHash(hash))
        assertEquals(BreachResult.Clean, checker().checkHash(BreachChecker.sha1Hex(FINE)))
        val r = seen[0]
        assertEquals("/range/${hash.substring(0, 5)}", r.path)
        assertFalse((r.requestLine + r.headers.toString()).contains(hash.substring(5)))
    }

    @Test
    fun `ハッシュの入口は通信できないときスキップと返す`() {
        val c = checker()
        server.shutdown()
        assertEquals(BreachResult.Skipped, c.checkHash(BreachChecker.sha1Hex(LEAKED)))
    }

    @Test
    fun `40桁でないハッシュは受け付けない`() {
        org.junit.jupiter.api.Assertions.assertThrows(IllegalArgumentException::class.java) { checker().checkHash("ABC") }
        assertEquals(0, seen.size)
    }
}
