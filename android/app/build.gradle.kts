plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

// プロジェクトのパスに日本語を含むと、テストのワーカーがクラスを読めない。出力先だけ ASCII のパスに置く
layout.buildDirectory.set(file(System.getProperty("user.home") + "/pwvault-build/app"))

android {
    namespace = "dev.yokomichi.pwvault"
    compileSdk {
        version = release(36) { minorApiLevel = 1 }
    }

    defaultConfig {
        applicationId = "dev.yokomichi.pwvault"
        minSdk = 29
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    buildFeatures {
        compose = true
    }

    testOptions {
        unitTests.all { it.useJUnitPlatform() }
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2025.10.00"))
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.11.0")

    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("app.keemobile:kotpass:0.13.0")
    implementation("androidx.biometric:biometric:1.1.0")

    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("org.json:json:20240303")
    testImplementation(platform("org.junit:junit-bom:5.11.4"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}
