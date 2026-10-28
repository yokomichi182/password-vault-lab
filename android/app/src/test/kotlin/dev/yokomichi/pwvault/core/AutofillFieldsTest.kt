package dev.yokomichi.pwvault.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

private const val CANARY = "CANARY-7f3e9a1c"

// android.text.InputType と同じ値
private const val TEXT = 0x1
private const val TEXT_PASSWORD = 0x81
private const val TEXT_VISIBLE_PASSWORD = 0x91
private const val TEXT_WEB_PASSWORD = 0xe1
private const val NUMBER_PASSWORD = 0x12
private const val NUMBER = 0x2

private fun f(
    id: Int,
    hints: List<String> = emptyList(),
    inputType: Int = TEXT,
    tag: String? = null,
    attrs: Map<String, String> = emptyMap(),
    idEntry: String? = null,
    hint: String? = null,
    focused: Boolean = false,
    visible: Boolean = true,
    important: Int = AutofillFields.IMPORTANT_AUTO,
) = FieldInfo(id, hints, inputType, tag, attrs, idEntry, hint, focused, visible, important)

/** 実装指示 4-1 の 5・14: 入力欄の判定。 */
class AutofillFieldsTest {
    // 5: autofillHints
    @Test
    fun autofillHintsでユーザー名とパスワードが見つかる() {
        val r = AutofillFields.detect(listOf(f(1, listOf("username")), f(2, listOf("password"))))
        assertEquals(LoginFields(1, 2, null), r)
        assertEquals(LoginFields(1, 2, null), AutofillFields.detect(listOf(f(1, listOf("emailAddress")), f(2, listOf("password")))))
    }

    // 5: inputType
    @Test
    fun inputTypeのパスワードの種類が見つかる() {
        for (t in listOf(TEXT_PASSWORD, TEXT_VISIBLE_PASSWORD, TEXT_WEB_PASSWORD, NUMBER_PASSWORD)) {
            val r = AutofillFields.detect(listOf(f(1, idEntry = "login_name"), f(2, inputType = t)))
            assertEquals(LoginFields(1, 2, null), r, "inputType=$t")
        }
        // 数字の欄(パスワードの種類でない)はパスワードにならない
        assertNull(AutofillFields.detect(listOf(f(1, idEntry = "user"), f(2, inputType = NUMBER))))
    }

    // 5: HTML
    @Test
    fun htmlのtypeとautocompleteで見つかる() {
        val input = "input"
        val byType = AutofillFields.detect(
            listOf(f(1, tag = input, attrs = mapOf("type" to "text", "autocomplete" to "username")), f(2, tag = input, attrs = mapOf("type" to "password"))),
        )
        assertEquals(LoginFields(1, 2, null), byType)
        val byAc = AutofillFields.detect(
            listOf(f(1, tag = input, attrs = mapOf("autocomplete" to "email")), f(2, tag = input, attrs = mapOf("autocomplete" to "current-password"))),
        )
        assertEquals(LoginFields(1, 2, null), byAc)
        // 属性名・値の大文字小文字、複数の語
        val mixed = AutofillFields.detect(
            listOf(f(1, tag = "INPUT", attrs = mapOf("AutoComplete" to "section-a username")), f(2, tag = "INPUT", attrs = mapOf("TYPE" to "Password"))),
        )
        assertEquals(LoginFields(1, 2, null), mixed)
    }

    // 5: idEntry と hint
    @Test
    fun idEntryとhintからユーザー名を推測する() {
        for ((idEntry, hint) in listOf("user_field" to null, "etEmail" to null, "login_id" to null, null to "Your mail", "x" to "Login")) {
            val r = AutofillFields.detect(listOf(f(1, idEntry = idEntry, hint = hint), f(2, inputType = TEXT_PASSWORD)))
            assertEquals(LoginFields(1, 2, null), r, "$idEntry/$hint")
        }
    }

    @Test
    fun 推測のユーザー名は_パスワードの欄より前にある文字入力欄だけ() {
        // パスワードより後ろ
        assertEquals(
            LoginFields<Int>(null, 1, null),
            AutofillFields.detect(listOf(f(1, inputType = TEXT_PASSWORD), f(2, idEntry = "user"))),
        )
        // 名前に手がかりがない
        assertEquals(
            LoginFields<Int>(null, 2, null),
            AutofillFields.detect(listOf(f(1, idEntry = "field_a"), f(2, inputType = TEXT_PASSWORD))),
        )
        // 文字入力でない(数字)欄
        assertEquals(
            LoginFields<Int>(null, 2, null),
            AutofillFields.detect(listOf(f(1, inputType = NUMBER, idEntry = "user"), f(2, inputType = TEXT_PASSWORD))),
        )
    }

    // 14
    @Test
    fun パスワードの欄が無い画面では何も返さない() {
        assertNull(AutofillFields.detect(listOf(f(1, listOf("username")), f(2, idEntry = "email"))))
        assertNull(AutofillFields.detect(emptyList<FieldInfo<Int>>()))
    }

    // 14
    @Test
    fun 見えない欄とimportantForAutofillがNOの欄は使わない() {
        assertNull(AutofillFields.detect(listOf(f(1, listOf("username")), f(2, inputType = TEXT_PASSWORD, visible = false))))
        assertNull(AutofillFields.detect(listOf(f(1, listOf("username")), f(2, inputType = TEXT_PASSWORD, important = AutofillFields.IMPORTANT_NO))))
        assertNull(
            AutofillFields.detect(listOf(f(1, listOf("username")), f(2, inputType = TEXT_PASSWORD, important = AutofillFields.IMPORTANT_NO_EXCLUDE_DESCENDANTS))),
        )
        // 見えないユーザー名の欄は使わず、見える欄を使う
        val r = AutofillFields.detect(
            listOf(f(1, listOf("username"), visible = false), f(2, listOf("username")), f(3, inputType = TEXT_PASSWORD)),
        )
        assertEquals(LoginFields(2, 3, null), r)
        // YES 系は使える
        assertNotNull(AutofillFields.detect(listOf(f(1, inputType = TEXT_PASSWORD, important = AutofillFields.IMPORTANT_YES))))
    }

    // 14
    @Test
    fun newPasswordの欄には入力しない_保存の対象にはする() {
        val ac = AutofillFields.detect(
            listOf(f(1, listOf("username")), f(2, tag = "input", attrs = mapOf("type" to "password", "autocomplete" to "new-password"))),
        )
        assertEquals(LoginFields(1, null, 2), ac)
        val hint = AutofillFields.detect(listOf(f(1, listOf("username")), f(2, listOf("newPassword"))))
        assertEquals(LoginFields(1, null, 2), hint)
        // 現在のパスワードと新しいパスワードが並ぶ画面(変更)では、現在の欄にだけ入力する
        val both = AutofillFields.detect(
            listOf(
                f(1, listOf("username")),
                f(2, listOf("password")),
                f(3, tag = "input", attrs = mapOf("type" to "password", "autocomplete" to "new-password")),
            ),
        )
        assertEquals(LoginFields(1, 2, 3), both)
    }

    @Test
    fun パスワードが複数あるときはフォーカスのある欄_なければ最初の欄() {
        val pw = { id: Int, focus: Boolean -> f(id, inputType = TEXT_PASSWORD, focused = focus) }
        assertEquals(1, AutofillFields.detect(listOf(f(0, listOf("username")), pw(1, false), pw(2, false)))!!.password)
        assertEquals(2, AutofillFields.detect(listOf(f(0, listOf("username")), pw(1, false), pw(2, true)))!!.password)
    }

    @Test
    fun ユーザー名は基準のパスワードに最も近い前の欄を選ぶ() {
        val r = AutofillFields.detect(
            listOf(f(1, listOf("username")), f(2, inputType = TEXT_PASSWORD), f(3, listOf("username")), f(4, inputType = TEXT_PASSWORD, focused = true)),
        )
        assertEquals(LoginFields(3, 4, null), r)
    }

    // 17
    @Test
    fun 欄の情報のtoStringに目印が入らない() {
        val s = f(1, listOf("username"), idEntry = "user").toString() + AutofillFields.detect(listOf(f(1, listOf("username")), f(2, listOf("password"))))
        assertFalse(s.contains(CANARY))
    }
}
