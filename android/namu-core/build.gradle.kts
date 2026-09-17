import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.dsl.KotlinVersion

// Standalone JVM build: `cd android/namu-core && ./gradlew test`.
//
// Kotlin Gradle plugin 2.1.20 is the version the React Native 0.86 template uses for
// android/app, which compiles this very source directory (android/app/build.gradle), so
// what is verified here is compiled by the same compiler there. 2.1.20 was verified to
// run on JDK 25.0.2 with Gradle 9.3.1; no newer plugin is needed.
plugins {
    kotlin("jvm") version "2.1.20"
}

group = "org.namuai.offline"
version = "1.0.0"

// `./gradlew compileKotlin -Pnamu.java8ApiCheck` compiles the main sources against the
// Java 8 class library only (-Xjdk-release=1.8). Android API 29 offers all of Java 8 but
// only parts of Java 9+, and there is no Android SDK/lint on this machine, so this is the
// guard against accidentally using e.g. InputStream.readNBytes or java.util.HexFormat.
val java8ApiCheck = providers.gradleProperty("namu.java8ApiCheck").isPresent

kotlin {
    // No jvmToolchain: build with whatever JDK runs Gradle (JDK 17+).
    compilerOptions {
        jvmTarget.set(if (java8ApiCheck) JvmTarget.JVM_1_8 else JvmTarget.JVM_17)
        if (java8ApiCheck) freeCompilerArgs.add("-Xjdk-release=1.8")
        // Explicit so a later plugin bump cannot silently move past the app's language level.
        languageVersion.set(KotlinVersion.KOTLIN_2_1)
        apiVersion.set(KotlinVersion.KOTLIN_2_1)
        allWarningsAsErrors.set(false)
    }
}

java {
    val level = if (java8ApiCheck) JavaVersion.VERSION_1_8 else JavaVersion.VERSION_17
    sourceCompatibility = level
    targetCompatibility = level
}

dependencies {
    // Same OkHttp version React Native 0.86 resolves
    // (node_modules/react-native/gradle/libs.versions.toml).
    implementation("com.squareup.okhttp3:okhttp:4.9.2")
    // compileOnly: the app supplies `tink-android` (identical
    // com.google.crypto.tink.subtle.Ed25519Verify API); tests use the JVM jar.
    compileOnly("com.google.crypto.tink:tink:1.23.0")

    testImplementation(kotlin("test"))
    testImplementation("org.junit.jupiter:junit-jupiter:5.14.4")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher:1.14.4")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.9.2")
    testImplementation("com.google.crypto.tink:tink:1.23.0")
    // TEST-ONLY: runs the journal SQL (contract §5) against a real SQLite.
    testImplementation("org.xerial:sqlite-jdbc:3.53.4.0")
}

tasks.test {
    useJUnitPlatform()
    maxHeapSize = "1g"
    // A hung socket must fail the build instead of blocking it.
    systemProperty("junit.jupiter.execution.timeout.default", "5 m")
    // Shared conformance vectors are read in place (never copied).
    systemProperty(
        "namu.descriptorVectors",
        rootDir.resolve("../../model-release/test-vectors/descriptor-vectors.json").canonicalPath,
    )
    testLogging {
        events("failed", "skipped")
        showStandardStreams = false
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}
