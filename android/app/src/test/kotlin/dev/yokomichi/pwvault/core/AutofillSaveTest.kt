package dev.yokomichi.pwvault.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

private const val CANARY = "CANARY-7f3e9a1c"
private const val CHROME = "com.android.chrome"

private fun pending(user: String = "alice", pw: String = "$CANARY-new", pkg: String = "com.example.app", web: String? = null, label: String = "Example") =
    PendingLogin(user, pw, pkg, web, label)

private fun existing(n: Int, user: String, url: String = "", pkg: String = "", type: String = "") =
    Entry("uuid-$n", "title$n", user, "$CANARY-old$n", url, pkg, "", 0L, type)

/** 実装指示 4-1 の 16: 保存。 */
class AutofillSaveTest {
    private class Clock(var t: Long = 1_000_000L) : () -> Long {
        override fun invoke() = t
    }

    @Test
    fun 値の置き場は5分で消える() {
        val c = Clock()
        val s = PendingSaveStore(now = c)
        val t = s.put(pending())
        c.t += PendingSaveStore.TTL_MS - 1
        assertNotNull(s.peek(t))
        c.t += 1
        assertNull(s.peek(t))
        assertNull(s.take(t))
    }

    @Test
    fun 取り出したあとも消える() {
        val s = PendingSaveStore()
        val t = s.put(pending())
        assertNotNull(s.peek(t))
        assertNotNull(s.peek(t))
        assertNotNull(s.take(t))
        assertNull(s.take(t))
        assertNull(s.peek(t))
    }

    @Test
    fun 合言葉が違えば取り出せない_置き直すと前の依頼は消える() {
        val s = PendingSaveStore()
        val t1 = s.put(pending(user = "one"))
        assertNull(s.peek("wrong"))
        assertNull(s.peek(null))
        assertNull(s.take("wrong"))
        // 間違った合言葉で取り出そうとしても消えない
        assertNotNull(s.peek(t1))
        val t2 = s.put(pending(user = "two"))
        assertNotEquals(t1, t2)
        assertNull(s.peek(t1))
        assertEquals("two", s.peek(t2)!!.username)
    }

    @Test
    fun 断ったときは捨てる() {
        val s = PendingSaveStore()
        val t = s.put(pending())
        s.discard("wrong")
        assertNotNull(s.peek(t))
        s.discard(t)
        assertNull(s.peek(t))
    }

    @Test
    fun 合言葉は毎回違う無作為な値() {
        val tokens = (1..50).map { PendingSaveStore.randomToken() }.toSet()
        assertEquals(50, tokens.size)
        assertTrue(tokens.all { it.length == 32 })
    }

    @Test
    fun 保存で作る項目の種類はパスワードで_アプリはパッケージ名_ブラウザはURLを持つ() {
        val app = AutofillSave.plan(emptyList(), pending(), "new-1")
        assertFalse(app.isUpdate)
        assertEquals("", app.entry.itemType)
        assertTrue(app.entry.isLogin)
        assertEquals("com.example.app", app.entry.androidPackage)
        assertEquals("", app.entry.url)
        assertEquals("Example", app.entry.title)
        assertEquals("alice", app.entry.username)

        val web = AutofillSave.plan(emptyList(), pending(pkg = CHROME, web = "login.example.com"), "new-2")
        assertFalse(web.isUpdate)
        assertEquals("", web.entry.itemType)
        assertEquals("https://login.example.com", web.entry.url)
        assertEquals("", web.entry.androidPackage)
        assertEquals("login.example.com", web.entry.title)
    }

    @Test
    fun 表示名が無いアプリはパッケージ名をタイトルにする() {
        assertEquals("com.example.app", AutofillSave.plan(emptyList(), pending(label = ""), "n").entry.title)
    }

    @Test
    fun ユーザー名が同じ項目があれば_その項目のパスワードだけを変える() {
        val old = existing(1, "alice", pkg = "com.example.app")
        val other = existing(2, "bob", pkg = "com.example.app")
        val p = AutofillSave.plan(listOf(old, other), pending(), "new")
        assertTrue(p.isUpdate)
        assertEquals(old.uuid, p.entry.uuid)
        assertEquals("$CANARY-new", p.entry.password)
        assertEquals(old.title, p.entry.title)
        assertEquals(old.androidPackage, p.entry.androidPackage)
        // 別のユーザー名なら新しく作る
        assertFalse(AutofillSave.plan(listOf(old, other), pending(user = "carol"), "new").isUpdate)
    }

    @Test
    fun ユーザー名が同じAPIキーや知らない種類の項目は_上書きしない() {
        val key = existing(1, "alice", pkg = "com.example.app", type = ItemTypes.APIKEY)
        val note = existing(2, "alice", url = "https://example.com", type = "note")
        val a = AutofillSave.plan(listOf(key, note), pending(), "new-a")
        assertFalse(a.isUpdate)
        assertEquals("new-a", a.entry.uuid)
        assertEquals("", a.entry.itemType)
        val b = AutofillSave.plan(listOf(key, note), pending(pkg = CHROME, web = "example.com"), "new-b")
        assertFalse(b.isUpdate)
        assertEquals("new-b", b.entry.uuid)
    }

    @Test
    fun 別のアプリやサイトの同じユーザー名の項目は更新しない() {
        val e = existing(1, "alice", pkg = "com.other.app", url = "https://other.example")
        assertFalse(AutofillSave.plan(listOf(e), pending(), "n").isUpdate)
        assertFalse(AutofillSave.plan(listOf(e), pending(pkg = CHROME, web = "example.com"), "n").isUpdate)
    }

    @Test
    fun ユーザー名が空のときは更新にせず新しく作る() {
        val e = existing(1, "", pkg = "com.example.app")
        assertFalse(AutofillSave.plan(listOf(e), pending(user = ""), "n").isUpdate)
    }

    @Test
    fun 保存の値の型のtoStringに値が入らない() {
        val s = PendingSaveStore()
        val t = s.put(pending())
        val out = pending().toString() + AutofillSave.plan(emptyList(), pending(), "n") + AutofillSave.plan(emptyList(), pending(), "n").toString()
        assertFalse(out.contains(CANARY))
        assertFalse(t.contains(CANARY))
    }
}
