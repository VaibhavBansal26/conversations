pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { google(); mavenCentral() }
}
rootProject.name = "conversations-android-sdk"
include(":conversations-android")
// the demo app is a separate module so the library has no app dependencies
include(":demo")
project(":demo").projectDir = file("Examples/AndroidDemo")
