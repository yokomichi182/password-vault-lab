package dev.yokomichi.pwvault.core

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * 設計書 §5-4: 自動入力の候補の選び方。Android の API を使わない(端末なしで試せるようにする)。
 * 値(パスワード)はここでは読まない。例外のメッセージにも項目の中身を入れない。
 */
object AutofillMatch {
    const val SELF_PACKAGE = "dev.yokomichi.pwvault"
    const val MAX_CANDIDATES = 10
    private const val APP_SCHEME = "androidapp://"

    /** webDomain を信用するブラウザ。ここにないアプリが webDomain を名乗っても使わない。 */
    val TRUSTED_BROWSERS: Set<String> = setOf(
        "com.android.chrome",
        "com.chrome.beta",
        "com.chrome.dev",
        "com.chrome.canary",
        "com.microsoft.emmx",
        "org.mozilla.firefox",
        "com.brave.browser",
        "com.sec.android.app.sbrowser",
    )

    /** 照合の方法。ブラウザの要求(信頼する一覧 + webDomain あり)だけが BROWSER。 */
    sealed interface Source {
        data class App(val packageName: String) : Source
        data class Browser(val webDomain: String) : Source
    }

    fun sourceOf(packageName: String, webDomain: String?): Source =
        if (packageName in TRUSTED_BROWSERS && !webDomain.isNullOrBlank()) Source.Browser(webDomain.trim())
        else Source.App(packageName)

    /**
     * 候補にする項目。種類がパスワード(isLogin)のものだけを先に絞り、そのあと要求元と照合する。
     * 要求元が Tobari 自身のときは空。タイトルの順で最大 [MAX_CANDIDATES] 件。
     */
    fun candidates(entries: List<Entry>, packageName: String, webDomain: String?): List<Entry> =
        matching(entries, packageName, webDomain)
            .sortedWith(compareBy<Entry> { it.title.lowercase() }.thenBy { it.title }.thenBy { it.uuid })
            .take(MAX_CANDIDATES)

    /** 件数の上限をかけない一致(保存のとき、更新する項目を探すのに使う)。 */
    fun matching(entries: List<Entry>, packageName: String, webDomain: String?): List<Entry> {
        if (packageName == SELF_PACKAGE) return emptyList()
        val logins = entries.filter { it.isLogin }
        return when (val s = sourceOf(packageName, webDomain)) {
            is Source.App -> logins.filter { matchesApp(it, s.packageName) }
            is Source.Browser -> logins.filter { matchesBrowser(it, s.webDomain) }
        }
    }

    // ---- アプリ ----

    /** `androidapp://` を外したパッケージ名。空の入力は空のまま。 */
    fun normalizePackage(raw: String): String = raw.trim().removePrefix(APP_SCHEME)

    private fun matchesApp(e: Entry, packageName: String): Boolean {
        if (packageName.isEmpty()) return false
        // ブラウザのパッケージ名そのものでは照合しない(Chrome を登録した項目を全サイトに出さない)
        if (packageName in TRUSTED_BROWSERS) return false
        val registered = buildList {
            if (e.androidPackage.isNotBlank()) add(normalizePackage(e.androidPackage))
            if (e.url.trim().startsWith(APP_SCHEME)) add(normalizePackage(e.url))
        }
        return registered.any { it.isNotEmpty() && it == packageName }
    }

    // ---- ブラウザ ----

    private fun matchesBrowser(e: Entry, webDomain: String): Boolean {
        val requestKey = siteKey(hostOfWebDomain(webDomain) ?: return false)
        val entryKey = siteKey(hostOfEntryUrl(e.url) ?: return false)
        return requestKey == entryKey
    }

    /** eTLD+1 を求められるホストは eTLD+1、求められない(IP アドレス・localhost・公開接尾辞)ホストは完全なホストを鍵にする。 */
    private fun siteKey(host: HttpUrl): String = host.topPrivateDomain() ?: host.host

    /** Android の webDomain はホストだけ。パス・ユーザー情報・ポートなどを含む値は信用しない。 */
    private fun hostOfWebDomain(webDomain: String): HttpUrl? {
        if (webDomain.any { it in "/@:?#\\ \t\r\n" }) return null
        return "https://$webDomain/".toHttpUrlOrNull()
    }

    /** 項目の URL のホスト。スキームがなければ https:// を補う。http/https 以外と解釈できないものは null。 */
    private fun hostOfEntryUrl(raw: String): HttpUrl? {
        val t = raw.trim()
        if (t.isEmpty()) return null
        val withScheme = if (t.contains("://")) t else "https://$t"
        return withScheme.toHttpUrlOrNull()
    }
}
