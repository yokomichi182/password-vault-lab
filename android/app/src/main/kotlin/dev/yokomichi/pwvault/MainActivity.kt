package dev.yokomichi.pwvault

import android.app.Application
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import dev.yokomichi.pwvault.app.App
import dev.yokomichi.pwvault.app.AppModel

class PwApplication : Application() {
    lateinit var model: AppModel

    override fun onCreate() {
        super.onCreate()
        model = AppModel(this)
        // 設計書 §5-3: 画面が消えたらすぐロックする
        registerReceiver(
            object : BroadcastReceiver() {
                override fun onReceive(context: Context?, intent: Intent?) = model.lock()
            },
            IntentFilter(Intent.ACTION_SCREEN_OFF),
        )
    }
}

class MainActivity : ComponentActivity() {
    private val model get() = (application as PwApplication).model

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 設計書 §5-3: スクリーンショットと最近のアプリ一覧に中身を出さない
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        setContent { MaterialTheme { App(model) } }
    }

    override fun onStart() {
        super.onStart()
        model.onForeground()
    }

    override fun onStop() {
        super.onStop()
        model.onBackground()
    }
}
