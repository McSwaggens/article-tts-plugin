"""Model registry: which TTS models the server offers and their voices.

Voice lists are hardcoded (verified against the model cards / model configs at
implementation time) because there is no uniform enumeration API across
mlx-audio model families before a model is loaded.
"""

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Voice:
    id: str
    label: str


@dataclass(frozen=True)
class ModelSpec:
    id: str
    repo: str
    supports_speed: bool
    voices: tuple[Voice, ...]
    default_voice: str
    # Extra kwargs passed to model.generate() on every request.
    generate_kwargs: dict = field(default_factory=dict)


MODELS: dict[str, ModelSpec] = {
    "qwen3": ModelSpec(
        id="qwen3",
        repo="Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
        # generate() accepts speed= but measured output duration doesn't track it;
        # the extension applies playbackRate instead.
        supports_speed=False,
        # Verified via model.get_supported_speakers() on the downloaded checkpoint.
        voices=(
            Voice("aiden", "Aiden (US male)"),
            Voice("ryan", "Ryan (male)"),
            Voice("serena", "Serena (female)"),
            Voice("vivian", "Vivian (female)"),
            Voice("uncle_fu", "Uncle Fu (mature male)"),
            Voice("dylan", "Dylan (male, Beijing)"),
            Voice("eric", "Eric (male, Sichuan)"),
            Voice("ono_anna", "Anna (female, Japanese)"),
            Voice("sohee", "Sohee (female, Korean)"),
        ),
        default_voice="aiden",
        generate_kwargs={"lang_code": "auto", "max_tokens": 4096},
    ),
    "kokoro": ModelSpec(
        id="kokoro",
        repo="mlx-community/Kokoro-82M-bf16",
        supports_speed=True,
        voices=(
            Voice("af_heart", "Heart (US female)"),
            Voice("af_bella", "Bella (US female)"),
            Voice("af_nicole", "Nicole (US female, soft)"),
            Voice("af_sky", "Sky (US female)"),
            Voice("am_adam", "Adam (US male)"),
            Voice("am_michael", "Michael (US male)"),
            Voice("bf_emma", "Emma (UK female)"),
            Voice("bf_isabella", "Isabella (UK female)"),
            Voice("bm_george", "George (UK male)"),
            Voice("bm_lewis", "Lewis (UK male)"),
        ),
        default_voice="af_heart",
        generate_kwargs={"lang_code": "a"},
    ),
}

DEFAULT_MODEL = "qwen3"


def get_spec(model_id: str) -> ModelSpec | None:
    return MODELS.get(model_id)


def voice_ids(spec: ModelSpec) -> set[str]:
    return {v.id for v in spec.voices}
