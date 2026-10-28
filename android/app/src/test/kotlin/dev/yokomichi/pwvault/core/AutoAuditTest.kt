package dev.yokomichi.pwvault.core

import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

private const val CANARY = "CANARY-7f3e9a1c"
private const val DAY = 86_400_000L
private const val NOW = 2_000_000_000_000L

private class FakeNotifier(var allowed: Boolean) : BreachNotifier {
    val shown = mutableListOf<List<Pair<String, Int>>>()
    override fun canNotify() = allowed
    override fun notifyBreached(items: List<Pair<String, Int>>) { shown += items }
}

private fun login(id: String, pw: String) = Entry(id, "login-$id", "u", pw, "", modifiedAt = 0)
private fun apikey(id: String, pw: String) = Entry(id, "key-$id", "kid", pw, "", modifiedAt = 0, itemType = ItemTypes.APIKEY)

/** 設計書 §14-2・§14-3: ロック解除時の自動チェック。通信はローカルのモックサーバー。 */
class AutoAuditTest {
    private val hibp = MockHibp()
    private val rec = FakeRecorder()
    private val notifier = FakeNotifier(allowed = true)
    private lateinit var audits: AuditCoordinator
    private val entries = listOf(login("a", "$CANARY-leaked"), login("b", "$CANARY-fine"), apikey("k1", "$CANARY-key"))

    @BeforeEach fun up() {
        hibp.start()
        hibp.serve("$CANARY-leaked", 8)
        audits = AuditCoordinator({ hibp.checker() }, rec, notifier, now = { NOW })
    }
    @AfterEach fun down() = runCatching { hibp.server.shutdown() }.let { }

    @Test
    fun 前回から7日未満なら走らない() {
        rec.lastRunAt = NOW - 7 * DAY + 1
        assertNull(audits.runAuto(entries, enabled = true, onWifi = true))
        assertEquals(0, hibp.seen.size)
        assertTrue(notifier.shown.isEmpty())
    }

    @Test
    fun 前回から7日以上で_設定が有効で_Wi_Fi_のときだけ走る() {
        rec.lastRunAt = NOW - 7 * DAY
        val report = audits.runAuto(entries, enabled = true, onWifi = true)
        assertNotNull(report)
        assertTrue(hibp.seen.isNotEmpty())
        assertEquals(NOW, rec.lastRunAt, "前回のチェックの時刻が進む")
        assertEquals(listOf("a"), report!!.breached.map { it.uuid })
    }

    @Test
    fun 一度も調べていなければ走る() {
        assertNotNull(audits.runAuto(entries, enabled = true, onWifi = true))
    }

    @Test
    fun 設定が無効のとき_Wi_Fi_でないときは走らない() {
        rec.lastRunAt = NOW - 30 * DAY
        assertNull(audits.runAuto(entries, enabled = false, onWifi = true))
        assertNull(audits.runAuto(entries, enabled = true, onWifi = false))
        assertEquals(0, hibp.seen.size)
        assertEquals(NOW - 30 * DAY, rec.lastRunAt)
    }

    @Test
    fun apikey_のハッシュを送らず_対象外として数える() {
        val report = audits.runAuto(entries, enabled = true, onWifi = true)!!
        assertEquals(1, report.excludedCount)
        val loginPrefixes = listOf("$CANARY-leaked", "$CANARY-fine").map { BreachChecker.sha1Hex(it).substring(0, 5) }
        val sent = hibp.seen.map { it.path!!.substringAfterLast('/') }
        assertTrue(sent.isNotEmpty() && sent.all { it in loginPrefixes })
    }

    @Test
    fun 全件がスキップされたときは_前回のチェックの時刻を更新しない() {
        rec.lastRunAt = NOW - 10 * DAY
        hibp.server.shutdown()
        val report = audits.runAuto(entries, enabled = true, onWifi = true)!!
        assertEquals(2, report.skippedCount)
        assertEquals(NOW - 10 * DAY, rec.lastRunAt)
        assertTrue(notifier.shown.isEmpty(), "調べられなかったときは通知しない")
        // 手動でも同じ
        audits.auditAll(entries)
        assertEquals(NOW - 10 * DAY, rec.lastRunAt)
    }

    @Test
    fun 対象が無い保管庫でも通信せず_時刻を進めない() {
        val report = audits.runAuto(listOf(apikey("k1", "$CANARY-key")), enabled = true, onWifi = true)!!
        assertEquals(1, report.excludedCount)
        assertEquals(0, hibp.seen.size)
        assertEquals(0L, rec.lastRunAt)
    }

    @Test
    fun 漏洩を見つけたら通知を出し_出すのは項目名と出現回数だけ() {
        val report = audits.runAuto(entries, enabled = true, onWifi = true)!!
        assertEquals(1, notifier.shown.size)
        assertEquals(listOf("login-a" to 8), notifier.shown[0])
        assertFalse(CANARY in notifier.shown.toString())
        assertFalse(CANARY in report.toString())
    }

    @Test
    fun 通知の許可がないときは通知を出さず_結果はアプリの中に出せる() {
        notifier.allowed = false
        val report = audits.runAuto(entries, enabled = true, onWifi = true)!!
        assertTrue(notifier.shown.isEmpty())
        assertEquals(listOf("a"), report.breached.map { it.uuid })
        assertEquals(8, (report.breached.single().result as BreachResult.Breached).count)
        assertEquals(NOW, rec.lastRunAt)
    }

    @Test
    fun 漏洩が無いときは通知しない() {
        val report = audits.runAuto(listOf(login("b", "$CANARY-fine")), enabled = true, onWifi = true)!!
        assertTrue(report.breached.isEmpty())
        assertTrue(notifier.shown.isEmpty())
    }

    @Test
    fun 結果に残るのは_uuid_漏洩の有無_回数_時刻だけ() {
        audits.runAuto(entries, enabled = true, onWifi = true)
        assertEquals(setOf("a", "b"), rec.results.keys)
        assertEquals(BreachResult.Breached(8), rec.results["a"])
        assertEquals(BreachResult.Clean, rec.results["b"])
    }
}
