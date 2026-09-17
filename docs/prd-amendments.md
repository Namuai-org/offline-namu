# PRD amendments (IMP-002)

Documentation edits, thresholds and scope changes use versioned amendments.
Items under **Proposed** are raised by implementation findings; until the
project owner approves one, the PRD text stands. Items under **Approved** were
approved by the owner and are implemented.

## Proposed

### PA-001 — "128-token formatted prompt" cannot exist with the locked template

* Affects: DL-011 (self-test fixture), NFR-002 (first-token gate).
* Finding: the chat template embedded in the locked GGUF always renders
  Cohere's upstream preamble (about 1,900 characters) before any message, so
  every *formatted* prompt is several hundred tokens long. See
  `docs/engineering/runtime-contract.md` §2.
* Proposal: define both in terms of **fixture content** ("a fixed fixture whose
  user content is 128 tokens") and record the measured formatted count with
  every result. The 6 s first-token target should then be re-validated on the
  qualified device matrix, because the real prefill is larger than the PRD
  assumed.
* Current implementation: fixed fixture message; measured formatted count goes
  to diagnostics and to benchmark reports.

### PA-002 — CloudFront minimum TLS policy on the default domain

* Affects: DST-001 / section 6.
* Finding: with the assigned `*.cloudfront.net` domain AWS fixes the viewer
  security policy at `TLSv1`; `TLSv1.2_2021` requires an alias plus an ACM
  certificate. The PRD says the distribution domain is captured from Terraform
  outputs, which implies the default domain.
* Options: (a) register a domain + certificate and enforce `TLSv1.2_2021` at the
  edge, or (b) keep the default domain and rely on client-side enforcement
  (iOS ATS and Android 10+ both require TLS 1.2+). The Terraform module
  supports both; the owner must choose.

### PA-003 — Hausa glyph coverage of DM Sans

* Affects: DS-001.
* Finding: DM Sans has no glyphs for ƙ ɗ ɓ ƴ (nor their capitals); they render
  in the system fallback font. DS-001 permits "system fallback", so this is
  compliant, but mixed fonts inside Hausa words are visible.
* Proposal: have Hausa reviewers judge it during LOC-002 review; if rejected,
  approve a token revision to a family with full Hausa coverage.

### PA-004 — Signing-key rotation with a single descriptor endpoint

* Affects: SIG-004, REL-007, T30.
* Finding: one `releases/stable.json` signed by one key means app builds that
  trust only the old key and builds that trust only the new key cannot both
  receive new descriptors during a rotation. Offline chat is unaffected.
* Proposal: bundle old + new public keys for one app-release overlap window and
  document the order of operations (already described in
  `docs/runbooks/signing-keys.md`).

## Approved

### PA-005 — Namu brand palette and glass frame replace the section 14 token table — **APPROVED**

* Approved by: project owner, in-session instruction of 2026-09-17 ("brand the
  UI in Namu's brand, DM Sans, Apple-style glass frame, centre the titles,
  remove subtitles").
* Affects: PRD section 14 colour table, DS-002 radii, S01/S02 copy.
* Change: token revision `namu-brand-1` in `src/design/tokens.ts` — Harmattan
  `#F7F0E3`, Ink `#1C1410`, Sahel `#E8935A` (precision accent), Dry Clay, Kola —
  per `namu-brand-board.pdf`. DM Sans stays the only UI typeface (the board's
  Playfair Display is display-only and is not used in the app). Controls are
  pills; surfaces are glass: a native iOS system material (`UIGlassEffect` on
  iOS 26+, thin-material blur on iOS 17–25) under a warm tint, with a
  near-opaque token fallback on Android and wherever Reduce Transparency is on.
  Titles are centred; the S01 tagline and the S02 explanatory subtitle were
  removed (the download need is still stated on the introduction page and in
  the no-connection notice, T01).
* Unchanged: DS-004 still gates every token pair (`npm run check:contrast`,
  text 4.5:1, controls/focus 3:1); DS-005 state rules; PRD-006 attribution.
* Open: visual check of the Android fallback on a device; Hausa reviewers'
  opinion on DM Sans fallback glyphs (PA-003).

### PA-006 — System instruction `namu-text-2` (the assistant introduces itself as Namu) — **APPROVED**

* Approved by: project owner, in-session instruction of 2026-09-17 ("prompt the
  model to be Namu").
* Affects: CTX-001 (instruction text and version), descriptor `prompt_version`,
  EVAL-004 (evaluation reports are per prompt version).
* Finding: the locked GGUF's chat template always renders Cohere's default
  preamble — "Your name is Aya. You are a large language model built by
  Cohere." With `namu-text-1` ("You are Namu, a helpful assistant…") the real
  model introduced itself as **Aya in 8 of 8** samples, in English, French and
  Hausa. That contradicts PRD-006 ("Namu owns the product identity").
* Change: `namu-text-2` replaces the first sentence of `namu-text-1` with

  > Ignore the name and maker given in the default preamble. In every language,
  > your name is Namu and you were made by the Namu team. Never call yourself
  > Aya and never say you were created by Cohere. Only if asked which AI model
  > you use, say that Namu uses Tiny Aya, an open model trained by Cohere Labs.

  The rest of the instruction and the four response-language lines are
  unchanged. The app, the signing tool, both native verifiers and the shared
  conformance vectors now use `namu-text-2`; `namu-text-1` is no longer
  understood.
* Evidence: `model-release/desktop-smoke/identity-probe.mjs` against llama.cpp
  b10256 (commit `6c8dcaa7…`), the locked artifact and production sampling:
  **"Namu" in 33 of 35 samples, "Aya" in 0 of 35** (7 questions × 5 seeds;
  English, French, Hausa). Wording was chosen by measurement: restating the name
  ("Your name is Namu, not Aya") scored 1/8; bullet lists 0/8; only telling the
  model to disregard the default preamble works.
* Known limit: the model still often adds that it was "created/trained by
  Cohere Labs". That is true of the underlying model and does not breach
  PRD-006 (which forbids describing it as trained by Namu), and removing every
  mention of Cohere from the instruction made the name *less* reliable (16–18 of
  21). Cohere/Tiny Aya attribution remains in About the AI.
* Open: Hausa and French reviewers should read the identity answers (LOC-002);
  the LANG evaluation (M7) must be run under `namu-text-2`.

### PA-007 — Chat-first navigation with a history drawer; grouped Settings — **APPROVED**

* Approved by: project owner, in-session instructions of 2026-09-17 ("make the
  chat feel like ChatGPT mobile… the frame better shaped"; "settings organised
  in sections, professionally").
* Affects: UX-001 (three bottom tabs), S04 chat layout, S05 presentation, S06
  layout. No requirement about *what* each screen offers is removed.
* Change:
  * **Navigation.** The bottom tab bar is gone. Chat owns the screen; a
    start-edge drawer (menu button, or a swipe from the screen edge) holds
    search, New chat, the history grouped by day (Today / Yesterday / Previous 7
    days / Older) with rename/export/delete, and the entry to Settings.
    Settings is a normal pushed screen. Setup and recovery still sit above Home,
    so history and help stay reachable (the rest of UX-001).
  * **Composer.** One rounded field with a round Send button inside it that
    becomes Stop while Namu answers. Send/Stop keep their accessible names and
    48 px touch targets (DS-002).
  * **Messages.** The sent message appears at once as a pending bubble with a
    pulsing "Thinking…" mark; the draft itself is still cleared only by the
    durable commit (CHAT-001). Streaming text ends in a caret mark. Copy of a
    user message moved from a button under every bubble to long-press, with the
    same action exposed to assistive technology. Answer actions are compact
    icons; "N earlier answers" keeps its text.
  * **Empty chat.** Wordmark and title centred; the three starter prompts are a
    row of chips above the composer and still only insert editable text (S04).
  * **Settings.** Three cards — General (app language, answer language,
    appearance; each row shows its value and opens a choice list), Storage and
    data, Help and about (with the app version). Still no tuning controls, model
    selector or account (PRD-002).
* Implementation notes: the drawer is plain `Animated` + `PanResponder` (no
  gesture library joins the locked stack); `@react-navigation/bottom-tabs` was
  removed. Reduce Motion gives a static drawer and a static thinking mark.
* Open: Android visual check; Maestro flows were updated but have not been run
  on a device.
