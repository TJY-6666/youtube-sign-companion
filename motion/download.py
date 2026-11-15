"""Explicit setup action; never called by the app or container startup."""
import argparse
from pathlib import Path

MODEL_REVISION = "bf0ed2f3bf43b8a1d9def85ca8ab51bef5a10b06"


def main():
    parser = argparse.ArgumentParser(description="Download about 7.3 GB of motion weights plus tokenizer files; no purchase is made.")
    parser.add_argument("--accept-large-download", action="store_true", required=True)
    parser.add_argument("--directory", type=Path, default=Path("/models"))
    args = parser.parse_args()
    from huggingface_hub import snapshot_download
    snapshot_download("Ivystream/RoboSTAR", revision=MODEL_REVISION,
                      allow_patterns=["generator/*", "tokenizer/*", "stats/*", "retrieval/*", "README.md", "manifest.json"],
                      local_dir=args.directory / "robostar")
    snapshot_download("google/mt5-large", allow_patterns=["config.json", "tokenizer*", "spiece.model", "special_tokens_map.json", "added_tokens.json"],
                      local_dir=args.directory / "mt5")
    print("Downloaded motion checkpoint and tokenizer/config files. No mT5 backbone weights requested.")


if __name__ == "__main__":
    main()
