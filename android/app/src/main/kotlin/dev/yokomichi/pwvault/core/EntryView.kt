package dev.yokomichi.pwvault.core

/** 一覧の絞り込み。「その他」(知らない種類)は ALL にだけ出る。 */
enum class KindFilter { ALL, PASSWORD, API_KEY }

enum class ExpiryState { NONE, EXPIRED, SOON, OK }

object EntryView {
    const val SOON_DAYS = 30L

    /** 検索の対象はタイトル・ユーザー名・URL・環境。値(Password)は見ない。 */
    fun filter(entries: List<Entry>, query: String, kind: KindFilter): List<Entry> {
        val k = query.trim().lowercase()
        return entries.filter { e ->
            val kindOk = when (kind) {
                KindFilter.ALL -> true
                KindFilter.PASSWORD -> e.isLogin
                KindFilter.API_KEY -> e.itemType == ItemTypes.APIKEY
            }
            kindOk && (k.isEmpty() || listOf(e.title, e.username, e.url, e.environment).any { k in it.lowercase() })
        }
    }

    /** 設計書 §2-1: 期限切れと 30 日以内。通知は作らない。 */
    fun expiry(e: Entry, now: Long): ExpiryState {
        val at = e.expiresAt ?: return ExpiryState.NONE
        return when {
            at <= now -> ExpiryState.EXPIRED
            at - now <= SOON_DAYS * 86_400_000L -> ExpiryState.SOON
            else -> ExpiryState.OK
        }
    }
}
