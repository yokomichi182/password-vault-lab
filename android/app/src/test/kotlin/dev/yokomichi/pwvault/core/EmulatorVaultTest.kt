package dev.yokomichi.pwvault.core

import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.Test
import java.io.File

private const val CANARY = "CANARY-7f3e9a1c"

/**
 * エミュレーター確認(tests/autofill/実機の確認.md、実装指示 4-2)用の架空の保管庫を書き出す。
 * 環境変数 PWV_EMU_VAULT_DIR が無い通常の `gradlew test` では何もしない。出力は暗号化された .kdbx(追跡しない)。
 * マスターパスワードは MASTER(架空)。
 */
class EmulatorVaultTest {
    private val dir: File? = System.getenv("PWV_EMU_VAULT_DIR")?.let(::File)

    @Test
    fun writeEmulatorVault() {
        assumeTrue(dir != null)
        val t = 1_700_000_000_000
        val app = "dev.yokomichi.pwvault.testlogin"
        val data = VaultData(
            listOf(
                // テストアプリ用(パッケージ名を登録)
                Entry("00000000-0000-0000-0000-0000000000a1", "Test App Login", "app-user", "$CANARY-app", "", app, "", t),
                // テストページ用(URL は localhost。Chrome は http の非 localhost で自動入力を止めるため、10.0.2.2 は使えない)
                Entry("00000000-0000-0000-0000-0000000000a2", "Test Page Login", "page-user", "$CANARY-page", "http://localhost", "", "", t),
                // パッケージ名と URL がどちらとも一致する API キー(候補に出てはいけない)
                Entry("00000000-0000-0000-0000-0000000000a3", "Hidden Api Key", "key-user", "$CANARY-key", "http://localhost", app, "", t, ItemTypes.APIKEY, "本番"),
                // 知らない種類(候補に出てはいけない)
                Entry("00000000-0000-0000-0000-0000000000a4", "Hidden Note", "note-user", "$CANARY-note", "http://localhost", app, "", t, "note"),
            ),
        )
        File(dir, "emulator-vault.kdbx").writeBytes(KdbxVault.create(MASTER).withData(data).encode())
    }

    companion object {
        const val MASTER = "emulator-master-$CANARY-dummy"
    }
}
