package dev.yokomichi.pwvault.core

/** 保管庫の1項目。uuid は端末をまたいで同じ項目を指す。modifiedAt は UNIX ミリ秒。 */
data class Entry(
    val uuid: String,
    val title: String,
    val username: String,
    val password: String,
    val url: String,
    val androidPackage: String = "",
    val notes: String = "",
    val modifiedAt: Long,
    /** 項目の種類(設計書 §2-1)。空はパスワード。知らない値は文字列のまま保つ。 */
    val itemType: String = "",
    /** API キーの環境(自由入力)。値ではないので保護しない。 */
    val environment: String = "",
    /** 有効期限(UNIX ミリ秒)。null は期限なし。 */
    val expiresAt: Long? = null,
) {
    /**
     * 自動入力と漏洩チェックの対象か。種類が空か `password` のときだけ true。
     * 知らない種類は安全側の「ログイン用ではない」に倒す。すべての面でこの判定を通す。
     */
    val isLogin: Boolean get() = itemType.isEmpty() || itemType == ItemTypes.PASSWORD

    // パスワードをログやエラーメッセージに出さない
    override fun toString(): String = "Entry(uuid=$uuid, title=$title)"
}

/** 設計書 §2-1: ItemType 属性の値。Android(kotpass)と PC(kdbxweb)で同じ文字列を使う。 */
object ItemTypes {
    const val PASSWORD = "password"
    const val APIKEY = "apikey"

    /** 環境の候補。Environment 属性にはこの文字列を保存する(表示言語に依存させない。設計書 §2-1)。 */
    const val ENV_PRODUCTION = "本番"
    const val ENV_TEST = "テスト"
    val ENVIRONMENT_CHOICES: List<String> = listOf(ENV_PRODUCTION, ENV_TEST)
}

/** 保管庫の中身。deleted は KDBX の DeletedObjects に当たる（uuid → 削除時刻）。 */
data class VaultData(
    val entries: List<Entry> = emptyList(),
    val deleted: Map<String, Long> = emptyMap(),
)
