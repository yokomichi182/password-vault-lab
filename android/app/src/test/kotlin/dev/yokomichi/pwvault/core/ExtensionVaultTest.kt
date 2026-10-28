package dev.yokomichi.pwvault.core

import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.Test
import java.io.File

private const val CANARY = "CANARY-7f3e9a1c"

/**
 * PC の拡張の確認(実装指示 フェーズ3 の 4-3、tests/extension/PCの確認.md)用の架空の保管庫を書き出す。
 * 環境変数 PWV_EXT_VAULT_DIR と PWV_EXT_PORT_A が無い通常の `gradlew test` では何もしない。出力は暗号化された .kdbx(追跡しない)。
 * 置き場は作業フォルダの外。マスターパスワードは MASTER(架空)。
 */
class ExtensionVaultTest {
    private val dir: File? = System.getenv("PWV_EXT_VAULT_DIR")?.let(::File)
    private val portA: String? = System.getenv("PWV_EXT_PORT_A")

    @Test
    fun writeExtensionVault() {
        assumeTrue(dir != null && portA != null)
        val t = 1_700_000_000_000
        val url = "http://app.localhost:$portA"
        val data = VaultData(
            listOf(
                // 拡張がクリックなしで入力する項目(パスワード)
                Entry("00000000-0000-0000-0000-0000000000b1", "Extension Test Login", "ext-user", "$CANARY-ext-login", url, "", "", t),
                // オリジンが一致しても入力してはいけない API キー
                Entry("00000000-0000-0000-0000-0000000000b2", "Extension Hidden Api Key", "ext-key-id", "$CANARY-ext-key", url, "", "", t, ItemTypes.APIKEY, "本番"),
                // オリジンが違う項目(別のサイトでは入力されない確認用)
                Entry("00000000-0000-0000-0000-0000000000b3", "Extension Other Site", "other-user", "$CANARY-ext-other", "https://other.example.test", "", "", t),
            ),
        )
        File(dir, "extension-vault.kdbx").writeBytes(KdbxVault.create(MASTER).withData(data).encode())
    }

    companion object {
        const val MASTER = "extension-master-$CANARY-dummy"
    }
}
