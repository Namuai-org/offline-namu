# Device journeys (Maestro)

Functional journeys for emulators/simulators and real devices (QA-004,
A11Y-001). They drive **internal** builds (`org.namuai.offline.internal`):
on a simulator the scripted engine answers, on a device the real model does.

```bash
# 1. serve a development artifact (fixture or the locked model)
node model-release/dev/make-dev-bundle.mjs --model <file.gguf>
node tools/fault-server/server.mjs --root model-release/dev/out/serve --port 8787
# 2. build and install an internal build, then
maestro test e2e/flows
```

| Flow | Covers |
|---|---|
| `01-first-run.yaml` | S01 language + introduction, S02 device check, S03 progress to Ready |
| `02-chat.yaml` | S04 empty state, starter prompt, send, stop, try again, copy |
| `03-history.yaml` | S05 list, search, rename, export warning, delete |
| `04-settings.yaml` | S06 language/theme, S07 storage, S08 privacy, S09 help, S10 about |
| `05-airplane-mode.yaml` | T02: cold launch and the whole local journey with the network off (manual toggle step on iOS) |

Accessibility passes (T24: TalkBack / VoiceOver, 200 % text) are manual and
recorded in `docs/releases/v1/M5-ui.md`; Maestro cannot assert screen-reader
speech.

Status: flows are written against the app's `testID`s and have **not been run**
yet — Maestro is not installed on the bootstrap machine.
