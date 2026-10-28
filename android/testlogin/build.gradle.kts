plugins {
    id("com.android.application")
}

// 本体と同じく、出力先だけ ASCII のパスに置く
layout.buildDirectory.set(file(System.getProperty("user.home") + "/pwvault-build/testlogin"))

android {
    namespace = "dev.yokomichi.pwvault.testlogin"
    compileSdk {
        version = release(36) { minorApiLevel = 1 }
    }

    defaultConfig {
        applicationId = "dev.yokomichi.pwvault.testlogin"
        minSdk = 29
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }
}

// エミュレーター用のテストアプリ。リリースは作らない(本体の APK にも入らない別のモジュール)
androidComponents {
    beforeVariants { variant ->
        if (variant.buildType == "release") variant.enable = false
    }
}
