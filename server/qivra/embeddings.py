"""Local text embeddings for semantic search, "Related items" and duplicate detection.

Runs on this machine with fastembed (Apache-2.0, ONNX Runtime, no GPU, no API key):
nothing is sent anywhere. The default model is multilingual (50+ languages, 384
dimensions), so an English question can find a Hindi or Kannada reel about the
same thing. Install with `pip install -r requirements-embeddings.txt`; the model
(~240 MB) downloads once into data/models on first use.

  QIVRA_LOCAL_EMBED_MODEL   fastembed model name (default below)
  QIVRA_LOCAL_EMBEDDINGS=0  turn local embeddings off
"""

from __future__ import annotations

import importlib.util
import logging
import os
import threading
from pathlib import Path

logger = logging.getLogger(__name__)

DEFAULT_MODEL = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
MAX_CHARS = 2000  # longer chunks are truncated; the model reads ~128-256 tokens anyway
MAX_BATCH = 256

_model = None
_model_name: str | None = None
_lock = threading.Lock()


def available() -> bool:
    if os.getenv("QIVRA_LOCAL_EMBEDDINGS", "1").strip() == "0":
        return False
    return importlib.util.find_spec("fastembed") is not None


def model_name() -> str:
    return os.getenv("QIVRA_LOCAL_EMBED_MODEL", "").strip() or DEFAULT_MODEL


def label() -> str:
    """Name shown to phones and stored with each vector (vectors from different models never mix)."""
    return f"local:{model_name().split('/')[-1]}"


def _cache_dir() -> Path:
    from .config import get_config
    d = get_config().data_dir / "models"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _load():
    global _model, _model_name
    with _lock:
        name = model_name()
        if _model is None or _model_name != name:
            from fastembed import TextEmbedding
            logger.info("Loading local embedding model %s", name)
            _model = TextEmbedding(name, cache_dir=str(_cache_dir()))
            _model_name = name
        return _model


def warm_up() -> None:
    """Load the model in the background so the first search is fast."""
    if not available():
        return
    def run():
        try:
            _load()
        except Exception as exc:  # download blocked, disk full…
            logger.warning("Local embedding model could not load (%s)", type(exc).__name__)
    threading.Thread(target=run, name="qivra-embed-warmup", daemon=True).start()


def embed(texts: list[str]) -> list[list[float]]:
    """Unit-length vectors, one per text, in order."""
    if not texts:
        return []
    model = _load()
    out = []
    for vec in model.embed([(t or " ")[:MAX_CHARS] for t in texts], batch_size=32):
        norm = float((vec ** 2).sum()) ** 0.5 or 1.0
        out.append([round(float(x) / norm, 6) for x in vec])
    return out
