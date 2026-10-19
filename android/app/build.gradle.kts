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
        minSdk = 31
        targetSdk = 37
        versionCode = 1
        versionName = "0.1.0"
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64") }
    }
    if (canSignRelease) {
        signingConfigs.create("release") {
            storeFile = file(signingStorePath!!)
            storePassword = signingStorePassword
            keyAlias = signingAlias
            keyPassword = signingKeyPassword
            enableV1Signing = false
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
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    packaging {
        resources.excludes += setOf("META-INF/AL2.0", "META-INF/LGPL2.1", "META-INF/LICENSE.md", "META-INF/LICENSE-notice.md")
        jniLibs.useLegacyPackaging = false
    }
}

// The APK carries the matching chat UI while all API and media traffic still
// uses the configured server. This avoids depending on its web UI version.
val bundledWeb = layout.projectDirectory.dir("../../dist")
val bundleSignalWeb = tasks.register<Sync>("bundleSignalWeb") {
    from(bundledWeb)
    into(layout.buildDirectory.dir("generated/signalAssets/web"))
}
tasks.named("preBuild") {
    dependsOn(bundleSignalWeb)
    doFirst {
        check(bundledWeb.file("index.html").asFile.isFile) {
            "Сначала соберите интерфейс из корня проекта: pnpm install --frozen-lockfile && pnpm build"
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.19.1")
    implementation("androidx.activity:activity-ktx:1.13.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.11.0")
    implementation("androidx.webkit:webkit:1.17.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
    implementation("io.livekit:livekit-android:2.29.0")
}

gradle.taskGraph.whenReady {
    if (!canSignRelease && allTasks.any { it.project == project && it.name.contains("Release", ignoreCase = true) }) {
        throw GradleException("Для release задайте SIGNAL_ANDROID_KEYSTORE, SIGNAL_ANDROID_KEYSTORE_PASSWORD, SIGNAL_ANDROID_KEY_ALIAS и SIGNAL_ANDROID_KEY_PASSWORD. Ключ подписи храните вне исходников.")
    }
}
