"""Lazy model residency and serialized generation.

Models load on first use (or /warmup) and stay resident for the life of the
process. A single asyncio lock serializes generation: there is one Metal GPU
and MLX generation is not concurrency-safe.
"""

import asyncio
import logging
import threading

import numpy as np

from .registry import MODELS
from .wavio import wav_bytes

log = logging.getLogger("tts-server")

_models: dict[str, object] = {}
_loading: set[str] = set()
_load_locks: dict[str, threading.Lock] = {mid: threading.Lock() for mid in MODELS}
_gen_lock = asyncio.Lock()


def loaded_ids() -> list[str]:
    return sorted(_models)


def loading_ids() -> list[str]:
    return sorted(_loading)


def _ensure_loaded(model_id: str):
    if model_id in _models:
        return _models[model_id]
    with _load_locks[model_id]:
        if model_id in _models:
            return _models[model_id]
        from mlx_audio.tts.utils import load_model  # slow import, keep off startup

        _loading.add(model_id)
        try:
            log.info("loading model %s (%s)…", model_id, MODELS[model_id].repo)
            model = load_model(MODELS[model_id].repo)
            _models[model_id] = model
            log.info("model %s ready", model_id)
            return model
        finally:
            _loading.discard(model_id)


async def warm(model_id: str) -> None:
    """Load a model if it isn't resident. Idempotent. Serialized behind the
    generation lock so loading never shares the GPU with active generation."""
    if model_id in _models:
        return
    _loading.add(model_id)  # visible in /health while queued behind generation
    try:
        async with _gen_lock:
            await asyncio.to_thread(_ensure_loaded, model_id)
    finally:
        _loading.discard(model_id)


async def synth(model_id: str, text: str, voice: str, speed: float) -> tuple[bytes, int, float]:
    """Synthesize one chunk. Returns (wav_bytes, sample_rate, applied_speed)."""
    spec = MODELS[model_id]
    async with _gen_lock:
        model = await asyncio.to_thread(_ensure_loaded, model_id)

        kwargs = dict(spec.generate_kwargs)
        kwargs["text"] = text
        kwargs["voice"] = voice
        applied = 1.0
        if spec.supports_speed:
            kwargs["speed"] = speed
            applied = speed

        def run() -> tuple[np.ndarray, int]:
            segments = []
            sample_rate = None
            for r in model.generate(**kwargs):
                segments.append(np.asarray(r.audio, dtype=np.float32))
                sample_rate = getattr(r, "sample_rate", None) or sample_rate
            if not segments:
                raise RuntimeError("model produced no audio")
            audio = np.concatenate(segments) if len(segments) > 1 else segments[0]
            return audio, sample_rate or getattr(model, "sample_rate", 24000)

        audio, sample_rate = await asyncio.to_thread(run)
        return wav_bytes(audio, sample_rate), sample_rate, applied
