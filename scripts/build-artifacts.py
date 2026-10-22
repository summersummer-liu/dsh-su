#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Package dsh-su artifacts.

  dist/dsh-su-sketchup-<version>.rbz   installable SketchUp extension (Extension Manager)
  dist/dsh-su-<version>.zip            DSH plugin package (npm/file: install or manual copy)

Run from the plugin package root:  python scripts/build-artifacts.py
"""
import hashlib
import json
import zipfile
from pathlib import Path

PKG = Path(__file__).resolve().parent.parent
VERSION = json.loads((PKG / "package.json").read_text(encoding="utf-8"))["version"]
DIST = PKG / "dist"
DIST.mkdir(exist_ok=True)

RBZ = DIST / f"dsh-su-sketchup-{VERSION}.rbz"
ZIP = DIST / f"dsh-su-{VERSION}.zip"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


# --- SketchUp extension (.rbz is a zip with the loader + folder at its root) --
with zipfile.ZipFile(RBZ, "w", zipfile.ZIP_DEFLATED) as zf:
    zf.write(PKG / "sketchup" / "dsh_su_bridge.rb", "dsh_su_bridge.rb")
    for file in sorted((PKG / "sketchup" / "dsh_su_bridge").rglob("*")):
        if file.is_file():
            zf.write(file, Path("dsh_su_bridge") / file.relative_to(PKG / "sketchup" / "dsh_su_bridge"))

# --- DSH plugin package ------------------------------------------------------
INCLUDE = ["package.json", "index.js", "cordis.patch.yml", "README.md"]
INCLUDE_DIRS = ["lib", "sketchup", "skills", "scripts"]
with zipfile.ZipFile(ZIP, "w", zipfile.ZIP_DEFLATED) as zf:
    for name in INCLUDE:
        path = PKG / name
        if path.is_file():
            zf.write(path, name)
    for dirname in INCLUDE_DIRS:
        for file in sorted((PKG / dirname).rglob("*")):
            if file.is_file():
                zf.write(file, file.relative_to(PKG))

print(json.dumps({
    "version": VERSION,
    "rbz": {"path": str(RBZ), "bytes": RBZ.stat().st_size, "sha256": sha256(RBZ)},
    "pluginZip": {"path": str(ZIP), "bytes": ZIP.stat().st_size, "sha256": sha256(ZIP)},
}, indent=2))
