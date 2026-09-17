# Namu Offline v1

An offline assistant for Android and iOS. After a one-time model installation
the app chats, keeps history, searches, exports and deletes data with **no
network access**. One assistant, one model: Cohere Labs *Tiny Aya Global*
(official Q4_K_M GGUF) running on-device through llama.rn 0.12.9.

The product specification is [`docs/PRD.md`](docs/PRD.md). It is the source of
truth; where code and PRD disagree, fix the code or amend the PRD (IMP-002).

> **Status — read this first.** The code base implements milestones M0–M6 as
> far as they can be built and tested on a development machine, and the whole
> setup → chat journey runs on the iOS simulator (with a scripted engine and a
> fixture artifact). It has **not** been run on a physical phone, the Android
> app module has **not** been assembled (no Android SDK on the bootstrap
> machine), the model artifact has **not** been acquired (PRD-007 rights
> gate), no infrastructure exists, and the Hausa/French strings are unreviewed
> drafts. The honest per-milestone state is in
> [`docs/releases/v1/`](docs/releases/v1/README.md).

## Layout (PRD section 4)

| Path | Responsibility |
|---|---|
| `src/app/` | Composition root, navigation, lifecycle wiring |
| `src/features/` | Screens S01–S10 (`setup`, `chat`, `conversations`, `settings`, `about`) |
| `src/domain/chat/` | `ChatSessionController`, prompt budgeting, system prompt, titles |
| `src/domain/inference/` | Engine contract, production configuration, ownership lock, typed failures |
| `src/domain/model/` | Install controller, eligibility rules, transfer snapshot types |
| `src/data/` | SQLite schema, checksum-locked migrations, repositories, FTS search, diagnostics ring |
| `src/infrastructure/inference/` | **Only** importer of llama.rn; runtime fixture; control-token guard |
| `src/infrastructure/platform/` | Typed adapters over the native TurboModules (`specs/` are the codegen contracts) |
| `src/infrastructure/db/` | op-sqlite driver |
| `src/design/` | Tokens, Namu components, safe Markdown renderer, icons, fonts |
| `src/locales/` | `en` / `fr` / `ha` JSON, consistency check, review status |
| `android/` | Kotlin services; `android/namu-core` is a pure-JVM module with the transfer protocol and its tests |
| `ios/` | Swift services, Objective-C++ TurboModule shims, XCTest target |
| `model-release/` | Artifact acquisition, signed descriptor tooling, conformance vectors, dev bundle, publication |
| `infra/` | Terraform: private S3 + CloudFront (OAC), staging and production |
| `tools/` | Fault-injection server, font/icon builders, notices/SBOM, licence vendoring |
| `tests/`, `e2e/`, `benchmarks/` | Jest suites, Maestro journeys, device harness and language evaluation set |
| `docs/` | PRD, toolchain lock, native contract, runtime contract, decisions, runbooks, release evidence |

Boundaries are enforced by `npm run check:arch` (ARC-001, SEC-003): components
never import llama.rn, run SQL, build model URLs or touch native paths, and no
JavaScript performs network I/O — the only network code in the product is the
native transfer service, used on explicit user actions.

## Working on it

```bash
npm ci
```

```bash
npm run verify
```

`verify` runs TypeScript (strict), ESLint, the locale check, the DS-004
contrast check, the architecture boundary check and Jest. Release tooling
tests:

```bash
node --test model-release/ tools/fault-server/
```

```bash
cd android/namu-core && ./gradlew test
```

### Running an internal build

Internal builds (`org.namuai.offline.internal`) trust a locally generated
**development** signing key and talk to the local fault server. Simulators use
a scripted engine (functional journeys only, DEV-001); real devices load the
real model.

```bash
node model-release/dev/make-dev-bundle.mjs --model <path/to/model.gguf>
```

```bash
node tools/fault-server/server.mjs --root model-release/dev/out/serve --port 8787
```

```bash
cd ios && pod install
```

```bash
npm run ios
```

Release builds refuse a non-HTTPS origin, a missing trust bundle, and any
verification key whose ID starts with `dev-`.

## Things this project will not do

No accounts, cloud inference, telemetry, model catalog, runtime or sampling
settings, voice, images, attachments, browsing, RAG or tools (PRD-002,
PRD-005). Do not add placeholder screens for them, and do not substitute
another model without a revised PRD (PRD-007).
