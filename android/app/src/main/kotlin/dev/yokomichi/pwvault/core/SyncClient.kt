package dev.yokomichi.pwvault.core

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/** 設計書 §3-2: Worker の同期 API を呼ぶ。送るのは暗号化済みの保管庫ファイルだけ。 */
sealed interface PutResult {
    data class Saved(val version: Int) : PutResult
    data class Conflict(val latestVersion: Int) : PutResult
}

sealed interface GetResult {
    data object Empty : GetResult
    class Found(val version: Int, val bytes: ByteArray) : GetResult
}

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
}
