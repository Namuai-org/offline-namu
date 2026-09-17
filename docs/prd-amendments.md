# PRD amendments (IMP-002)

Documentation edits, thresholds and scope changes use versioned amendments.
**Nothing below is approved.** These are proposals raised by implementation
findings; until the project owner approves one, the PRD text stands.

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
