# Development trust bundle

`make-dev-bundle.mjs` signs a descriptor for any local GGUF with a throwaway
development key and installs the three bundled trust files
(`initial-descriptor.json`, `release-keys.json`, `known-bad.json`) into the
Android assets and the iOS bundle configuration directory. Internal builds
accept the fixture profile `architecture ∈ {cohere2, llama}`,
`quantization ∈ {Q4_K_M, Q8_0, F16, F32}`; release builds accept only
`cohere2` / `Q4_K_M` and refuse `dev-` keys.

```bash
node model-release/dev/make-dev-bundle.mjs --model model-release/artifacts/tiny-aya-global-q4_k_m.gguf
node tools/fault-server/server.mjs --root model-release/dev/out/serve --port 8787
```

Nothing in `model-release/dev/out/` is committed. The fixture model never
becomes a user-visible second model (REL-001).
