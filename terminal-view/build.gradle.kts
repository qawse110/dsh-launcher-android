plugins {
    id("com.android.library")
}

android {
    namespace = "com.termux.view"
    // compileSdk=35：与现有本地 SDK 环境匹配（android-36 platform 需另行下载）
    compileSdk = 35
    defaultConfig {
        minSdk = 24
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    api(project(":terminal-emulator"))
    implementation("androidx.annotation:annotation:1.7.0")
}
