# Release tool (PRD section 5, MDL-003). Run from the repository root, only
# after the intended model use is authorized (PRD-007):
#
#   python3 -m venv .venv-model-release
#   .venv-model-release/bin/python -m pip install -r model-release/requirements.lock.txt
#   .venv-model-release/bin/python model-release/acquire.py
#
# Python is a release tool only; it is not part of the mobile app.
import hashlib
import json
import re
from pathlib import Path
from huggingface_hub import HfApi, hf_hub_download

repo = "CohereLabs/tiny-aya-global-GGUF"
filename = "tiny-aya-global-q4_k_m.gguf"
lock_path = Path("model-release/model.lock.json")
api = HfApi()

# Existing releases always reuse the locked revision.
old = json.loads(lock_path.read_text()) if lock_path.exists() else None
revision = old["revision"] if old else api.model_info(repo).sha
if not revision or not re.fullmatch(r"[0-9a-f]{40}", revision):
    raise RuntimeError("A full immutable upstream revision is required")
info = api.model_info(repo, revision=revision, files_metadata=True)
if info.sha != revision:
    raise RuntimeError("Upstream revision mismatch")
entry = next(s for s in info.siblings if s.rfilename == filename)
if entry.size is None or entry.lfs is None:
    raise RuntimeError("Exact upstream size/SHA-256 unavailable; do not release")
expected_bytes = entry.size
expected_sha = entry.lfs.sha256
if expected_bytes <= 0 or not re.fullmatch(r"[0-9a-f]{64}", expected_sha):
    raise RuntimeError("Invalid upstream size or SHA-256")

path = Path(hf_hub_download(
    repo_id=repo, filename=filename, revision=revision,
    local_dir="model-release/artifacts"
))
if path.stat().st_size != expected_bytes:
    raise RuntimeError("Downloaded size mismatch")
digest = hashlib.sha256()
with path.open("rb") as stream:
    for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
        digest.update(chunk)
if digest.hexdigest() != expected_sha:
    raise RuntimeError("Downloaded SHA-256 mismatch")
lock = {
    "schema": 1, "repo_id": repo, "revision": revision,
    "filename": filename, "bytes": expected_bytes,
    "sha256": expected_sha, "architecture": "cohere2",
    "quantization": "Q4_K_M"
}
if old is not None and old != lock:
    raise RuntimeError("Artifact metadata differs from existing lock")
lock_path.write_text(json.dumps(lock, indent=2) + "\n")
print(path)
