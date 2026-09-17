import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.dsl.KotlinVersion
import java.util.zip.ZipFile

// Compile-only verification of android/app's Kotlin WITHOUT the Android SDK:
//
//   cd android/typecheck && ../namu-core/gradlew -p . compileKotlin
//
// The Android framework API comes from Robolectric's `android-all` jar (an AOSP build
// under the Apache 2.0 licence, published on Maven Central — not the Android SDK and no
// licence click-through). React Native, WorkManager and androidx.core come from their
// published AARs (classes.jar is extracted). The codegen spec classes are generated with
// the same node scripts the React Native Gradle plugin runs. BuildConfig, R and
// PackageList are tiny stubs under stubs/.
//
// This proves names, signatures, nullability and overrides. It does NOT run resource
// processing, manifest merging, lint (API-level checks), D8 or packaging; those still
// need a real `./gradlew :app:assembleDebug` on a machine with the Android SDK.
plugins {
    kotlin("jvm") version "2.1.20"
}

val repoRoot = rootDir.resolve("../..").canonicalFile
val codegenDir = layout.buildDirectory.dir("codegen")

val aar: Configuration by configurations.creating { isTransitive = false }

dependencies {
    // Android framework API level 35 (needed for SQLiteDatabase.beginTransactionReadOnly).
    compileOnly("org.robolectric:android-all:15-robolectric-13954326")

    aar("com.facebook.react:react-android:0.86.0:release@aar")
    aar("androidx.work:work-runtime:2.10.5@aar")
    aar("androidx.core:core:1.13.1@aar")
    aar("com.facebook.fbjni:fbjni:0.7.0@aar") // HybridClassBase, needed by javac for the generated specs
    // Supertype chain of ReactActivity (template MainActivity).
    aar("androidx.appcompat:appcompat:1.7.0@aar")
    aar("androidx.fragment:fragment:1.6.2@aar")
    aar("androidx.activity:activity:1.9.3@aar")
    aar("androidx.lifecycle:lifecycle-runtime-android:2.8.7@aar")
    aar("androidx.lifecycle:lifecycle-viewmodel-android:2.8.7@aar")
    aar("androidx.savedstate:savedstate:1.2.1@aar")
    compileOnly("androidx.annotation:annotation-jvm:1.8.1")
    compileOnly("com.google.guava:listenablefuture:1.0")
    compileOnly("androidx.lifecycle:lifecycle-common-jvm:2.8.7")
    compileOnly("org.jetbrains.kotlinx:kotlinx-coroutines-core-jvm:1.10.2")
    compileOnly("com.squareup.okhttp3:okhttp:4.9.2")
    compileOnly("com.google.crypto.tink:tink:1.23.0")
    compileOnly("com.google.code.findbugs:jsr305:3.0.2")
    compileOnly("javax.inject:javax.inject:1")
    compileOnly("com.facebook.yoga:proguard-annotations:1.19.0")
    compileOnly("com.facebook.infer.annotation:infer-annotation:0.18.0")
    // app/src/androidTest sources are type-checked too (they are NOT run here).
    aar("androidx.test.ext:junit:1.2.1@aar")
    aar("androidx.test:monitor:1.7.2@aar")
    aar("androidx.work:work-testing:2.10.5@aar")
    compileOnly("junit:junit:4.13.2")
}

val extractAars by tasks.registering {
    val out = layout.buildDirectory.dir("aar-classes")
    val files = aar
    inputs.files(files)
    outputs.dir(out)
    doLast {
        val target = out.get().asFile.apply { deleteRecursively(); mkdirs() }
        files.files.forEach { archive ->
            ZipFile(archive).use { zip ->
                val entry = zip.getEntry("classes.jar") ?: return@use
                zip.getInputStream(entry).use { input ->
                    target.resolve(archive.nameWithoutExtension + ".jar").outputStream().use { input.copyTo(it) }
                }
            }
        }
    }
}

val generateCodegenSchema by tasks.registering(Exec::class) {
    val schema = codegenDir.map { it.file("schema.json") }
    inputs.dir(repoRoot.resolve("src/infrastructure/platform/specs"))
    outputs.file(schema)
    workingDir = repoRoot
    doFirst { schema.get().asFile.parentFile.mkdirs() }
    commandLine(
        "node", "node_modules/@react-native/codegen/lib/cli/combine/combine-js-to-schema-cli.js",
        schema.get().asFile.absolutePath, "src/infrastructure/platform/specs",
    )
}

val generateCodegenJava by tasks.registering(Exec::class) {
    dependsOn(generateCodegenSchema)
    val out = codegenDir.map { it.dir("out") }
    outputs.dir(out)
    workingDir = repoRoot
    commandLine(
        "node", "node_modules/react-native/scripts/generate-specs-cli.js",
        "--platform", "android",
        "--schemaPath", codegenDir.get().file("schema.json").asFile.absolutePath,
        "--outputDir", out.get().asFile.absolutePath,
        "--libraryName", "NamuNativeSpec",
        "--javaPackageName", "org.namuai.offline.specs",
    )
}

dependencies {
    compileOnly(fileTree(layout.buildDirectory.dir("aar-classes")) { include("*.jar"); builtBy(extractAars) })
}

sourceSets {
    main {
        java.srcDir("stubs")
        java.srcDir(codegenDir.map { it.dir("out/java") })
        kotlin.srcDir("../app/src/main/java")
        kotlin.srcDir("../app/src/androidTest/java")
        kotlin.srcDir("../namu-core/src/main/kotlin")
    }
}

tasks.named("compileKotlin") { dependsOn(extractAars, generateCodegenJava) }
tasks.named("compileJava") { dependsOn(extractAars, generateCodegenJava) }

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
        // Same language level as the app's Kotlin 2.1.20.
        languageVersion.set(KotlinVersion.KOTLIN_2_1)
        apiVersion.set(KotlinVersion.KOTLIN_2_1)
    }
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}
