# M8 — Release

**Not started.** Owner actions that no engineer can perform from a
workstation:

- [ ] Written evidence of rights covering Namu's intended use and
      redistribution of Tiny Aya Global (PRD-007). The upstream licence is
      CC-BY-NC 4.0 with an acceptable-use addendum.
- [ ] Register `org.namuai.offline` in the Play and App Store accounts (STK-004).
- [ ] Generate the production Ed25519 signing key in the protected release
      environment (`docs/runbooks/signing-keys.md`).
- [ ] Provision staging and production distribution (`infra/`), choose the TLS
      option in `docs/prd-amendments.md` PA-002.
- [ ] Run `acquire.py`, commit `model.lock.json`, publish per
      `docs/runbooks/model-publication.md`.
- [ ] Verify and configure the support address (S09).
- [ ] Store disclosures, reviewer instructions, internal track, 20-user
      consented pilot, staged rollout (REL-004, REL-005).
- [ ] REL-003 build record (`tools/release/build-record.mjs`) from a clean
      checkout with `npm ci`.
