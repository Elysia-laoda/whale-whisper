import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "com.zorv.plugin.whale"
    // 本机 SDK 只有 android-35；上游模块用 36。插件只用 org.json / File / 线程，35 足够。
    compileSdk = 35

    defaultConfig {
        applicationId = "com.zorv.plugin.whale"
        minSdk = 26
        targetSdk = 34
        versionCode = 15
        versionName = "1.13.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    lint {
        abortOnError = false
        checkReleaseBuilds = false
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_17
    }
}

// 契约类运行时由宿主提供，绝不能打进插件包（否则接口 Class 各持一份，调用即 ClassCastException）。
dependencies {
    compileOnly(project(":plugin-contract"))
}
