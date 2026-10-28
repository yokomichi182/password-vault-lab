package dev.yokomichi.pwvault.core

import java.util.UUID

/** 設計書 §7: Chrome / Edge と Bitwarden の CSV を取り込む。 */
object CsvImport {
    class Result(val entries: List<Entry>, val duplicates: List<Entry>)

    fun parseCsv(text: String): List<List<String>> {
        val rows = ArrayList<List<String>>()
        var row = ArrayList<String>()
        val cell = StringBuilder()
        var inQuotes = false
        var i = 0
        val s = text.removePrefix("﻿")
        while (i < s.length) {
            val c = s[i]
            when {
                inQuotes && c == '"' && i + 1 < s.length && s[i + 1] == '"' -> {
                    cell.append('"')
                    i++
                }
                c == '"' -> inQuotes = !inQuotes
                !inQuotes && c == ',' -> {
                    row.add(cell.toString())
                    cell.clear()
                }
                !inQuotes && (c == '\n' || c == '\r') -> {
                    if (c == '\r' && i + 1 < s.length && s[i + 1] == '\n') i++
                    row.add(cell.toString())
                    cell.clear()
                    if (row.any { it.isNotEmpty() }) rows.add(row)
                    row = ArrayList()
                }
                else -> cell.append(c)
            }
            i++
        }
        if (cell.isNotEmpty() || row.isNotEmpty()) {
            row.add(cell.toString())
            if (row.any { it.isNotEmpty() }) rows.add(row)
        }
        return rows
    }

    /**
     * 見出し行から形式を判定して取り込む。読めない形式は IllegalArgumentException。
     * 同じ URL と同じユーザー名の組は duplicates に分ける（設計書 §7: 取り込み前に件数を見せる）。
     */
    fun import(
        text: String,
        existing: List<Entry>,
        now: Long,
        newUuid: () -> String = { UUID.randomUUID().toString() },
    ): Result {
        val rows = parseCsv(text)
        if (rows.isEmpty()) throw CsvFormatException(CsvFormatException.Reason.EMPTY)
        val header = rows[0].map { it.trim().lowercase() }
        val col = header.withIndex().associate { it.value to it.index }
        val keys = when {
            "login_uri" in col -> listOf("name", "login_uri", "login_username", "login_password", "notes")
            "url" in col && "password" in col -> listOf("name", "url", "username", "password", "note")
            else -> throw CsvFormatException(CsvFormatException.Reason.UNSUPPORTED)
        }
        fun get(r: List<String>, k: String): String = col[k]?.let { r.getOrNull(it) } ?: ""
        val seen = existing.map { it.url to it.username }.toMutableSet()
        val fresh = ArrayList<Entry>()
        val dups = ArrayList<Entry>()
        for (r in rows.drop(1)) {
            val e = Entry(
                uuid = newUuid(),
                title = get(r, keys[0]),
                username = get(r, keys[2]),
                password = get(r, keys[3]),
                url = get(r, keys[1]),
                notes = get(r, keys[4]),
                modifiedAt = now,
            )
            if (!seen.add(e.url to e.username)) dups.add(e) else fresh.add(e)
        }
        return Result(fresh, dups)
    }
}

/** 取り込めない CSV。画面に出す文言は呼び出し側が言語に合わせて選ぶ。 */
class CsvFormatException(val reason: Reason) : IllegalArgumentException(reason.name) {
    enum class Reason { EMPTY, UNSUPPORTED }
}
