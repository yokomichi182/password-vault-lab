package dev.yokomichi.pwvault.app

import android.content.Context

/** リリースビルド: 漏洩チェックの接続先は固定で、変えられない。 */
@Suppress("UNUSED_PARAMETER")
internal fun breachBaseUrl(ctx: Context): String = "https://api.pwnedpasswords.com"
