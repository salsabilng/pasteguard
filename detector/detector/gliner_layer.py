"""Fuzzy layer: multilingual GLiNER NER for person, location, and address
(addresses are emitted as LOCATION). Generic role nouns are demoted via
competing suppressor labels rather than a per-language denylist.

Each label has its own confidence floor (PER_LABEL_FLOOR). The request
`score_threshold` only raises the tunable labels (person, location, address).
"""

from __future__ import annotations

import os
import re
import threading
from typing import Any

from .entities import LOCATION, PERSON, Span

DEFAULT_MODEL = "urchade/gliner_multi_pii-v1"


def _floor(label: str, default: float) -> float:
    return float(os.environ.get(f"DETECTOR_FLOOR_{label.upper()}", default))


# Per-label confidence floors (calibrated against the accuracy benchmark;
# overridable via env, e.g. DETECTOR_FLOOR_LOCATION=0.6). Role nouns are demoted
# by the suppressor labels (below), not by this floor.
PER_LABEL_FLOOR = {
    "person": _floor("person", 0.95),
    "location": _floor("location", 0.80),
    # A dedicated "address" label recovers full street addresses that a bare
    # "location" reading misses; emitted as LOCATION (see _LABEL_TO_TYPE).
    "address": _floor("address", 0.80),
}
# Labels for GLiNER prediction.
# Default: person/location detection for the urchade/gliner_multi_pii-v1 model
# Edge model (knowledgator/gliner-pii-edge-v1.0) uses different labels.
# Set DETECTOR_LABELS env var to override (comma-separated).
_DEFAULT_LABELS = ["person", "location", "address"]
_DEFAULT_SUPPRESS = ["customer", "role"]
_DEFAULT_LABEL_TO_TYPE = {
    "person": PERSON,
    "location": LOCATION,
    "address": LOCATION,
}

# Edge model labels (knowledgator/gliner-pii-edge-v1.0)
_EDGE_LABELS = ["name", "email address", "phone number", "ip address",
                "location address", "location city", "location country"]
_EDGE_SUPPRESS = []
_EDGE_LABEL_TO_TYPE = {
    "name": PERSON,
    "location address": LOCATION,
    "location city": LOCATION,
    "location country": LOCATION,
    "location street": LOCATION,
}

def _detect_model_type() -> str:
    """Detect model type from DETECTOR_MODEL env var."""
    model_name = os.environ.get("DETECTOR_MODEL", "").lower()
    if "edge" in model_name or "knowledgator" in model_name:
        return "edge"
    return "default"

_model_type = _detect_model_type()

# Use model-specific labels unless DETECTOR_LABELS is set
_custom_labels = os.environ.get("DETECTOR_LABELS", "")
if _custom_labels:
    _PREDICT_LABELS = [l.strip() for l in _custom_labels.split(",") if l.strip()]
    _LABEL_TO_TYPE = {l: PERSON for l in _PREDICT_LABELS}  # Fallback: all as PERSON
    _SUPPRESS_LABELS = []
elif _model_type == "edge":
    _PREDICT_LABELS = _EDGE_LABELS
    _LABEL_TO_TYPE = _EDGE_LABEL_TO_TYPE
    _SUPPRESS_LABELS = _EDGE_SUPPRESS
else:
    _PREDICT_LABELS = _DEFAULT_LABELS + _DEFAULT_SUPPRESS
    _LABEL_TO_TYPE = _DEFAULT_LABEL_TO_TYPE
    _SUPPRESS_LABELS = _DEFAULT_SUPPRESS

# Labels the request score_threshold may raise (high-volume, deployment-tunable).
_TUNABLE = set(_LABEL_TO_TYPE.keys()) - {"address"}
# Capture candidates below every floor so per-label filtering has them.
_PREDICT_FLOOR = min(PER_LABEL_FLOOR.values()) - 0.1

# GLiNER truncates input past its word-token limit (~384), so long text would
# drop PII past the cut. Split into overlapping windows; the splitter mirrors
# GLiNER's WhitespaceTokenSplitter so window sizes match.
_TOKEN_RE = re.compile(r"\w+(?:[-_]\w+)*|\S")
_MAX_TOKENS = int(os.environ.get("DETECTOR_MAX_TOKENS", "384"))
_WINDOW = max(64, _MAX_TOKENS - 64)  # headroom under the hard limit
_OVERLAP = 64  # >= longest expected entity, so boundary-straddling spans survive


def _windows(text: str):
    """Yield (char_offset, subtext) windows. One window for short text; for long
    text, overlapping windows of <= _WINDOW word-tokens."""
    toks = [(m.start(), m.end()) for m in _TOKEN_RE.finditer(text)]
    if len(toks) <= _MAX_TOKENS:
        yield 0, text
        return
    step = max(1, _WINDOW - _OVERLAP)
    i = 0
    while i < len(toks):
        window = toks[i : i + _WINDOW]
        cstart, cend = window[0][0], window[-1][1]
        yield cstart, text[cstart:cend]
        if i + _WINDOW >= len(toks):
            break
        i += step


# GLiNER ships no type stubs, so the loaded model is untyped (Any).
_model: Any = None
_lock = threading.Lock()
# Torch inference is not guaranteed thread-safe; serialize concurrent /analyze calls.
_infer_lock = threading.Lock()


def _model_name() -> str:
    return (
        os.environ.get("DETECTOR_MODEL_PATH") or os.environ.get("DETECTOR_MODEL") or DEFAULT_MODEL
    )


def _quantize() -> bool:
    """Return True if FP16 quantization should be used (halves memory)."""
    return os.environ.get("DETECTOR_FP16", "1").lower() in ("1", "true", "yes")


def load_model() -> None:
    """Load the model once. Safe to call at startup or lazily.

    Tries to use FP16 precision (50% memory reduction) if DETECTOR_FP16=1.
    Falls back to default precision if the installed GLiNER version does not
    support the dtype parameter (older versions used quantize=True).
    """
    global _model
    if _model is not None:
        return
    with _lock:
        if _model is not None:
            return
        from gliner import GLiNER

        use_fp16 = _quantize()

        # Try new API first (dtype parameter), fall back to old (quantize=True)
        # for compatibility with older GLiNER versions.
        try:
            if use_fp16:
                print("[DETECTOR] Loading model with FP16 precision (50% memory reduction)")
                _model = GLiNER.from_pretrained(_model_name(), dtype="fp16")
                print("[DETECTOR] Model loaded with FP16 precision")
            else:
                _model = GLiNER.from_pretrained(_model_name())
        except (TypeError, ValueError) as e:
            if use_fp16:
                print(f"[DETECTOR] FP16 not supported, falling back to default precision: {e}")
                _model = GLiNER.from_pretrained(_model_name())
            else:
                raise


def detect_gliner(text: str, score_threshold: float = 0.0) -> list[Span]:
    if not text:
        return []
    load_model()

    # If GLiNER is disabled, return empty (deterministic-only mode)
    if _model is None:
        return []
    n = len(text)
    # Run each window, shift spans back to absolute offsets, dedupe overlaps
    # (same span+label) keeping the max score.
    best: dict[tuple[int, int, str], float] = {}
    with _infer_lock:
        for offset, sub in _windows(text):
            for ent in _model.predict_entities(
                sub, _PREDICT_LABELS, threshold=max(0.0, _PREDICT_FLOOR)
            ):
                key = (offset + int(ent["start"]), offset + int(ent["end"]), ent["label"])
                score = float(ent["score"])
                if score > best.get(key, -1.0):
                    best[key] = score

    # Highest suppressor score per span: if a "customer"/"role" reading of the
    # exact same span outscores its entity reading, it is a role noun, not PII.
    suppressor: dict[tuple[int, int], float] = {}
    for (start, end, label), score in best.items():
        if label in _SUPPRESS_LABELS and score > suppressor.get((start, end), -1.0):
            suppressor[start, end] = score

    out: list[Span] = []
    for (start, end, label), score in best.items():
        if label in _SUPPRESS_LABELS:
            continue
        # label is always one of _LABELS (== _LABEL_TO_TYPE keys), so a direct
        # lookup is safe.
        etype = _LABEL_TO_TYPE[label]
        floor = PER_LABEL_FLOOR[label]
        if label in _TUNABLE:
            floor = max(floor, score_threshold)
        if score < floor:
            continue
        # A stronger role-noun reading of the same span wins (drops the entity).
        if score < suppressor.get((start, end), -1.0):
            continue
        # Drop out-of-bounds spans from tokenization bugs (would mask wrong text).
        if not 0 <= start < end <= n:
            continue
        out.append(Span(etype, start, end, score))
    return out
