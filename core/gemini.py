"""Thin Gemini wrapper: cached client, model fallback, stream + batch modes."""

from __future__ import annotations

import threading
from typing import Generator

from google import genai
from google.genai import types

from config import GEMINI_API_KEY, MODEL_CANDIDATES

_client = genai.Client(api_key=GEMINI_API_KEY) if GEMINI_API_KEY else None
_working_model: str | None = None
_model_lock = threading.Lock()


def available() -> bool:
    return _client is not None


def _models() -> list[str]:
    with _model_lock:
        preferred = _working_model
    return [preferred] + [m for m in MODEL_CANDIDATES if m != preferred] if preferred else list(MODEL_CANDIDATES)


def _remember(model: str) -> None:
    global _working_model
    with _model_lock:
        _working_model = model


def _config(system: str | None, temperature: float, max_tokens: int | None):
    return types.GenerateContentConfig(
        system_instruction=system or None,
        temperature=temperature,
        max_output_tokens=max_tokens,
    )


def generate_text(
    prompt: str,
    system: str | None = None,
    temperature: float = 0.2,
    max_tokens: int | None = 2048,
) -> str:
    """Return a complete response, trying fallback models when needed."""
    if not _client:
        raise RuntimeError("GEMINI_API_KEY is not configured. Add it to .env and restart.")

    last_error: Exception | None = None
    for model in _models():
        try:
            response = _client.models.generate_content(
                model=model,
                contents=prompt,
                config=_config(system, temperature, max_tokens),
            )
            if response and response.text:
                _remember(model)
                return response.text.strip()
        except Exception as exc:  # noqa: BLE001 - fall back across models
            last_error = exc
    raise RuntimeError(f"All Gemini models failed. Last error: {last_error}")


def stream_text(
    prompt: str,
    system: str | None = None,
    temperature: float = 0.2,
    max_tokens: int | None = 4096,
) -> Generator[str, None, None]:
    """Yield response deltas as they arrive; falls back to a single response."""
    if not _client:
        raise RuntimeError("GEMINI_API_KEY is not configured. Add it to .env and restart.")

    last_error: Exception | None = None
    for model in _models():
        yielded = False
        try:
            for chunk in _client.models.generate_content_stream(
                model=model,
                contents=prompt,
                config=_config(system, temperature, max_tokens),
            ):
                if chunk.text:
                    yielded = True
                    yield chunk.text
            if yielded:
                _remember(model)
                return
        except Exception as exc:  # noqa: BLE001 - fall back across models
            last_error = exc
            if yielded:
                # Never restart from scratch after the client saw partial text.
                raise RuntimeError(f"Streaming interrupted: {exc}") from exc

    # Streaming may be blocked by a proxy/model; use a normal request instead.
    text = generate_text(prompt, system, temperature, max_tokens)
    if text:
        yield text
