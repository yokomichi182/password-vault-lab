package dev.yokomichi.pwvault.core

/**
 * ViewNode から、判定に要る情報だけを写した型。値(入力された文字)は持たない。
 * [ID] は本番では AutofillId、テストでは整数。htmlAttrs には type と autocomplete だけを入れる。
 */
data class FieldInfo<ID>(
    val id: ID,
    val autofillHints: List<String> = emptyList(),
    val inputType: Int = 0,
    val htmlTag: String? = null,
    val htmlAttrs: Map<String, String> = emptyMap(),
    val idEntry: String? = null,
    val hint: String? = null,
    val isFocused: Boolean = false,
    val visible: Boolean = true,
    val importantForAutofill: Int = AutofillFields.IMPORTANT_AUTO,
    /** 文字を入れられる欄か(AUTOFILL_TYPE_TEXT)。 */
    val isText: Boolean = true,
)

/**
 * 画面の中のログイン欄。[password] は現在のパスワードの欄(入力の対象)、
 * [newPassword] は新しいパスワードの欄(入力しない。保存の対象にだけする)。
 */
data class LoginFields<ID>(val username: ID?, val password: ID?, val newPassword: ID?)

/** 設計書 §5-4 / 実装指示 3-3: 入力欄の判定。Android の API を使わない。 */
object AutofillFields {
    // android.text.InputType / View と同じ値(端末なしで試せるよう、ここに写して持つ)
    const val IMPORTANT_AUTO = 0
    const val IMPORTANT_YES = 1
    const val IMPORTANT_NO = 2
    const val IMPORTANT_YES_EXCLUDE_DESCENDANTS = 4
    const val IMPORTANT_NO_EXCLUDE_DESCENDANTS = 8

    private const val TYPE_MASK_CLASS = 0xf
    private const val TYPE_MASK_VARIATION = 0xff0
    private const val CLASS_TEXT = 0x1
    private const val CLASS_NUMBER = 0x2
    private const val TEXT_VARIATION_PASSWORD = 0x80
    private const val TEXT_VARIATION_VISIBLE_PASSWORD = 0x90
    private const val TEXT_VARIATION_WEB_PASSWORD = 0xe0
    private const val NUMBER_VARIATION_PASSWORD = 0x10

    private val USERNAME_WORDS = listOf("user", "email", "login", "mail", "id")

    private enum class Kind { USERNAME, PASSWORD, NEW_PASSWORD, HEURISTIC_USERNAME, NONE }

    fun isUsable(f: FieldInfo<*>): Boolean =
        f.isText && f.visible &&
            f.importantForAutofill != IMPORTANT_NO && f.importantForAutofill != IMPORTANT_NO_EXCLUDE_DESCENDANTS

    /**
     * 画面の欄を、画面の上から順に渡す。パスワードの欄(現在か新規)が1つも無ければ null。
     * ユーザー名だけの画面(2段階のログインの1段目など)は対象外。
     */
    fun <ID> detect(fields: List<FieldInfo<ID>>): LoginFields<ID>? {
        val usable = fields.filter(::isUsable)
        val kinds = usable.map { classify(it) }
        val passwords = usable.indices.filter { kinds[it] == Kind.PASSWORD }
        val newPasswords = usable.indices.filter { kinds[it] == Kind.NEW_PASSWORD }
        if (passwords.isEmpty() && newPasswords.isEmpty()) return null

        // 複数あるときは、フォーカスのある欄、なければ最初の欄
        val pw = pick(usable, passwords)
        val newPw = pick(usable, newPasswords)
        // ユーザー名は、入力するパスワード(なければ新規のパスワード)の欄を基準に選ぶ
        val anchor = pw ?: newPw!!
        val user = pickUsername(usable, kinds, anchor)
        return LoginFields(
            username = user?.let { usable[it].id },
            password = pw?.let { usable[it].id },
            newPassword = newPw?.let { usable[it].id },
        )
    }

    private fun <ID> pick(usable: List<FieldInfo<ID>>, idx: List<Int>): Int? =
        idx.firstOrNull { usable[it].isFocused } ?: idx.firstOrNull()

    private fun <ID> pickUsername(usable: List<FieldInfo<ID>>, kinds: List<Kind>, anchor: Int): Int? {
        // 明示されたユーザー名の欄を優先: 基準より前で最も近いもの、なければ最初のもの
        val explicit = usable.indices.filter { kinds[it] == Kind.USERNAME }
        explicit.lastOrNull { it < anchor }?.let { return it }
        explicit.firstOrNull()?.let { return it }
        // 名前から推測した欄は、基準より前にあるものだけ
        return usable.indices.lastOrNull { kinds[it] == Kind.HEURISTIC_USERNAME && it < anchor }
    }

    private fun classify(f: FieldInfo<*>): Kind {
        val hints = f.autofillHints.map { it.lowercase() }
        val isInput = f.htmlTag.equals("input", ignoreCase = true)
        val attrs = if (isInput) f.htmlAttrs.mapKeys { it.key.lowercase() } else emptyMap()
        val autocomplete = attrs["autocomplete"].orEmpty().lowercase().split(' ', '\t').filter { it.isNotEmpty() }

        // new-password の欄には入力しない(他の手がかりより先に見る)
        if ("newpassword" in hints || "new-password" in hints || "new-password" in autocomplete) return Kind.NEW_PASSWORD

        // 1. autofillHints
        if ("password" in hints) return Kind.PASSWORD
        if ("username" in hints || "emailaddress" in hints) return Kind.USERNAME

        // 2. inputType
        if (isPasswordInputType(f.inputType)) return Kind.PASSWORD

        // 3. HTML の input
        if (isInput) {
            if (attrs["type"].orEmpty().trim().equals("password", ignoreCase = true)) return Kind.PASSWORD
            if ("current-password" in autocomplete) return Kind.PASSWORD
            if ("username" in autocomplete || "email" in autocomplete) return Kind.USERNAME
        }

        // 4. 名前からの推測(パスワードの欄より前にある文字入力欄のとき、あとで位置を確かめる)
        if (isTextInput(f) && looksLikeUsername(f)) return Kind.HEURISTIC_USERNAME
        return Kind.NONE
    }

    private fun isPasswordInputType(t: Int): Boolean {
        val cls = t and TYPE_MASK_CLASS
        val variation = t and TYPE_MASK_VARIATION
        return when (cls) {
            CLASS_TEXT -> variation == TEXT_VARIATION_PASSWORD ||
                variation == TEXT_VARIATION_WEB_PASSWORD ||
                variation == TEXT_VARIATION_VISIBLE_PASSWORD
            CLASS_NUMBER -> variation == NUMBER_VARIATION_PASSWORD
            else -> false
        }
    }

    private fun isTextInput(f: FieldInfo<*>): Boolean {
        if (f.htmlTag.equals("input", ignoreCase = true)) {
            val type = f.htmlAttrs.mapKeys { it.key.lowercase() }["type"].orEmpty().trim().lowercase()
            return type in setOf("", "text", "email", "tel", "search")
        }
        return (f.inputType and TYPE_MASK_CLASS) == CLASS_TEXT
    }

    private fun looksLikeUsername(f: FieldInfo<*>): Boolean {
        val text = listOfNotNull(f.idEntry, f.hint).joinToString(" ").lowercase()
        return USERNAME_WORDS.any { it in text }
    }
}
