package dev.yokomichi.pwvault.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.Test
import java.io.File

private const val CANARY = "CANARY-7f3e9a1c"
private const val MASTER = "master-$CANARY-dummy"

private fun uid(n: Int) = java.util.UUID(0L, n.toLong()).toString()

/**
 * kdbxweb との相互確認（tests/xcheck/run.sh から呼ぶ）。PWV_XCHECK_DIR が無い通常の `gradlew test` では何もしない。
 */
class KdbxXcheckTest {
    private val dir: File? = System.getenv("PWV_XCHECK_DIR")?.let(::File)

    @Test
    fun writeAndroidMade() {
        assumeTrue(dir != null)
        val data = VaultData(
            listOf(
                Entry(uid(1), "title1", "user1", "$CANARY-pw1", "https://site1.example", "", "memo1", 1_700_000_000_000),
                Entry(uid(2), "title2", "user2", "$CANARY-pw2", "https://site2.example", "com.example.app", "memo2", 1_700_000_000_000),
                Entry(uid(3), "銀行 \"A\" <b>", "ユーザー", "pä ss\n$CANARY", "https://例.jp/?a=1&b=2", "", "メモ\n二行目", 1_700_000_000_000),
            ),
            mapOf(uid(9) to 1_700_000_100_000),
        )
        File(dir, "android-made.kdbx").writeBytes(KdbxVault.create(MASTER).withData(data).encode())
    }

    @Test
    fun readNodeMade() {
        assumeTrue(dir != null)
        val f = File(dir, "node-made.kdbx")
        assertTrue(f.exists(), "node-made.kdbx が無い。先に check.mjs を実行する")
        val data = KdbxVault.open(f.readBytes(), MASTER).data()
        val byTitle = data.entries.associateBy { it.title }
        assertEquals(setOf("node-root", "node-sub"), byTitle.keys)
        assertEquals("$CANARY-n1", byTitle.getValue("node-root").password)
        assertEquals("$CANARY-n2", byTitle.getValue("node-sub").password)
        assertEquals("nuser17", byTitle.getValue("node-root").username)
        assertEquals("https://node18.example", byTitle.getValue("node-sub").url)
        assertEquals("nmemo18", byTitle.getValue("node-sub").notes)
        // 子グループ内の項目を編集して書き戻しても、グループ構造は壊れない
        val v = KdbxVault.open(f.readBytes(), MASTER)
        val edited = data.copy(entries = data.entries.map { if (it.title == "node-sub") it.copy(notes = "edited", modifiedAt = 1_800_000_000_000) else it })
        val again = KdbxVault.open(v.withData(edited).encode(), MASTER).data()
        assertEquals("edited", again.entries.single { it.title == "node-sub" }.notes)
        assertEquals(2, again.entries.size)
    }
}
