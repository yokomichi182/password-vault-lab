package dev.yokomichi.pwvault.core

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

private const val CANARY = "CANARY-7f3e9a1c"

private fun entry(id: String, at: Long, pw: String = "$CANARY-$id", url: String = "https://$id.example") =
    Entry(id, "title-$id", "user-$id", pw, url, modifiedAt = at)

class VaultMergeTest {
    @Test
    fun 片方にしかない項目はどちらも残る() {
        val m = VaultMerge.merge(VaultData(listOf(entry("a", 1))), VaultData(listOf(entry("b", 1))))
        assertEquals(setOf("a", "b"), m.entries.map { it.uuid }.toSet())
    }

    @Test
    fun 同じ項目は更新が新しいほうが残る() {
        val m = VaultMerge.merge(
            VaultData(listOf(entry("a", 1, pw = "old"))),
            VaultData(listOf(entry("a", 2, pw = "new"))),
        )
        assertEquals(listOf("new"), m.entries.map { it.password })
        val m2 = VaultMerge.merge(
            VaultData(listOf(entry("a", 2, pw = "new"))),
            VaultData(listOf(entry("a", 1, pw = "old"))),
        )
        assertEquals(listOf("new"), m2.entries.map { it.password })
    }

    @Test
    fun 削除より後に更新された項目は消えない() {
        val m = VaultMerge.merge(
            VaultData(deleted = mapOf("a" to 5L)),
            VaultData(listOf(entry("a", 6))),
        )
        assertEquals(listOf("a"), m.entries.map { it.uuid })
        assertFalse("a" in m.deleted)
    }

    @Test
    fun 更新より後の削除は項目を消す() {
        val m = VaultMerge.merge(
            VaultData(deleted = mapOf("a" to 7L)),
            VaultData(listOf(entry("a", 6), entry("b", 6))),
        )
        assertEquals(listOf("b"), m.entries.map { it.uuid })
        assertEquals(7L, m.deleted["a"])
    }

    @Test
    fun マージは順序によらず同じ結果になる() {
        val l = VaultData(listOf(entry("a", 3), entry("c", 1)), mapOf("b" to 4L))
        val r = VaultData(listOf(entry("a", 2), entry("b", 3)), mapOf("c" to 2L))
        val x = VaultMerge.merge(l, r)
        val y = VaultMerge.merge(r, l)
        assertEquals(x.entries.sortedBy { it.uuid }, y.entries.sortedBy { it.uuid })
        assertEquals(x.deleted, y.deleted)
    }

    @Test
    fun 項目の文字列表現にパスワードを出さない() {
        assertFalse(entry("a", 1).toString().contains(CANARY))
    }
}

class PasswordGeneratorTest {
    private val gen = PasswordGenerator()

    @Test
    fun 指定した長さと文字種で生成する() {
        val sets = setOf(PasswordGenerator.CharSet.LOWER, PasswordGenerator.CharSet.UPPER, PasswordGenerator.CharSet.DIGITS)
        repeat(200) {
            val p = gen.generate(20, sets)
            assertEquals(20, p.length)
            assertTrue(p.any { it.isLowerCase() } && p.any { it.isUpperCase() } && p.any { it.isDigit() })
            assertTrue(p.all { it.isLetterOrDigit() })
        }
    }

    @Test
    fun 文字種が空や短すぎる長さは拒否する() {
        assertThrows(IllegalArgumentException::class.java) { gen.generate(10, emptySet()) }
        assertThrows(IllegalArgumentException::class.java) { gen.generate(1, PasswordGenerator.CharSet.entries.toSet()) }
    }

    @Test
    fun 毎回違う値になる() {
        val sets = PasswordGenerator.CharSet.entries.toSet()
        assertEquals(100, (1..100).map { gen.generate(24, sets) }.toSet().size)
    }
}

class CsvImportTest {
    private val chrome = "name,url,username,password,note\r\n" +
        "Example,https://a.example,alice,$CANARY-1,\"memo, with \"\"quote\"\"\"\r\n" +
        "Other,https://b.example,bob,$CANARY-2,\r\n"

    private val bitwarden = "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n" +
        ",,login,BW,note1,,0,https://c.example,carol,$CANARY-3,\n"

    @Test
    fun Chrome形式を読む() {
        var n = 0
        val r = CsvImport.import(chrome, emptyList(), 10L) { "id${n++}" }
        assertEquals(2, r.entries.size)
        assertEquals("memo, with \"quote\"", r.entries[0].notes)
        assertEquals("alice", r.entries[0].username)
        assertEquals("$CANARY-2", r.entries[1].password)
    }

    @Test
    fun Bitwarden形式を読む() {
        val r = CsvImport.import(bitwarden, emptyList(), 10L)
        assertEquals(1, r.entries.size)
        assertEquals("https://c.example", r.entries[0].url)
        assertEquals("carol", r.entries[0].username)
    }

    @Test
    fun 既存と同じURLとユーザー名は重複として分ける() {
        val existing = listOf(entry("x", 1, url = "https://a.example").copy(username = "alice"))
        val r = CsvImport.import(chrome, existing, 10L)
        assertEquals(1, r.duplicates.size)
        assertEquals(1, r.entries.size)
        assertEquals("bob", r.entries[0].username)
    }

    @Test
    fun ファイル内の重複も分ける() {
        val text = "name,url,username,password,note\nA,https://a.example,u,p1,\nB,https://a.example,u,p2,\n"
        val r = CsvImport.import(text, emptyList(), 1L)
        assertEquals(1, r.entries.size)
        assertEquals(1, r.duplicates.size)
    }

    @Test
    fun 知らない形式は拒否する() {
        assertThrows(IllegalArgumentException::class.java) { CsvImport.import("a,b\n1,2\n", emptyList(), 1L) }
    }
}

class SyncClientTest {
    private fun withServer(block: (MockWebServer, SyncClient) -> Unit) {
        MockWebServer().use { s ->
            s.start()
            block(s, SyncClient(s.url("/").toString(), "tok-123", "main", "pixel"))
        }
    }

    @Test
    fun 空の保管庫は404でEmptyになる() = withServer { s, c ->
        s.enqueue(MockResponse().setResponseCode(404))
        assertEquals(GetResult.Empty, c.get())
        val req = s.takeRequest()
        assertEquals("/vaults/main", req.path)
        assertEquals("Bearer tok-123", req.getHeader("Authorization"))
    }

    @Test
    fun 取得すると版と本文を返す() = withServer { s, c ->
        s.enqueue(MockResponse().setBody("abc").setHeader("x-vault-version", "7"))
        val r = c.get() as GetResult.Found
        assertEquals(7, r.version)
        assertEquals("abc", String(r.bytes))
    }

    @Test
    fun 保存はIfMatchと端末名を付ける() = withServer { s, c ->
        s.enqueue(MockResponse().setBody("{\"version\":1}"))
        assertEquals(PutResult.Saved(1), c.put(0, "x".toByteArray()))
        val req = s.takeRequest()
        assertEquals("PUT", req.method)
        assertEquals("0", req.getHeader("If-Match"))
        assertEquals("pixel", req.getHeader("X-Device-Name"))
        assertEquals("x", req.body.readUtf8())
    }

    @Test
    fun 衝突の409は最新の版つきでConflictになる() = withServer { s, c ->
        s.enqueue(MockResponse().setResponseCode(409).setBody("{\"version\":5}"))
        assertEquals(PutResult.Conflict(5), c.put(3, ByteArray(1)))
    }

    @Test
    fun 認証エラーの例外にトークンを含めない() = withServer { s, c ->
        s.enqueue(MockResponse().setResponseCode(401))
        val e = assertThrows(SyncException::class.java) { c.get() }
        assertFalse(e.message!!.contains("tok-123"))
    }
}
