package dev.yokomichi.pwvault.core

import java.security.SecureRandom

/** 設計書 §5-2 の 5: 長さと文字種を指定して生成する。乱数は SecureRandom。 */
class PasswordGenerator(private val random: SecureRandom = SecureRandom()) {
    enum class CharSet(val chars: String) {
        LOWER("abcdefghijklmnopqrstuvwxyz"),
        UPPER("ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
        DIGITS("0123456789"),
        SYMBOLS("!@#$%^&*()-_=+[]{};:,.?"),
    }

    fun generate(length: Int, sets: Set<CharSet>): String {
        require(sets.isNotEmpty()) { "文字種を1つ以上選んでください" }
        require(length >= sets.size) { "長さが文字種の数より短いです" }
        val ordered = sets.toList()
        val pool = ordered.joinToString("") { it.chars }
        val out = CharArray(length)
        // 各文字種から最低1文字を入れ、残りは全体から選ぶ
        for (i in ordered.indices) out[i] = pick(ordered[i].chars)
        for (i in ordered.size until length) out[i] = pick(pool)
        for (i in out.indices.reversed()) { // Fisher-Yates
            val j = random.nextInt(i + 1)
            val t = out[i]
            out[i] = out[j]
            out[j] = t
        }
        return String(out)
    }

    private fun pick(chars: String): Char = chars[random.nextInt(chars.length)]
}
