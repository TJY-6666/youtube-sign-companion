"""Resident RoboSTAR inference. Runtime is offline; setup downloads are explicit."""
import contextlib
import json
import os
from pathlib import Path
import sys
import time
import traceback
import faulthandler


def emit(value):
    print(json.dumps(value, allow_nan=False), flush=True)


def request_text(message):
    text = message.get("text") if isinstance(message, dict) else None
    if not isinstance(text, str) or not text.strip() or len(text) > 300 or len(text.split()) > 40:
        raise ValueError("Use 1-40 words and at most 300 characters per motion request.")
    return text.strip()


def main():
    if os.environ.get("MOTION_TRACE") == "1":
        faulthandler.enable(file=sys.stderr, all_threads=True)
        faulthandler.dump_traceback_later(30, repeat=True, file=sys.stderr)
    model_dir = Path(os.environ.get("MOTION_MODEL_DIR", "models/robostar"))
    base_dir = Path(os.environ.get("MOTION_BASE_DIR", "models/mt5"))
    if not all((model_dir / part).is_dir() for part in ("generator", "tokenizer", "stats")) or not base_dir.is_dir():
        emit({"type": "error", "error": "Motion weights or base tokenizer are missing. Runtime will not download them automatically."})
        return 1
    source = os.environ.get("MOTION_SOURCE_DIR")
    if source:
        sys.path.insert(0, str(Path(source).resolve()))
    try:
        with contextlib.redirect_stdout(sys.stderr):
            import numpy as np
            import torch
            torch.set_num_threads(min(4, os.cpu_count() or 2))
            torch.manual_seed(20260703)
            from robostar.representation import denormalize_motion
            from loading import load_models
            from prompts import load_dictionary, prepare_prompt
            from hand_pose import load_hand_mean, prepare_motion, POSE_PROFILES
            pose_profile = os.environ.get('MOTION_POSE_PROFILE', 'smplx-offsets')
            if pose_profile not in POSE_PROFILES:
                raise ValueError('Unknown MOTION_POSE_PROFILE.')
            hand_mean = load_hand_mean(os.environ.get('MOTION_SMPLX_MODEL', model_dir.parent / 'smplx/SMPLX_NEUTRAL.npz')) if pose_profile == 'smplx-offsets' else None
            if not torch.cuda.is_available():
                raise RuntimeError("A CUDA GPU is required for this deployment configuration.")
            dtype = os.environ.get("MOTION_DTYPE", "bf16")
            if dtype not in ("bf16", "float32"):
                raise ValueError("Unsupported MOTION_DTYPE")
            if dtype == "bf16" and not torch.cuda.is_bf16_supported():
                raise RuntimeError("GPU does not support bfloat16.")
            if os.environ.get("MOTION_TRACE") == "1":
                faulthandler.dump_traceback_later(15, repeat=True, file=sys.stderr)
            generator, vocab, tokenizer = load_models(model_dir, base_dir, torch.bfloat16 if dtype == "bf16" else torch.float32)
            dictionary = load_dictionary(model_dir)
            print(f'Sign-token dictionary: {len(dictionary)} entries.', file=sys.stderr, flush=True)
            mean = np.load(model_dir / "stats/mean133.npy", allow_pickle=False).astype(np.float32)
            std = np.load(model_dir / "stats/std133.npy", allow_pickle=False).astype(np.float32)
            if mean.shape != (133,) or std.shape != (133,):
                raise ValueError("Motion normalization statistics are invalid")
    except (ValueError, FileNotFoundError) as error:
        traceback.print_exc(file=sys.stderr)
        emit({"type": "error", "error": str(error)})
        return 1
    except Exception:
        traceback.print_exc(file=sys.stderr)
        emit({"type": "error", "error": "Motion model could not load. Check CUDA, dependencies, memory and local weight paths; see the smoke command for diagnostics."})
        return 1
    torch.cuda.empty_cache()
    emit({"type": "ready", "model": "RoboSTAR", "format": "motion133", "poseProfile": pose_profile})
    if os.environ.get("MOTION_TRACE") == "1":
        faulthandler.cancel_dump_traceback_later()
    for line in sys.stdin:
        request_id = None
        try:
            if len(line) > 8192:
                raise ValueError("Motion request is too large")
            message = json.loads(line)
            request_id = message.get("id") if isinstance(message, dict) else None
            text = request_text(message)
            prompt, keywords = prepare_prompt(text, vocab, dictionary)
            # Never silently truncate the source text.
            if len(vocab.tokenizer.encode(prompt)) > generator.cfg.max_source_length:
                raise ValueError("Split the transcript into a shorter phrase; source tokens exceed model context.")
            started = time.perf_counter()
            torch.cuda.reset_peak_memory_stats()
            with contextlib.redirect_stdout(sys.stderr), torch.inference_mode():
                encoded = vocab.encode_text([prompt], generator.cfg.max_source_length)
                generated = generator.generate(encoded["input_ids"].to("cuda"), encoded["attention_mask"].to("cuda"), do_sample=False)
                length = int(generated["full_lengths"][0].item())
                codes = {part: generated["final_codes"][part][0:1, :length] for part in ("body", "left", "right")}
                normalized = tokenizer.decode(codes)[0].float().cpu().numpy().astype(np.float32)
                motion = denormalize_motion(normalized, mean, std)
            if motion.ndim != 2 or motion.shape[1] != 133 or not 1 <= len(motion) <= 400 or not np.isfinite(motion).all() or np.abs(motion).max() > 100:
                raise ValueError("Model returned invalid motion; no placeholder was substituted.")
            motion = prepare_motion(motion, pose_profile, hand_mean)
            emit({"id": request_id, "format": "motion133", "fps": 20, "frames": motion.tolist(),
                  "handPose": "smplx-absolute",
                  "poseProfile": pose_profile, "sourceConventionVerified": False,
                  "model": "RoboSTAR", "language": "ASL", "text": text,
                  "promptMode": "official" if dictionary else "plain", "retrievalUsed": bool(keywords), "retrievedKeywords": keywords,
                  "seconds": round(time.perf_counter() - started, 3),
                  "peakVramMiB": round(torch.cuda.max_memory_allocated() / 1024**2),
                  "reservedVramMiB": round(torch.cuda.max_memory_reserved() / 1024**2),
                  "accuracyReviewed": False})
            del generated, codes, encoded
        except ValueError as error:
            traceback.print_exc(file=sys.stderr)
            emit({"id": request_id, "error": str(error)})
        except Exception:
            traceback.print_exc(file=sys.stderr)
            emit({"id": request_id, "error": "Motion inference failed. No automatic model retry or placeholder motion was used."})
        finally:
            # Share the 6 GB device with the serial image worker instead of retaining unused blocks.
            torch.cuda.empty_cache()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
