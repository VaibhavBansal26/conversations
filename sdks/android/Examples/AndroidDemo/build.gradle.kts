plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// the deployment and token come from gradle properties so nothing sensitive is committed:
//   ./gradlew :demo:installDebug -PconversationsUrl=https://your-app.example.com -PconversationsToken=cvt_...
// The emulator reaches a server on your computer at http://10.0.2.2:<port>.
val url: String = (project.findProperty("conversationsUrl") as String?) ?: "http://10.0.2.2:3000"
val token: String = (project.findProperty("conversationsToken") as String?) ?: ""

android {
    namespace = "com.conversations.demo"
    compileSdk = 34
    defaultConfig {
        applicationId = "com.conversations.demo"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
        buildConfigField("String", "CONVERSATIONS_URL", "\"$url\"")
        buildConfigField("String", "CONVERSATIONS_TOKEN", "\"$token\"")
    }
    buildFeatures { buildConfig = true; compose = true }
    composeOptions { kotlinCompilerExtensionVersion = "1.5.14" }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation(project(":conversations-android"))
    implementation("androidx.activity:activity-compose:1.9.1")
    implementation(platform("androidx.compose:compose-bom:2024.06.00"))
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
}
