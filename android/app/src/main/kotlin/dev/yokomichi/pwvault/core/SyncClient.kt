package dev.yokomichi.pwvault.core

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray

/** 設計書 §3-2: Worker の同期 API を呼ぶ。送るのは暗号化済みの保管庫ファイルだけ。 */
sealed interface PutResult {
    data class Saved(val version: Int) : PutResult
    data class Conflict(val latestVersion: Int) : PutResult
}

sealed interface GetResult {
    data object Empty : GetResult
    class Found(val version: Int, val bytes: ByteArray) : GetResult
}

/** 設計書 §3-2: 履歴の1行。device は書き込んだ端末名、createdAt はサーバーが付けた日時。 */
data class HistoryItem(val version: Int, val device: String, val createdAt: String, val size: Long)

/** メッセージにトークンや URL を入れない。 */
class SyncException(message: String) : Exception(message)

class SyncClient(
    private val baseUrl: String,
    private val token: String,
    private val vault: String,
    private val device: String,
    private val http: OkHttpClient = OkHttpClient(),
) {
    private fun url() = "${baseUrl.trimEnd('/')}/vaults/$vault"

    fun get(): GetResult {
        val req = Request.Builder().url(url()).header("Authorization", "Bearer $token").build()
        http.newCall(req).execute().use { res ->
            return when (res.code) {
                404 -> GetResult.Empty
                200 -> GetResult.Found(
                    res.header("x-vault-version")?.toIntOrNull() ?: throw SyncException("版の情報がありません"),
                    res.body!!.bytes(),
                )
                else -> throw SyncException("同期に失敗しました (${res.code})")
            }
        }
    }

    /** ifMatch には手元の版を渡す。空のサーバーへの最初の保存は 0。 */
    fun put(ifMatch: Int, bytes: ByteArray): PutResult {
        val req = Request.Builder().url(url())
            .header("Authorization", "Bearer $token")
            .header("If-Match", ifMatch.toString())
            .header("X-Device-Name", device)
            .put(bytes.toRequestBody("application/octet-stream".toMediaType()))
            .build()
        http.newCall(req).execute().use { res ->
            val version = Regex("\"version\"\\s*:\\s*(\\d+)")
                .find(res.body?.string().orEmpty())?.groupValues?.get(1)?.toInt()
            return when (res.code) {
                200, 201 -> PutResult.Saved(version ?: throw SyncException("版の情報がありません"))
                409 -> PutResult.Conflict(version ?: throw SyncException("版の情報がありません"))
                else -> throw SyncException("同期に失敗しました (${res.code})")
            }
        }
    }

    /** 履歴の一覧（新しい版が先）。 */
    fun history(): List<HistoryItem> {
        val req = Request.Builder().url("${url()}/history").header("Authorization", "Bearer $token").build()
        http.newCall(req).execute().use { res ->
            if (res.code != 200) throw SyncException("履歴を取得できませんでした (${res.code})")
            val arr = try { JSONArray(res.body!!.string()) } catch (e: Exception) { throw SyncException("履歴の形式が正しくありません") }
            return (0 until arr.length()).map {
                val o = arr.getJSONObject(it)
                HistoryItem(o.getInt("version"), o.optString("device"), o.optString("created_at"), o.optLong("size"))
            }
        }
    }

    /** 過去の版の保管庫ファイル(暗号文)を取得する。 */
    fun getVersion(version: Int): ByteArray {
        val req = Request.Builder().url("${url()}/history/$version").header("Authorization", "Bearer $token").build()
        http.newCall(req).execute().use { res ->
            if (res.code != 200) throw SyncException("過去の版を取得できませんでした (${res.code})")
            return res.body!!.bytes()
        }
    }
}
