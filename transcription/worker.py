"""Persistent English CPU ASR. Audio is decoded in memory and never written to disk."""
import base64
import binascii
import io
import json
import os
from pathlib import Path
import sys
import time

MAX_BYTES = 5 * 1024 * 1024
MAX_SAMPLES = 30 * 16000
MIMES = {"audio/webm", "video/webm", "audio/wav", "audio/x-wav", "audio/ogg"}


def validate(message):
    if not isinstance(message, dict) or not isinstance(message.get("id"), (str, int)):
        raise ValueError("Invalid request")
    mime = str(message.get("mime", "")).split(";")[0].strip().lower()
    if mime not in MIMES:
        raise ValueError("Use a complete WebM, Ogg, or WAV audio clip")
    audio = message.get("audio")
    if not isinstance(audio, str) or len(audio) > ((MAX_BYTES + 2) // 3) * 4:
        raise ValueError("Audio exceeds 5 MiB")
    try:
        raw = base64.b64decode(audio, validate=True)
    except (binascii.Error, ValueError):
        raise ValueError("Invalid audio encoding") from None
    if not raw or len(raw) > MAX_BYTES:
        raise ValueError("Audio is empty or exceeds 5 MiB")
    return raw


def decode(raw):
    import av
    import numpy as np

    chunks, count = [], 0
    with av.open(io.BytesIO(raw)) as container:
        resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
        for frame in container.decode(audio=0):
            for converted in resampler.resample(frame):
                count += converted.samples
                if count > MAX_SAMPLES:
                    raise ValueError("Audio clip exceeds 30 seconds")
                chunks.append(converted.to_ndarray().reshape(-1))
        for converted in resampler.resample(None):
            count += converted.samples
            if count > MAX_SAMPLES:
                raise ValueError("Audio clip exceeds 30 seconds")
            chunks.append(converted.to_ndarray().reshape(-1))
    if not chunks:
        raise ValueError("No audio frames found")
    return np.concatenate(chunks).astype(np.float32) / 32768.0


def emit(value):
    print(json.dumps(value, ensure_ascii=True), flush=True)


def main():
    try:
        from faster_whisper import WhisperModel
        cache = Path(__file__).resolve().parents[1] / "output" / "asr-cache"
        model = WhisperModel(
            os.environ.get("ASR_MODEL", "tiny.en"), device="cpu", compute_type="int8",
            cpu_threads=min(4, os.cpu_count() or 2), download_root=str(cache),
        )
    except Exception:
        emit({"type": "error", "error": "ASR model could not load. Run the transcription setup and check model download connectivity."})
        return 1
    emit({"type": "ready", "model": os.environ.get("ASR_MODEL", "tiny.en")})
    # A complete independent recording is required per request. MediaRecorder timeslices alone are not independent WebM files.
    for line in sys.stdin:
        request_id = None
        try:
            if len(line) > 7 * 1024 * 1024:
                raise ValueError("Audio request too large")
            message = json.loads(line)
            request_id = message.get("id") if isinstance(message, dict) else None
            audio = decode(validate(message))
            started = time.perf_counter()
            segments, _ = model.transcribe(
                audio, language="en", beam_size=1, condition_on_previous_text=False,
                vad_filter=True, vad_parameters={"min_silence_duration_ms": 400},
            )
            text = " ".join(s.text.strip() for s in segments).strip()
            emit({"id": request_id, "text": text, "seconds": round(time.perf_counter() - started, 3)})
        except ValueError as error:
            emit({"id": request_id, "error": str(error)})
        except Exception:
            emit({"id": request_id, "error": "Could not decode or transcribe this audio clip"})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
