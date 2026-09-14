plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.opendoors.operador"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.opendoors.operador"
        // 26: notification channels exist from here, which removes an entire
        // branch of compatibility code from the alerting path.
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        // Debug-signed on purpose: this is sideloaded onto one phone. A
        // release keystore buys distribution we are not doing.
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

// No HTTP client, no JSON library, no coroutines. HttpURLConnection and
// org.json ship with Android; pulling in three libraries to poll one endpoint
// would be more dependency than program.
dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
}
