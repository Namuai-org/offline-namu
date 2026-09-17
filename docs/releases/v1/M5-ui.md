# M5 — Complete product UI

**Built:** S01–S10, three bottom tabs, setup/recovery above the tabs, Namu
tokens and components (NamuButton, NamuTextField, NamuDialog, StatusNotice,
DownloadProgress, ChatMessage, EmptyState, StorageRow + rows, ActionSheet,
Screen), safe Markdown renderer, 333 strings × 3 locales, localized byte/date
formatting.

## Screen checklist

| Screen | Built | Automated journey | Notes |
|---|---|---|---|
| S01 Language and introduction | yes | `ui/journey` | device locale preselected only when supported; no account screen |
| S02 Device and download | yes | `ui/journey` (T01, ineligible device, metered consent) | size shown from the signed exact byte count |
| S03 Setup progress | yes | `ui/journey` | verification has its own percentage; self-test has none; state comes from native snapshots |
| S04 Chat | yes | `ui/chatJourney` | starter prompts insert only; Stop label; Jump to latest; link confirmation with hostname |
| S05 Conversations | yes | `ui/chatJourney` | keyset pages, local search, rename 1–80 clusters, export warning, transactional delete |
| S06 Settings | yes | `ui/chatJourney` | no tuning controls |
| S07 Offline storage | yes | `ui/chatJourney` (no automatic update check) | update/repair/restore paths exercised only through fakes |
| S08 Privacy and data | yes | `ui/chatJourney` (both delete scopes) | no telemetry toggle |
| S09 Help / recovery | yes | — | support contact hidden until an address is configured |
| S10 About the AI | yes | — | licence text vendored, pending legal review |

**Verified:** `npm run check:contrast` (38 token pairs, DS-004);
`npm run check:locales` (identical keys/placeholders/plurals, T25);
15 UI journey tests with fake native adapters.

**Open:**
* Locale reviewer sign-off (LOC-002). `src/locales/review-status.json` marks all
  three languages `draft`; `check-locales.js --release` fails until reviewed.
  The Hausa and French strings were machine-drafted and **must not ship
  unreviewed**.
* Light / dark / 200 % text screenshots and T24 TalkBack / VoiceOver passes.
* DM Sans has no ƙ ɗ ɓ ƴ glyphs (system fallback) — reviewer judgement needed.
* Hardware Ctrl/Cmd+Enter and IME behaviour on real keyboards.
