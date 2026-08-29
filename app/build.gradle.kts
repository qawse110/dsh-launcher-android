plugins {
    id("com.android.application")
}

android {
    namespace = "com.dsh.launcher"
    // compileSdk=35：与现有本地 SDK 环境匹配（android-36 platform 需另行下载）；
    // 代码未使用 API 36 特性，androidx 依赖（appcompat/material/core-ktx）均支持 35。
    compileSdk = 35

    defaultConfig {
        applicationId = "com.dsh.launcher"
        minSdk = 24
        targetSdk = 28
        versionCode = 33
        versionName = "4.10.2"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // CI 里 workflow 已把 DSH_KEYSTORE_B64 解码为 DSH_KEYSTORE_FILE 指向的
            // release.keystore 文件；文件存在时用正式 release 签名，否则回退 debug
            // 签名（本地可构建）。正式签名是绕过 ColorOS 对 debug 签名 app 的
            // exec 过滤的关键假设验证。
            val ksFile = File(System.getenv("DSH_KEYSTORE_FILE") ?: "release.keystore")
            if (ksFile.isFile) {
                signingConfig = signingConfigs.create("release") {
                    storeFile = ksFile
                    storePassword = System.getenv("DSH_KEYSTORE_PASS") ?: "dshlauncher123"
                    keyAlias = "dsh"
                    keyPassword = System.getenv("DSH_KEYSTORE_PASS") ?: "dshlauncher123"
                }
            } else {
                signingConfig = signingConfigs.getByName("debug")
            }
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // 内置终端需要原生 libtermux.so
    packaging {
        jniLibs.useLegacyPackaging = false
    }

    // targetSdk=28 用于对齐 termux 的 SELinux 域(untrusted_app_27)实验，
    // 低于 Play 商店的 targetSdk 要求，需放行该 lint 检查
    lint {
        disable += "ExpiredTargetSdkVersion"
    }

    // P2-2 测试地基：JVM 单测允许 android.* 桩默认值（Log 等返回 0/null 不抛错）
    testOptions {
        unitTests {
            isReturnDefaultValues = true
            isIncludeAndroidResources = true
        }
    }
}

dependencies {
    implementation(project(":terminal-view"))
    implementation("org.apache.commons:commons-compress:1.26.2")
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.documentfile:documentfile:1.0.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.13")
    testImplementation("androidx.test:core:1.6.1")
}
