# M0 — Foundation and rights

**Done**
* Bare React Native 0.86.0 (New Architecture, Hermes), TypeScript strict; native
  Android and iOS projects committed; application ID `org.namuai.offline`
  (`.internal` for debug builds) on both platforms.
* Fixed stack installed and pinned exactly (`package.json` has no `^`/`~`;
  enforced by `npm run check:arch`): llama.rn 0.12.9, op-sqlite (FTS5),
  React Native Paper 5, React Navigation 7, Zustand 5, i18next, markdown-it.
* `docs/toolchain.lock.md`, `package-lock.json`, `ios/Podfile.lock`, Gradle wrapper.
* Approved Namu logo and icon imported unmodified; DM Sans and the Material
  Symbols subset built by reproducible tools; licence inventory in
  `docs/assets/asset-inventory.md`.
* Native service contracts: `docs/engineering/native-contract.md` and the
  codegen specs in `src/infrastructure/platform/specs/`.
* iOS: clean Debug simulator build (**BUILD SUCCEEDED**, Xcode 26.5).

**Open**
* **Rights record (PRD-007).** No written evidence of rights covering Namu's
  use and redistribution of Tiny Aya Global is in the repository. The upstream
  licence is CC-BY-NC 4.0 with an acceptable-use addendum. Owner action.
* App-ID registration in the Play and App Store accounts (STK-004). Owner action.
* **Android build.** The bootstrap machine has no Android SDK (its licence needs
  the owner's acceptance) and no JDK 17. `android/namu-core` builds and tests on
  the JVM; the app module is type-checked by `android/typecheck` against real
  React Native/AndroidX class files but has never been assembled.
* Gradle dependency verification metadata (STK-001) — needs the same machine.
