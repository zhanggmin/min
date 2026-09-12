# Repository Guidelines

## Project Structure & Module Organization

This is a Java 17 multi-module Gradle project. Shared game code lives in `core/src/mindustry/`, while runtime entry points are separated into `desktop/`, `server/`, `android/`, and `ios/`. Annotation processors are under `annotations/src/main/java/`; build-time utilities are in `tools/src/`. Game data, localization bundles, sprites, audio, and other resources belong in `core/assets/` or their source form in `core/assets-raw/`. JUnit tests and fixtures live in `tests/src/test/java/` and `tests/src/test/resources/`. Store packaging metadata is maintained under `fastlane/`.

The `mindustry.gen` package is generated during builds. Never edit generated classes by hand.

## Build, Test, and Development Commands

Use the checked-in Gradle wrapper and JDK 17:

- `./gradlew desktop:run` launches the desktop client from `core/assets`.
- `./gradlew desktop:dist` builds `desktop/build/libs/Mindustry.jar`.
- `./gradlew server:run` starts the headless server; `server:dist` creates its release JAR.
- `./gradlew tools:pack` regenerates packed sprites after asset changes.
- `./gradlew tests:test --stacktrace` runs the JUnit test suite.
- `./gradlew android:assembleDebug` builds an unsigned debug APK when an Android SDK is configured.

A sibling checkout of `Arc` is recommended; otherwise Gradle resolves it through JitPack.

## Coding Style & Naming Conventions

Follow `CONTRIBUTING.md` and import `.github/Mindustry-CodeStyle-IJ.xml` into IntelliJ. Use four spaces, same-line braces, and no spaces inside control parentheses: `if(condition){`. Use `camelCase` for all identifiers, including constants and enum values; avoid underscores and braceless multi-line conditionals. Prefer wildcard imports and Arc types such as `Seq`, `ObjectMap`, and primitive collections over boxed Java collections. Avoid allocations in update/render loops and APIs unsupported by Android or RoboVM, including streams, `java.awt`, and `java.util.function`.

## Testing Guidelines

Tests use JUnit Jupiter 5. Add focused classes named `*Tests.java` under the matching package in `tests/src/test/java/`; place binary fixtures in `tests/src/test/resources/`. Run the full suite and launch the affected runtime before submitting. Gameplay changes should also be verified interactively. No numeric coverage threshold is enforced, but regressions should include a targeted test where practical.

## Commit & Pull Request Guidelines

History favors short, imperative summaries such as `Fixed print statement field width`, with occasional scoped prefixes like `fix(ios): ...` and issue references such as `Fixed #12620`. Keep each commit focused. Pull requests must explain behavior and validation, link relevant issues, and include screenshots or recordings for visual changes. Discuss large features before implementation, avoid cleanup-only changes, and do not submit substantial AI-generated code. Never commit signing credentials, SDK paths, or machine-specific `local.properties` values.
