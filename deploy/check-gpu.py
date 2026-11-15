"""Probe the selected CUDA device; stdout is safe to append to deploy/.env."""
import sys


def select_dtype(torch):
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is unavailable. Check the driver and NVIDIA Container Toolkit.")
    value = torch.ones((16, 16), device="cuda", dtype=torch.float32)
    if not torch.isfinite(value @ value).all().item():
        raise RuntimeError("CUDA float32 computation returned invalid values.")
    torch.cuda.synchronize()
    if torch.cuda.is_bf16_supported():
        try:
            half = value.to(torch.bfloat16)
            valid = torch.isfinite(half @ half).all().item()
            torch.cuda.synchronize()
            if valid:
                return "bf16"
        except RuntimeError:
            pass
    return "float32"


def main():
    import torch
    dtype = select_dtype(torch)
    for index in range(torch.cuda.device_count()):
        device = torch.cuda.get_device_properties(index)
        print(f"GPU {index}: {device.name}; VRAM {device.total_memory / 1024**3:.1f} GiB", file=sys.stderr)
    print(f"Selected motion precision: {dtype}; current workers use GPU 0.", file=sys.stderr)
    print(f"MOTION_DTYPE={dtype}")


if __name__ == "__main__":
    main()
