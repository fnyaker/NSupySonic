plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "org.nsupysonic.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "org.nsupysonic.app"
        minSdk = 26
        targetSdk = 34
        versionCode = (System.getenv("VERSION_CODE") ?: "1").toInt()
        versionName = System.getenv("VERSION_NAME") ?: "1.0.0"
    }

    signingConfigs {
        create("release") {
            // Provided by CI (generated per-run, or stable via repo secrets).
            val storePath = System.getenv("ANDROID_KEYSTORE_FILE")
            if (storePath != null) {
                storeFile = file(storePath)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            // Tiny app, no need for R8 — keeps the JS bridge and CI simple.
            isMinifyEnabled = false
            signingConfig =
                if (System.getenv("ANDROID_KEYSTORE_FILE") != null)
                    signingConfigs.getByName("release")
                else signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    // MediaSessionCompat + MediaStyle notification (the WebView owns the audio;
    // native only exposes session/transport, so media3/ExoPlayer is not needed).
    implementation("androidx.media:media:1.7.0")
}
