plugins {
    id("com.android.application")
}

android {
    namespace = "com.dsh.launcher"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.dsh.launcher"
        minSdk = 24
        targetSdk = 28
        versionCode = 4
        versionName = "4.0"
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
        // 用于验证"非 debuggable 是否影响 seccomp/exec"：克隆 debug 但关闭 debuggable
        create("nondbg") {
            initWith(getByName("debug"))
            isDebuggable = false
            signingConfig = signingConfigs.getByName("debug")
            // 子模块(terminal-view 等)只声明 debug/release，这里回退到 debug 变体
            matchingFallbacks += listOf("debug", "release")
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
}

dependencies {
    implementation(project(":terminal-view"))
    implementation("org.apache.commons:commons-compress:1.26.2")
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
}
