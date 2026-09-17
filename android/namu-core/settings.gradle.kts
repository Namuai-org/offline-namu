// Standalone pure Kotlin/JVM build for the platform-independent part of the
// Namu Android native layer. It is intentionally NOT part of the React Native
// Gradle build: android/app compiles these same sources through an extra
// source directory (see android/app/build.gradle and
// docs/engineering/android-native-notes.md).
pluginManagement {
    repositories {
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        mavenCentral()
    }
}

rootProject.name = "namu-core"
