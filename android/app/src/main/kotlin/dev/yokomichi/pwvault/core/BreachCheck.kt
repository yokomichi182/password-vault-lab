package dev.yokomichi.pwvault.core

import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.security.MessageDigest

/** 設計書 §14: 1件の判定。Skipped は「調べられなかった」ことで、漏洩なしではない。 */
sealed interface BreachResult {
    data object Clean : BreachResult
    data class Breached(val count: Int) : BreachResult
    data object Skipped : BreachResult
}

/** 監査の1行。パスワードは持たない（項目名と結果だけ）。 */
data class AuditItem(val uuid: String, val title: String, val result: BreachResult)

/**
 * 設計書 §14-1: Pwned Passwords の k-匿名性。
 * 手元で SHA-1 を計算し、先頭5文字だけを送る。パスワードとハッシュの残りは送らない。
 * 連続の要求は minIntervalMs 以上空ける（§14-3）。ログには何も出さない。
 */
class BreachChecker(
    private val baseUrl: String = "https://api.pwnedpasswords.com",
    private val http: OkHttpClient = OkHttpClient(),
    private val minIntervalMs: Long = 200,
    private val sleep: (Long) -> Unit = { Thread.sleep(it) },
    private val now: () -> Long = System::currentTimeMillis,
) {
    private var lastRequestAt = 0L

    /** 1件を調べる。通信に失敗したら Skipped。 */
    fun check(password: String): BreachResult = checkHash(sha1Hex(password))

    /**
     * SHA-1（大文字16進40桁）から1件を調べる。バックグラウンドへはパスワードでなくハッシュだけを渡すための入口。
     * 通信に失敗したら Skipped。
     */
    fun checkHash(hash: String): BreachResult {
        require(hash.length == 40)
        val suffixes = try {
            fetchRange(hash.substring(0, 5))
        } catch (e: IOException) {
            return BreachResult.Skipped
        } ?: return BreachResult.Skipped
        return match(hash.substring(5), suffixes)
    }

    /**
     * 全項目を調べる。同じ先頭5文字は1回の要求で済ませる。
     * 通信できなかったら、残りも待たずに Skipped にする（オフラインで1件ずつ待たない）。
     * パスワードが空の項目は対象に含めない。
     */
    fun audit(entries: List<Entry>): List<AuditItem> {
        val cache = HashMap<String, Map<String, Int>?>()
        var offline = false
        return entries.filter { it.password.isNotEmpty() }.map { e ->
            val hash = sha1Hex(e.password)
            val prefix = hash.substring(0, 5)
            val result = when {
                cache.containsKey(prefix) -> cache[prefix]?.let { match(hash.substring(5), it) } ?: BreachResult.Skipped
                offline -> BreachResult.Skipped
                else -> {
                    val range = try {
                        fetchRange(prefix)
                    } catch (e: IOException) {
                        offline = true
                        null
                    }
                    if (range != null) cache[prefix] = range
                    range?.let { match(hash.substring(5), it) } ?: BreachResult.Skipped
                }
            }
            AuditItem(e.uuid, e.title, result)
        }
    }

    private fun match(suffix: String, counts: Map<String, Int>): BreachResult =
        counts[suffix]?.let { BreachResult.Breached(it) } ?: BreachResult.Clean

    /** 先頭5文字の範囲を取り、末尾 → 出現回数 にして返す。HTTP が 200 でなければ null（Skipped 扱い）。 */
    private fun fetchRange(prefix: String): Map<String, Int>? {
        require(prefix.length == 5)
        val wait = minIntervalMs - (now() - lastRequestAt)
        if (lastRequestAt != 0L && wait > 0) sleep(wait)
        lastRequestAt = now()
        // Add-Padding: 応答の大きさから先頭5文字の当たりを推測されにくくする。出現回数 0 の行は捨てる
        val req = Request.Builder().url("${baseUrl.trimEnd('/')}/range/$prefix").header("Add-Padding", "true").build()
        http.newCall(req).execute().use { res ->
            if (res.code != 200) return null
            val map = HashMap<String, Int>()
            res.body!!.string().lineSequence().forEach { line ->
                val parts = line.trim().split(':')
                val n = parts.getOrNull(1)?.toIntOrNull()
                if (parts.size == 2 && n != null && n > 0) map[parts[0].uppercase()] = n
            }
            return map
        }
    }

    companion object {
        fun sha1Hex(password: String): String =
            MessageDigest.getInstance("SHA-1").digest(password.toByteArray(Charsets.UTF_8))
                .joinToString("") { "%02X".format(it) }
    }
}
