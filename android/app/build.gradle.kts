plugins { id("com.android.application") }

val signingStorePath = providers.environmentVariable("SIGNAL_ANDROID_KEYSTORE").orNull
val signingStorePassword = providers.environmentVariable("SIGNAL_ANDROID_KEYSTORE_PASSWORD").orNull
val signingAlias = providers.environmentVariable("SIGNAL_ANDROID_KEY_ALIAS").orNull
val signingKeyPassword = providers.environmentVariable("SIGNAL_ANDROID_KEY_PASSWORD").orNull
val canSignRelease = listOf(signingStorePath, signingStorePassword, signingAlias, signingKeyPassword).all { !it.isNullOrBlank() }

android {
    namespace = "cloud.signal.android"
    compileSdk { version = release(37) }
    buildToolsVersion = "37.0.0"
    defaultConfig {
        applicationId = "cloud.signal.android"
        minSdk = 21
        targetSdk = 37
        versionCode = 2
        versionName = "0.1.1"
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64") }
    }
    if (canSignRelease) {
        signingConfigs.create("release") {
            storeFile = file(signingStorePath!!)
            storePassword = signingStorePassword
            keyAlias = signingAlias
            keyPassword = signingKeyPassword
            enableV1Signing = true
            enableV2Signing = true
            enableV3Signing = true
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            isShrinkResources = false
            if (canSignRelease) signingConfig = signingConfigs.getByName("release")
        }
        debug { applicationIdSuffix = ".debug"; versionNameSuffix = "-debug" }
    }
    buildFeatures { buildConfig = true }
    sourceSets["main"].assets.directories.add(layout.buildDirectory.dir("generated/signalAssets").get().asFile.path)
    compileOptions {
        isCoreLibraryDesugaringEnabled = true
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    packaging {
        resources.excludes += setOf("META-INF/AL2.0", "META-INF/LGPL2.1", "META-INF/LICENSE.md", "META-INF/LICENSE-notice.md")
        // Android 5.x cannot load uncompressed native libraries directly.
        jniLibs.useLegacyPackaging = true
    }
}

// The APK carries the matching chat UI while all API and media traffic still
// uses the configured server. This avoids depending on its web UI version.
val bundledWeb = layout.projectDirectory.dir("../../dist-android")
val bundleSignalWeb = tasks.register<Sync>("bundleSignalWeb") {
    from(bundledWeb)
    into(layout.buildDirectory.dir("generated/signalAssets/web"))
}
tasks.named("preBuild") {
    dependsOn(bundleSignalWeb)
    doFirst {
        check(bundledWeb.file("index.html").asFile.isFile) {
            "Сначала соберите интерфейс Android из корня проекта: pnpm install --frozen-lockfile && pnpm build:android"
        }
    }
}

dependencies {
    // Last compatible families for API 21; the WebView engine is updated
    // separately by Android System WebView/Chrome on the device.
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.4")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
    implementation("io.livekit:livekit-android:2.29.0")
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")
}

gradle.taskGraph.whenReady {
    if (!canSignRelease && allTasks.any { it.project == project && it.name.contains("Release", ignoreCase = true) }) {
        throw GradleException("Для release задайте SIGNAL_ANDROID_KEYSTORE, SIGNAL_ANDROID_KEYSTORE_PASSWORD, SIGNAL_ANDROID_KEY_ALIAS и SIGNAL_ANDROID_KEY_PASSWORD. Ключ подписи храните вне исходников.")
    }
}
