package dev.yokomichi.pwvault.testlogin

import android.app.Activity
import android.os.Bundle
import android.view.autofill.AutofillManager
import android.widget.Button
import android.widget.EditText
import android.widget.TextView

/** エミュレーター用。ユーザー名とパスワードの欄と「Next」だけ。「Next」で自動入力に送信(commit)を知らせる。 */
class LoginActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_login)
        val status = findViewById<TextView>(R.id.status)
        findViewById<Button>(R.id.next).setOnClickListener {
            // 保存の確認を出すために、フォームの送信を自動入力に知らせる
            getSystemService(AutofillManager::class.java)?.commit()
            status.text = "Submitted"
        }
    }
}
