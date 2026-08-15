plugins {
    id("com.android.library")
}

android {
    namespace = "com.termux.terminal"
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
