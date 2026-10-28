package dev.yokomichi.pwvault.app

import android.content.Context
import java.io.File
import java.net.URI

/**
 * デバッグビルドだけ: アプリのファイル領域の `breach_base_url` に書いた URL へ、漏洩チェックの接続先を向ける。
 * 画面の確認で実 API に触れないための仕組み。許すのは `http(s)://10.0.2.2` と `localhost` だけで、
 * ほかの値や読み取りの失敗では実 API の既定に戻す。
 * 例: `adb shell run-as dev.yokomichi.pwvault sh -c 'echo http://10.0.2.2:8788 > files/breach_base_url'`
 */
internal fun breachBaseUrl(ctx: Context): String {
    val default = "https://api.pwnedpasswords.com"
    return runCatching {
        val text = File(ctx.filesDir, "breach_base_url").takeIf { it.isFile }?.readText()?.trim() ?: return default
        val uri = URI(text)
        if (uri.scheme in setOf("http", "https") && uri.host in setOf("10.0.2.2", "localhost")) text else default
    }.getOrDefault(default)
}
