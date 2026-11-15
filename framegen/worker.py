"""Offline SD-Turbo image stream. Receives synthetic rig frames, never captured YouTube images."""
import base64
import contextlib
import gc
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import traceback
import uuid

ROOT = Path(__file__).resolve().parents[1]
SIZE, FPS, MAX_FRAMES = 384, 12, 240
PROMPT = "A photorealistic adult person, front view, waist-up portrait, plain teal long sleeve shirt, hands visible, natural fingers, neutral gray studio background, soft even lighting"


def emit(value):
    print(json.dumps(value, allow_nan=False), flush=True)


def validate_request(message):
    if not isinstance(message, dict) or type(message.get("id")) is not int:
        raise ValueError("Invalid frame generation request.")
    frames = message.get("frames")
    if not isinstance(frames, list) or not 1 <= len(frames) <= MAX_FRAMES:
        raise ValueError("Use 1-240 synthetic input frames.")
    if any(not isinstance(frame, str) or len(frame) > 256_000 for frame in frames):
        raise ValueError("Input frame exceeds its size limit.")
    output = Path(message.get("output", "")).resolve()
    if output.parent != (ROOT / "output/companion").resolve() or output.suffix != ".webm":
        raise ValueError("Output must be a generated video in the companion cache.")
    try:
        if str(uuid.UUID(output.stem)) != output.stem:
            raise ValueError()
    except ValueError:
        raise ValueError("Invalid generated-video identifier.")
    return frames, output


def main():
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    source = Path(os.environ.get("FRAMEGEN_SOURCE_DIR", ROOT / "tmp/streamdiffusion-src"))
    sys.path.insert(0, str(source / "src"))
    try:
        with contextlib.redirect_stdout(sys.stderr):
            import numpy as np
            from PIL import Image
            import torch
            from diffusers import AutoencoderTiny, StableDiffusionPipeline
            from streamdiffusion import StreamDiffusion
            if not torch.cuda.is_available():
                raise RuntimeError("CUDA is required for image generation.")
            torch.set_num_threads(4)
            torch.backends.cuda.matmul.allow_tf32 = True
            vae = AutoencoderTiny.from_pretrained(os.environ.get("FRAMEGEN_VAE_DIR", ROOT / "models/taesd"), torch_dtype=torch.float16, local_files_only=True)
            pipe = StableDiffusionPipeline.from_pretrained(
                os.environ.get("FRAMEGEN_MODEL_DIR", ROOT / "models/sd-turbo"), vae=vae,
                torch_dtype=torch.float16, variant="fp16", local_files_only=True,
                safety_checker=None, feature_extractor=None,
            ).to("cuda")
            pipe.unet.to(memory_format=torch.channels_last)
            stream = StreamDiffusion(pipe, t_index_list=[22], width=SIZE, height=SIZE,
                                    torch_dtype=torch.float16, cfg_type="none", frame_buffer_size=1)
            stream.prepare(PROMPT, guidance_scale=1.0, seed=42)
            # The fixed appearance prompt is already encoded. Release its 650 MiB text encoder.
            stream.text_encoder = None
            pipe.text_encoder = None
            gc.collect()
            torch.cuda.empty_cache()
            ffmpeg = os.environ.get("FRAMEGEN_FFMPEG", "ffmpeg")
            subprocess.run([ffmpeg, "-version"], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=True, timeout=15)
        emit({"type": "ready", "size": SIZE, "fps": FPS})
    except Exception:
        traceback.print_exc(file=sys.stderr)
        emit({"type": "error", "error": "Image model could not load. Check local SD-Turbo/TAESD weights, CUDA, environment and FFmpeg."})
        return 1
    for line in sys.stdin:
        request_id = None
        output = None
        try:
            if len(line) > 24 * 1024 * 1024:
                raise ValueError("Frame request exceeds the size limit.")
            message = json.loads(line)
            request_id = message.get("id") if isinstance(message, dict) else None
            frames, output = validate_request(message)
            started = time.perf_counter()
            torch.cuda.reset_peak_memory_stats()
            jpeg_stream = io.BytesIO()
            with torch.inference_mode(), contextlib.redirect_stdout(sys.stderr):
                for encoded in frames:
                    data = base64.b64decode(encoded, validate=True)
                    with Image.open(io.BytesIO(data)) as image:
                        if image.size != (SIZE, SIZE) or image.format != "JPEG":
                            raise ValueError("Input must be a 384x384 synthetic JPEG frame.")
                        value = stream(image.convert("RGB"))
                    if value.shape != (1, 3, SIZE, SIZE) or not torch.isfinite(value).all().item():
                        raise ValueError("Image model returned invalid pixels.")
                    pixels = ((value[0].float().clamp(-1, 1) + 1) * 127.5).permute(1, 2, 0).cpu().numpy().round().astype(np.uint8)
                    Image.fromarray(pixels).save(jpeg_stream, format="JPEG", quality=90)
                    del value
            output.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "image2pipe",
                            "-framerate", str(FPS), "-c:v", "mjpeg", "-i", "pipe:0", "-c:v", "libvpx-vp9",
                            "-crf", "30", "-b:v", "0", "-pix_fmt", "yuv420p", str(output)],
                           input=jpeg_stream.getvalue(), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=True, timeout=60)
            if output.stat().st_size > 20 * 1024 * 1024:
                raise ValueError("Generated video exceeds the playback size limit.")
            emit({"id": request_id, "format": "generated-video", "mediaType": "video/webm", "fps": FPS,
                  "frameCount": len(frames), "duration": len(frames) / FPS, "size": SIZE,
                  "renderSeconds": round(time.perf_counter() - started, 3),
                  "peakVramMiB": round(torch.cuda.max_memory_allocated() / 1024**2), "accuracyReviewed": False})
        except Exception:
            traceback.print_exc(file=sys.stderr)
            if output is not None:
                output.unlink(missing_ok=True)
            emit({"id": request_id, "error": "Image generation failed. No clip or paid API was substituted; check framegen diagnostics."})
        finally:
            torch.cuda.empty_cache()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
