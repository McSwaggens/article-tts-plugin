"""FastAPI app exposing the local TTS engine on 127.0.0.1:8765."""

import asyncio
import logging

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field

from . import engine
from .registry import DEFAULT_MODEL, MODELS, get_spec, voice_ids

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("tts-server")

HOST = "127.0.0.1"
PORT = 8765

app = FastAPI(title="tts-server")
# The server only binds loopback; permissive CORS just removes extension-origin friction.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Applied-Speed", "X-Sample-Rate"],
)


class WarmupBody(BaseModel):
    model: str


class SpeakBody(BaseModel):
    text: str
    model: str = DEFAULT_MODEL
    voice: str = ""
    speed: float = Field(default=1.0, ge=0.5, le=3.0)


@app.get("/health")
def health():
    return {"status": "ok", "loaded": engine.loaded_ids(), "loading": engine.loading_ids()}


@app.get("/voices")
def voices():
    return {
        "default_model": DEFAULT_MODEL,
        "models": [
            {
                "id": spec.id,
                "repo": spec.repo,
                "supports_speed": spec.supports_speed,
                "default_voice": spec.default_voice,
                "voices": [{"id": v.id, "label": v.label} for v in spec.voices],
            }
            for spec in MODELS.values()
        ],
    }


@app.post("/warmup", status_code=202)
async def warmup(body: WarmupBody):
    if get_spec(body.model) is None:
        raise HTTPException(400, f"unknown model '{body.model}'")
    asyncio.get_running_loop().create_task(engine.warm(body.model))
    return {"loading": body.model not in engine.loaded_ids()}


@app.post("/speak")
async def speak(body: SpeakBody):
    spec = get_spec(body.model)
    if spec is None:
        raise HTTPException(400, f"unknown model '{body.model}'")
    text = body.text.strip()
    if not text:
        raise HTTPException(400, "empty text")
    if len(text) > 2000:
        raise HTTPException(400, "text too long (max 2000 chars per request)")
    voice = body.voice or spec.default_voice
    if voice not in voice_ids(spec):
        raise HTTPException(400, f"unknown voice '{voice}' for model '{spec.id}'")

    try:
        wav, sample_rate, applied = await engine.synth(spec.id, text, voice, body.speed)
    except Exception:
        log.exception("synthesis failed (model=%s voice=%s len=%d)", spec.id, voice, len(text))
        raise HTTPException(500, "synthesis failed")

    return Response(
        content=wav,
        media_type="audio/wav",
        headers={"X-Applied-Speed": str(applied), "X-Sample-Rate": str(sample_rate)},
    )


def run():
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
