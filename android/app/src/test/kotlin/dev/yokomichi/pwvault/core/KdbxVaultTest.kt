package dev.yokomichi.pwvault.core

import app.keemobile.kotpass.database.KeePassDatabase
import app.keemobile.kotpass.database.header.KdfParameters
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.util.UUID

private const val CANARY = "CANARY-7f3e9a1c"
private const val MASTER = "master-$CANARY-dummy"

private fun uid(n: Int) = UUID(0L, n.toLong()).toString()

private fun e(n: Int, at: Long = 1_700_000_000_000, pw: String = "$CANARY-pw$n", pkg: String = "") =
    Entry(uid(n), "title$n", "user$n", pw, "https://site$n.example", pkg, "memo$n", at)

class KdbxVaultTest {
    @Test
    fun 書き出して開き直すと同じ内容になる() {
        val data = VaultData(
            listOf(e(1), e(2, pkg = "com.example.app")),
            mapOf(uid(9) to 1_700_000_100_000),
        )
        val bytes = KdbxVault.create(MASTER).withData(data).encode()
        val back = KdbxVault.open(bytes, MASTER).data()
        assertEquals(data.entries.toSet(), back.entries.toSet())
        assertEquals(data.deleted, back.deleted)
    }

    @Test
    fun ファイルは_KDBX4_で_Argon2id_の指定値になっている() {
        val bytes = KdbxVault.create(MASTER).encode()
        // 署名 03D9A29A 67FB4BB5（リトルエンディアンで先頭 8 バイト）、続いて副版 2 バイトと主版 2 バイト
        assertEquals(listOf(0x03, 0xD9, 0xA2, 0x9A, 0x67, 0xFB, 0x4B, 0xB5), bytes.take(8).map { it.toInt() and 0xFF })
        assertEquals(4, bytes[10].toInt())
        val db = openDb(bytes)
        val kdf = db.header.kdfParameters as KdfParameters.Argon2
        assertEquals(KdfParameters.Argon2.Variant.Argon2id, kdf.variant)
        assertEquals(64UL * 1024UL * 1024UL, kdf.memory)
        assertEquals(3UL, kdf.iterations)
        assertEquals(2U, kdf.parallelism)
    }

    @Test
    fun ファイルにパスワードの平文が含まれない() {
        val bytes = KdbxVault.create(MASTER).withData(VaultData(listOf(e(1)))).encode()
        val text = String(bytes, Charsets.ISO_8859_1)
        assertFalse(CANARY in text)
        assertFalse("title1" in text)
    }

    @Test
    fun マスターパスワードが違えば開けず_エラーに値が出ない() {
        val bytes = KdbxVault.create(MASTER).withData(VaultData(listOf(e(1)))).encode()
        val ex = assertThrows(Exception::class.java) { KdbxVault.open(bytes, "wrong-$CANARY") }
        assertFalse(CANARY in ex.toString())
        assertFalse(CANARY in (ex.message ?: ""))
    }

    @Test
    fun 開き直して編集しても他の項目と削除記録が残る() {
        val v1 = KdbxVault.create(MASTER).withData(VaultData(listOf(e(1), e(2)), mapOf(uid(7) to 5_000L)))
        val v2 = KdbxVault.open(v1.encode(), MASTER)
        val cur = v2.data()
        val edited = cur.copy(entries = cur.entries.map { if (it.uuid == uid(1)) it.copy(password = "changed", modifiedAt = 1_800_000_000_000) else it })
        val v3 = KdbxVault.open(v2.withData(edited).encode(), MASTER).data()
        assertEquals("changed", v3.entries.single { it.uuid == uid(1) }.password)
        assertEquals("$CANARY-pw2", v3.entries.single { it.uuid == uid(2) }.password)
        assertEquals(5_000L, v3.deleted[uid(7)])
    }

    @Test
    fun 一覧から外した項目はファイルからも消える() {
        val v = KdbxVault.create(MASTER).withData(VaultData(listOf(e(1), e(2))))
        val after = v.withData(VaultData(listOf(e(1)), mapOf(uid(2) to 9_000L)))
        val data = KdbxVault.open(after.encode(), MASTER).data()
        assertEquals(listOf(uid(1)), data.entries.map { it.uuid })
        assertEquals(9_000L, data.deleted[uid(2)])
    }

    @Test
    fun 時刻は秒単位に丸められる() {
        val data = VaultData(listOf(e(1, at = 1_700_000_000_999)))
        val back = KdbxVault.open(KdbxVault.create(MASTER).withData(data).encode(), MASTER).data()
        assertEquals(1_700_000_000_000, back.entries.single().modifiedAt)
    }

    @Test
    fun 日本語と記号を含む項目も壊れない() {
        val x = Entry(uid(1), "銀行 \"A\" <b>", "ユーザー", "pä ss\n$CANARY", "https://例.jp/?a=1&b=2", "", "メモ\n二行目", 1_700_000_000_000)
        val back = KdbxVault.open(KdbxVault.create(MASTER).withData(VaultData(listOf(x))).encode(), MASTER).data()
        assertEquals(x, back.entries.single())
    }

    @Test
    fun 取り込みから作った保管庫も同じ経路で書ける() {
        val csv = "name,url,username,password\nsite,https://a.example,u,$CANARY-x\n"
        val r = CsvImport.import(csv, emptyList(), now = 1_700_000_000_000)
        assertTrue(r.entries.isNotEmpty())
        val data = VaultData(r.entries)
        val back = KdbxVault.open(KdbxVault.create(MASTER).withData(data).encode(), MASTER).data()
        assertEquals("$CANARY-x", back.entries.single().password)
    }

    @Test
    fun 項目の表示にパスワードが出ない() {
        assertFalse(CANARY in e(1).toString())
        assertNotEquals(e(1), e(1, pw = "other"))
    }

    private fun openDb(bytes: ByteArray): KeePassDatabase.Ver4x {
        val m = KdbxVault::class.java.getDeclaredField("db").apply { isAccessible = true }
        return m.get(KdbxVault.open(bytes, MASTER)) as KeePassDatabase.Ver4x
    }
}
