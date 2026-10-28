package dev.yokomichi.pwvault.app.autofill

import android.app.assist.AssistStructure
import android.view.View
import android.view.autofill.AutofillId
import dev.yokomichi.pwvault.core.AutofillFields
import dev.yokomichi.pwvault.core.FieldInfo

/**
 * 画面の1つの欄。[value] は保存のときだけ読む(入力された文字)。
 * AssistStructure の値をログや toString に出さない(設計書 §5-4、実装指示 3-7)。
 */
class ParsedField(val info: FieldInfo<AutofillId>, val webDomain: String?, val value: String?) {
    override fun toString(): String = "ParsedField"
}

class ParsedScreen(val packageName: String, val fields: List<ParsedField>) {
    override fun toString(): String = "ParsedScreen"
}

/** 判定に使った欄の AutofillId と、要求元。値は持たない。 */
class ScreenLogin(
    val packageName: String,
    val webDomain: String?,
    val username: AutofillId?,
    val password: AutofillId?,
    val newPassword: AutofillId?,
) {
    override fun toString(): String = "ScreenLogin"
}

object ScreenParser {
    // 暴走した画面で固まらないための上限
    private const val MAX_NODES = 20_000

    private class Item(val node: AssistStructure.ViewNode, val hidden: Boolean, val noExclude: Boolean)

    /** 画面を上から順に走査する。[withValues] が true のときだけ、入力された文字を読む。 */
    fun parse(structure: AssistStructure, withValues: Boolean, ignoreVisibility: Boolean = false): ParsedScreen {
        val fields = ArrayList<ParsedField>()
        val stack = ArrayDeque<Item>()
        for (i in structure.windowNodeCount - 1 downTo 0) {
            stack.addLast(Item(structure.getWindowNodeAt(i).rootViewNode, hidden = false, noExclude = false))
        }
        var visited = 0
        while (stack.isNotEmpty() && visited++ < MAX_NODES) {
            val item = stack.removeLast()
            val node = item.node
            val hidden = !ignoreVisibility && (item.hidden || node.visibility != View.VISIBLE)
            val important = node.importantForAutofill
            val noExclude = item.noExclude || important == AutofillFields.IMPORTANT_NO_EXCLUDE_DESCENDANTS
            val id = node.autofillId
            if (id != null && node.autofillType == View.AUTOFILL_TYPE_TEXT) {
                fields += ParsedField(toInfo(node, id, hidden, noExclude, important), node.webDomain?.takeIf { it.isNotBlank() }, valueOf(node, withValues))
            }
            for (c in node.childCount - 1 downTo 0) stack.addLast(Item(node.getChildAt(c), hidden, noExclude))
        }
        return ParsedScreen(structure.activityComponent.packageName, fields)
    }

    private fun toInfo(node: AssistStructure.ViewNode, id: AutofillId, hidden: Boolean, noExclude: Boolean, important: Int): FieldInfo<AutofillId> {
        val html = node.htmlInfo
        // 値(value 属性など)は写さない。判定に使う type と autocomplete だけ
        val attrs = HashMap<String, String>()
        html?.attributes?.forEach { p ->
            val k = p.first
            val v = p.second
            if (k.equals("type", true) || k.equals("autocomplete", true)) attrs[k] = v
        }
        return FieldInfo(
            id = id,
            autofillHints = node.autofillHints?.toList().orEmpty(),
            inputType = node.inputType,
            htmlTag = html?.tag,
            htmlAttrs = attrs,
            idEntry = node.idEntry,
            hint = node.hint?.toString(),
            isFocused = node.isFocused,
            visible = !hidden,
            importantForAutofill = if (noExclude) AutofillFields.IMPORTANT_NO else important,
            isText = true,
        )
    }

    private fun valueOf(node: AssistStructure.ViewNode, withValues: Boolean): String? {
        if (!withValues) return null
        val v = node.autofillValue ?: return null
        return if (v.isText) v.textValue.toString() else null
    }

    /**
     * 欄を判定し、ログイン欄が見つかれば [ScreenLogin] を返す。
     * webDomain は、入力する欄(パスワード、なければ新しいパスワード、なければユーザー名)の持ち主のものを使う。
     */
    fun resolve(screen: ParsedScreen): ScreenLogin? {
        val detected = AutofillFields.detect(screen.fields.map { it.info }) ?: return null
        fun domainOf(id: AutofillId?): String? = id?.let { i -> screen.fields.firstOrNull { it.info.id == i }?.webDomain }
        val web = domainOf(detected.password) ?: domainOf(detected.newPassword) ?: domainOf(detected.username)
        return ScreenLogin(screen.packageName, web, detected.username, detected.password, detected.newPassword)
    }

    /** 保存のとき、欄の入力値を取り出す。 */
    fun valueOf(screen: ParsedScreen, id: AutofillId?): String? =
        id?.let { i -> screen.fields.firstOrNull { it.info.id == i }?.value }
}
