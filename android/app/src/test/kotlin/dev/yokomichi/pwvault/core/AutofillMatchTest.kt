package dev.yokomichi.pwvault.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

private const val CANARY = "CANARY-7f3e9a1c"
private const val CHROME = "com.android.chrome"

private fun login(
    n: Int,
    title: String = "title$n",
    url: String = "",
    pkg: String = "",
    type: String = "",
    user: String = "user$n",
) = Entry("uuid-$n", title, user, "$CANARY-pw$n", url, pkg, "memo$n", 0L, type)

private fun titles(l: List<Entry>) = l.map { it.title }

/** 実装指示 4-1: 照合。動くことと、動いてはいけない所で動かないこと。 */
class AutofillMatchTest {
    // ---- 動くこと ----

    // 1
    @Test
    fun アプリ_パッケージ名が一致する項目が候補になる() {
        val e = login(1, pkg = "com.example.app")
        assertEquals(listOf(e), AutofillMatch.candidates(listOf(e, login(2, pkg = "com.other.app")), "com.example.app", null))
    }

    @Test
    fun アプリ_androidapp_付きの書き方でも_URL側のandroidappでも一致する() {
        val a = login(1, pkg = "androidapp://com.example.app")
        val b = login(2, url = "androidapp://com.example.app")
        val c = login(3, pkg = "com.example.app")
        assertEquals(3, AutofillMatch.candidates(listOf(a, b, c), "com.example.app", null).size)
    }

    // 2
    @Test
    fun ブラウザ_サブドメインとwwwがeTLD1で一致する() {
        val e = login(1, url = "https://www.example.com/path")
        assertEquals(listOf(e), AutofillMatch.candidates(listOf(e), CHROME, "login.example.com"))
        val jp = login(2, url = "https://example.co.jp/")
        assertEquals(listOf(jp), AutofillMatch.candidates(listOf(jp), CHROME, "a.example.co.jp"))
    }

    // 3
    @Test
    fun ブラウザ_スキームのないURLの項目が一致する() {
        val e = login(1, url = "example.com")
        assertEquals(listOf(e), AutofillMatch.candidates(listOf(e), CHROME, "example.com"))
        val p = login(2, url = "example.com/login?x=1")
        assertEquals(listOf(p), AutofillMatch.candidates(listOf(p), CHROME, "www.example.com"))
    }

    // 4
    @Test
    fun IPアドレスとlocalhostはホストの完全一致で一致する() {
        val ip = login(1, url = "http://192.168.0.1:8080/")
        val lh = login(2, url = "http://localhost:3000")
        assertEquals(listOf(ip), AutofillMatch.candidates(listOf(ip, lh), CHROME, "192.168.0.1"))
        assertEquals(listOf(lh), AutofillMatch.candidates(listOf(ip, lh), CHROME, "localhost"))
    }

    // 6
    @Test
    fun 候補はタイトルの順で最大10件() {
        val entries = (1..12).map { login(it, title = "t%02d".format(13 - it), pkg = "com.example.app") }
        val r = AutofillMatch.candidates(entries, "com.example.app", null)
        assertEquals(10, r.size)
        assertEquals((1..10).map { "t%02d".format(it) }, titles(r))
    }

    @Test
    fun タイトルの順は大文字小文字を区別しない() {
        val entries = listOf(login(1, title = "b", pkg = "p.q"), login(2, title = "A", pkg = "p.q"), login(3, title = "c", pkg = "p.q"))
        assertEquals(listOf("A", "b", "c"), titles(AutofillMatch.candidates(entries, "p.q", null)))
    }

    // ---- 動いてはいけない所で動かないこと ----

    // 7
    @Test
    fun APIキーと知らない種類の項目は_パッケージ名やURLが一致しても候補にならない() {
        val entries = listOf(
            login(1, pkg = "com.example.app", type = ItemTypes.APIKEY),
            login(2, pkg = "com.example.app", type = "note"),
            login(3, url = "https://example.com", type = ItemTypes.APIKEY),
            login(4, url = "https://example.com", type = "note"),
            login(5, url = "androidapp://com.example.app", type = ItemTypes.APIKEY),
        )
        assertTrue(AutofillMatch.candidates(entries, "com.example.app", null).isEmpty())
        assertTrue(AutofillMatch.candidates(entries, CHROME, "example.com").isEmpty())
    }

    @Test
    fun 種類がpasswordと明示された項目は候補になる() {
        val e = login(1, pkg = "com.example.app", type = ItemTypes.PASSWORD)
        assertEquals(1, AutofillMatch.candidates(listOf(e), "com.example.app", null).size)
    }

    // 8
    @Test
    fun 似た名前のドメインに一致しない() {
        val e = login(1, url = "https://example.com")
        for (host in listOf("example.com.evil.test", "evilexample.com", "example.co", "xexample.com", "example.org")) {
            assertTrue(AutofillMatch.candidates(listOf(e), CHROME, host).isEmpty(), host)
        }
    }

    // 9
    @Test
    fun 公開接尾辞の上だけでは一致しない() {
        val a = login(1, url = "https://a.github.io")
        assertTrue(AutofillMatch.candidates(listOf(a), CHROME, "b.github.io").isEmpty())
        assertEquals(1, AutofillMatch.candidates(listOf(a), CHROME, "a.github.io").size)
        val co = login(2, url = "https://co.jp")
        assertTrue(AutofillMatch.candidates(listOf(co), CHROME, "example.co.jp").isEmpty())
        val x = login(3, url = "https://example.co.jp")
        assertTrue(AutofillMatch.candidates(listOf(x), CHROME, "other.co.jp").isEmpty())
        assertTrue(AutofillMatch.candidates(listOf(x), CHROME, "co.jp").isEmpty())
    }

    // 10
    @Test
    fun 別のIPアドレスに一致しない() {
        val e = login(1, url = "http://192.168.0.1/")
        assertTrue(AutofillMatch.candidates(listOf(e), CHROME, "192.168.0.2").isEmpty())
        assertTrue(AutofillMatch.candidates(listOf(e), CHROME, "192.168.0.10").isEmpty())
        assertTrue(AutofillMatch.candidates(listOf(e), CHROME, "localhost").isEmpty())
    }

    // 11
    @Test
    fun 信頼するブラウザでないアプリがwebDomainを名乗ってもURLで照合しない() {
        val e = login(1, url = "https://example.com")
        assertTrue(AutofillMatch.candidates(listOf(e), "com.evil.app", "example.com").isEmpty())
        // パッケージ名では照合する
        val p = login(2, pkg = "com.evil.app")
        assertEquals(listOf(p), AutofillMatch.candidates(listOf(e, p), "com.evil.app", "example.com"))
    }

    // 12
    @Test
    fun ブラウザのパッケージ名を登録した項目は_ブラウザの要求に一致しない() {
        for (b in AutofillMatch.TRUSTED_BROWSERS) {
            val e = login(1, pkg = b)
            assertTrue(AutofillMatch.candidates(listOf(e), b, "example.com").isEmpty(), b)
            // webDomain がないブラウザの要求(アドレスバーなど)でも、パッケージ名では一致させない
            assertTrue(AutofillMatch.candidates(listOf(e), b, null).isEmpty(), b)
            assertTrue(AutofillMatch.candidates(listOf(login(2, url = "androidapp://$b")), b, null).isEmpty(), b)
        }
    }

    // 13
    @Test
    fun 要求元がTobari自身なら何も返さない() {
        val e = login(1, pkg = AutofillMatch.SELF_PACKAGE, url = "https://example.com")
        assertTrue(AutofillMatch.candidates(listOf(e), AutofillMatch.SELF_PACKAGE, null).isEmpty())
        assertTrue(AutofillMatch.candidates(listOf(e), AutofillMatch.SELF_PACKAGE, "example.com").isEmpty())
    }

    @Test
    fun アプリの照合は完全一致だけ() {
        val e = login(1, pkg = "com.example.app")
        for (p in listOf("com.example.app2", "com.example", "COM.EXAMPLE.APP", "com.example.app.debug", "xcom.example.app", "")) {
            assertTrue(AutofillMatch.candidates(listOf(e), p, null).isEmpty(), p)
        }
        assertTrue(AutofillMatch.candidates(listOf(login(2, pkg = "")), "", null).isEmpty())
    }

    @Test
    fun 解釈できないURLと_パッケージ名のURLは_ブラウザの候補にならない() {
        val entries = listOf(
            login(1, url = "https://"),
            login(2, url = "not a url"),
            login(3, url = "androidapp://com.example.app"),
            login(4, url = "ftp://example.com"),
            login(5, url = ""),
        )
        assertTrue(AutofillMatch.candidates(entries, CHROME, "example.com").isEmpty())
    }

    @Test
    fun webDomainにパスやユーザー情報が混ざった値は信用しない() {
        val e = login(1, url = "https://example.com")
        for (w in listOf("evil.test/@example.com", "evil.test@example.com", "example.com:8080", "example.com/x", " ", "")) {
            assertTrue(AutofillMatch.candidates(listOf(e), CHROME, w).isEmpty(), w)
        }
    }

    @Test
    fun 大文字小文字を区別せずホストを比べる_ブラウザのみ() {
        val e = login(1, url = "https://EXAMPLE.com")
        assertEquals(1, AutofillMatch.candidates(listOf(e), CHROME, "Login.Example.COM").size)
    }

    // 17
    @Test
    fun カナリアを含む項目を通しても_例外とtoStringに目印が入らない() {
        val entries = listOf(
            login(1, pkg = "com.example.app", title = "t-$CANARY").copy(notes = CANARY, username = CANARY),
            login(2, url = "https://example.com").copy(notes = CANARY),
        )
        val out = StringBuilder()
        out.append(AutofillMatch.candidates(entries.map { it.copy(title = "x") }, "com.example.app", null))
        out.append(AutofillMatch.candidates(entries, CHROME, "example.com"))
        out.append(AutofillMatch.sourceOf(CHROME, "example.com"))
        for (bad in listOf("a/$CANARY", "$CANARY@x", CANARY, "")) {
            val r = runCatching { AutofillMatch.candidates(entries, CHROME, bad) }
            r.exceptionOrNull()?.let { out.append(it.toString()).append(it.message) }
            r.getOrNull()?.let { out.append(it) }
        }
        assertFalse(out.contains(CANARY), "toString と例外に目印が入った")
    }
}
