# Engineering decisions log (v1)

Decisions that refine the PRD without changing its scope. Anything that would
change a threshold, the model, or scope needs a versioned PRD amendment
(IMP-002) instead of an entry here.

| # | Decision | Why | Requirement |
|---|---|---|---|
| D-01 | Structured native values cross the bridge as JSON strings validated by typed adapters. | One stable TurboModule surface on both platforms; malformed native data is rejected in one place. | ARC-003 |
| D-02 | Artifact ID = SHA-256 from the signed descriptor. | Deterministic, collision-free, never derived from server responses or user input. | DL-008 |
| D-03 | Descriptor parsing uses a purpose-built strict JSON parser on every platform plus 41 shared conformance vectors. | Platform JSON libraries silently keep the last duplicate key, which SIG-003 forbids. | SIG-002, SIG-003 |
| D-04 | The self-test is driven from JS in the foreground (`beginSelfTest` → engine → `activate`), with a native pending-activation marker. | llama.rn is a JS-driven runtime; the transfer service itself must run without JS. A crash during self-test quarantines the candidate on next launch. | DL-010…012 |
| D-05 | `send()` holds the engine ownership lock from lazy load through the terminal commit; `cancel()` bypasses it. | Activation/idle-unload can never interleave with a generation, while Stop is never queued behind the work it stops. | INF-006 |
| D-06 | Token budgeting uses binary search over the number of newest pairs with the engine's exact formatted count. | Exact (same template + tokenizer as generation) with O(log n) native calls. | CTX-002, CTX-003 |
| D-07 | Search keeps an `search_rows` rowid map beside the FTS5 table, with a delete trigger. | Index rows can be replaced by key and stay consistent under `ON DELETE CASCADE`, inside the same transaction as the content. | DB-004 |
| D-08 | Typographic apostrophes are folded to `'` in the index copy and the query only; diacritics are ignored for matching (`remove_diacritics 2`); hooked letters stay distinct. | "l’école" ≡ "l'école" ≡ "ecole" for search, while ƙ ≠ k. Stored/displayed text is never altered. | DB-005, LOC-002 |
| D-09 | Overflow menus and the response-language menu use a Namu dialog list (`ActionSheet`) instead of React Native Paper's `Menu`. | Every entry pairs icon + text with a 48 px target, focus returns to the opener, and it renders deterministically in tests. | DS-003, DS-005 |
| D-10 | Internal simulator/emulator builds use the scripted `FakeInferenceEngine`; it is unreachable from production UI and release builds. | DEV-001 (simulators are for functional UI journeys only), REL-001 (fixtures never become a second model). | DEV-001, PRD-002 |
| D-11 | Migration backup uses `VACUUM INTO`; restore re-creates the file with `VACUUM INTO` as well. | Consistent copy of a live WAL database without a filesystem API in the JS layer. | DB-006 |
| D-12 | Crash marker for native loads lives in the chat DB (`preferences.nativeLoadMarker`, `synchronous=FULL`). | Durable before the load starts; safe mode never auto-loads. | ERR-001 |
| D-13 | Icons are a subset *font* (47 glyphs, 10 KB) rather than an SVG dependency. | No extra native module; one consistent Material Symbols Rounded set. | DS-003 |
| D-14 | The model licence text is vendored mechanically by a release tool, with provenance digests, and awaits legal review. | S10 requires offline-readable notices; the text must be verbatim. | S10, PRD-007 |

## Known gaps and findings

1. **DM Sans lacks ƙ ɗ ɓ ƴ.** Hausa hooked letters fall back to the system
   font. Allowed by DS-001 ("plus system fallback") but visually mixed; Hausa
   reviewers should judge it. Changing the font needs a token revision.
2. **"128-token formatted prompt" is unreachable** with the locked template's
   mandatory preamble (see runtime-contract.md §2). Needs a PRD amendment.
3. **IME composition (A11Y-002).** Send is always an explicit action (button or
   hardware Ctrl/Cmd+Enter) and submits the text exactly as displayed. React
   Native exposes no composition state; a native `commitComposition` hook is
   the proposed follow-up if CJK-style IMEs show problems in device testing.
4. **Effective runtime parameters are not echoed by llama.rn** (runtime-contract
   §1); confirm through native logs on device.
5. **Android sharing has no completion signal**; the export is treated as
   shared once the chooser opened, and leftovers are swept after 24 h
   (SEC-005).
