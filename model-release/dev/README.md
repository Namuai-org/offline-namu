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

Options: `--out-only` writes only the output directory and leaves
`android/` and `ios/` untouched (tests, fault-server-only work); `--out <dir>`
replaces the default `model-release/dev/out`.

Without any model at hand, `make-fixture-gguf.mjs` fabricates a small,
structurally valid GGUF (correct header, metadata with `general.architecture`,
zero tensors, deterministic filler). It exercises signing, transfer, hashing
and the structural GGUF check, and lets CI build the apps; it is **not
loadable** by the inference runtime.

```bash
node model-release/dev/make-fixture-gguf.mjs --out /tmp/fixture.gguf --payload-bytes 52428800
node model-release/dev/make-dev-bundle.mjs --model /tmp/fixture.gguf --quantization F32
```

Nothing in `model-release/dev/out/` is committed. The fixture model never
becomes a user-visible second model (REL-001).
