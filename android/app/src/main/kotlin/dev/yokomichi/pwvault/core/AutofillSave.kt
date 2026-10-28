package dev.yokomichi.pwvault.core

import java.security.SecureRandom

/**
 * 保存の依頼で受け取った値。toString に値を出さない。
 * [label] はアプリの表示名(分からなければ空)。ブラウザのときは [webDomain] が入る。
 */
class PendingLogin(
    val username: String,
    val password: String,
    val packageName: String,
    val webDomain: String?,
    val label: String,
) {
    override fun toString(): String = "PendingLogin"
}

/**
 * 設計書 §5-4 / 実装指示 3-5: 保存の依頼の値を置くプロセス内のメモリ(1件だけ。5分で消す)。
 * 画面には無作為な合言葉だけを渡し、値をインテント・ファイル・設定に書かない。
 */
class PendingSaveStore(
    private val now: () -> Long = System::currentTimeMillis,
    private val ttlMs: Long = TTL_MS,
    private val newToken: () -> String = ::randomToken,
) {
    private var token: String? = null
    private var login: PendingLogin? = null
    private var expiresAt = 0L

    /** 前の依頼を捨てて置く。返す合言葉だけを画面に渡す。 */
    @Synchronized
    fun put(value: PendingLogin): String {
        val t = newToken()
        token = t
        login = value
        expiresAt = now() + ttlMs
        return t
    }

    /** 画面に出すための参照。取り出さない(期限切れなら捨てて null)。 */
    @Synchronized
    fun peek(t: String?): PendingLogin? = valid(t)?.let { login }

    /** 取り出す。取り出したあとは消える(期限切れも null)。 */
    @Synchronized
    fun take(t: String?): PendingLogin? {
        if (valid(t) == null) return null
        val v = login
        clear()
        return v
    }

    /** 断ったとき・中止したときに捨てる。 */
    @Synchronized
    fun discard(t: String?) {
        if (t != null && t == token) clear()
    }

    /** 合言葉が合い、期限内のときだけ合言葉を返す。期限切れはその場で捨てる。 */
    private fun valid(t: String?): String? {
        if (t == null || token == null || t != token) return null
        if (now() >= expiresAt) {
            clear()
            return null
        }
        return t
    }

    private fun clear() {
        token = null
        login = null
        expiresAt = 0L
    }

    companion object {
        const val TTL_MS = 5 * 60_000L

        /** アプリ全体で1つ。 */
        val shared = PendingSaveStore()

        private val random = SecureRandom()

        fun randomToken(): String {
            val b = ByteArray(16)
            random.nextBytes(b)
            return b.joinToString("") { "%02x".format(it) }
        }
    }
}

/** 保存で書く項目。[isUpdate] が true のときは既存の項目のパスワードだけを変える。 */
class SavePlan(val entry: Entry, val isUpdate: Boolean) {
    override fun toString(): String = "SavePlan(update=$isUpdate)"
}

object AutofillSave {
    /**
     * 設計書 §5-4: 保存する項目を決める。種類はパスワード(itemType は空)。
     * 一致する項目(AutofillMatch。API キーと知らない種類は対象外)にユーザー名が同じものがあれば、その項目のパスワードを変える。
     * ユーザー名が空のときは更新にせず、新しく作る(空どうしを同じとみなして上書きしない)。
     */
    fun plan(entries: List<Entry>, p: PendingLogin, newUuid: String): SavePlan {
        if (p.username.isNotEmpty()) {
            AutofillMatch.matching(entries, p.packageName, p.webDomain)
                .sortedBy { it.uuid }
                .firstOrNull { it.username == p.username }
                ?.let { return SavePlan(it.copy(password = p.password), isUpdate = true) }
        }
        val browser = AutofillMatch.sourceOf(p.packageName, p.webDomain) is AutofillMatch.Source.Browser
        val entry = if (browser) {
            val host = p.webDomain!!.trim()
            Entry(newUuid, host, p.username, p.password, "https://$host", modifiedAt = 0)
        } else {
            Entry(newUuid, p.label.ifBlank { p.packageName }, p.username, p.password, "", androidPackage = p.packageName, modifiedAt = 0)
        }
        return SavePlan(entry, isUpdate = false)
    }
}
