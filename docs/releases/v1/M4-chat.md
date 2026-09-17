# M4 — Chat behaviour

**Built:** `ChatSessionController` (application-scoped, one context, one
generation), `EngineOwnership` lock with out-of-band cancel, prompt budgeting,
50 ms UI publication, 1 s / 1 KiB checkpoints, exactly-once terminal commit,
retry and attempt selection, idle unload (120 s), background / memory /
thermal handling with the 30 s recovery rule, safe mode after a native-load
crash marker, `ModelInstallController` (self-test and activation).

**Verified with the scripted engine (Jest):**

| PRD test | Suite | Result basis |
|---|---|---|
| T14 rapid Send twice / Stop twice | `domain/chatSessionController` | single generation, one cancel, one terminal event |
| T15 cancel in prefill and decode; CANCEL_TIMEOUT | same | context never freed while running; `quiesce()` returns false instead of hanging |
| T16 kill while streaming | same | user message kept, checkpoint marked interrupted |
| T17 sentinel isolation | same | sentinel absent from the other conversation's prompt; session reset before every generation; weights loaded once |
| T18 retry then next turn | same + `data/chatRepository` | exactly one selected attempt in context |
| T19 huge paste / budget overflow | same + `ui/chatJourney` | refused, draft kept, never truncated |
| T11 update while answering | `domain/modelInstall` | staged only; activation on explicit action; old context released before the candidate loads |

**Open (the milestone gate):** T14–T19 "passed on both platforms" requires the
real runtime on physical devices. In particular the real adapter's cancel
acknowledgement, `clearCache` session reset and token-count parity
(`prompt.count.mismatch` diagnostic) have never executed.
