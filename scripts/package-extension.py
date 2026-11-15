"""Distribute only extension runtime files; never include local connection tokens."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json

root = Path(__file__).resolve().parents[1]
source = root / "extension"
destination = root / "output/youtube-sign-companion-extension.zip"
destination.parent.mkdir(exist_ok=True)
files = [path for path in source.rglob("*") if path.is_file()
         and path.name not in ("connection.local.json", "demo.js", "phrases.js")
         and not any(part in ("demo", "phrases") for part in path.relative_to(source).parts) and not path.name.endswith(".test.mjs")
         and (path.suffix in (".js", ".json", ".html", ".css", ".glb") or path.name == "LICENSE")]
with ZipFile(destination, "w", ZIP_DEFLATED) as archive:
    for path in sorted(files):
        archive.write(path, path.relative_to(source))
with ZipFile(destination) as archive:
    assert "manifest.json" in archive.namelist()
    manifest = json.loads(archive.read("manifest.json"))
    assert manifest["content_scripts"][-1]["js"] == ["captions.js", "content.js"]
    assert all("phrases" not in name and "/demo/" not in name and name != "demo.js" for name in archive.namelist())
    assert "avatar/vendor/LICENSE" in archive.namelist()
    assert all(name in archive.namelist() for name in ("avatar/assets/left.glb", "avatar/assets/right.glb", "avatar/assets/LICENSE"))
    assert all("connection.local" not in name and ".env" not in name for name in archive.namelist())
    # Check actual local credentials without printing them or putting them in the package.
    env_file = root / ".env.local"
    if env_file.exists():
        secrets = [line.split("=", 1)[1].strip().strip("\"'").encode()
                   for line in env_file.read_text(encoding="utf-8-sig").splitlines()
                   if line.startswith(("APP_TOKEN=", "SIGNSTREAM_PUBLISHABLE_KEY=", "SIGNSTREAM_SECRET_KEY="))]
        assert all(secret not in archive.read(name) for name in archive.namelist() for secret in secrets if len(secret) > 12), "Private configuration detected in package"
print(f"Packaged {len(files)} runtime files: {destination}")
