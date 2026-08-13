#!/usr/bin/env python3
"""Private stdin/stdout bridge to the sibling local embeddings harness."""

from __future__ import annotations

import json
import sys
from pathlib import Path


def main() -> int:
    request = json.load(sys.stdin)
    embeddings_root = Path(request["embeddings_root"]).resolve()
    sys.path.insert(0, str(embeddings_root / "src"))
    from wh40kdc_embeddings.embed import embed_texts

    vectors = embed_texts(
        request["texts"],
        model_name=request["model"],
        cache_path=embeddings_root / "_embeddings" / "cache.npz",
    )
    json.dump({"vectors": vectors.tolist()}, sys.stdout, separators=(",", ":"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
