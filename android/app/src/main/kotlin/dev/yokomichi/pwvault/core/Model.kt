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
) {
    // パスワードをログやエラーメッセージに出さない
    override fun toString(): String = "Entry(uuid=$uuid, title=$title)"
}

/** 保管庫の中身。deleted は KDBX の DeletedObjects に当たる（uuid → 削除時刻）。 */
data class VaultData(
    val entries: List<Entry> = emptyList(),
    val deleted: Map<String, Long> = emptyMap(),
)
