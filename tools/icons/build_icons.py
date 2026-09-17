"""Release tool: derive platform launcher icons from the approved Namu icon.

Inputs are rasterizations of the approved brand SVGs (namu-icon-on-ink.svg and
namu-icon-transparent-light.svg). Nothing is redrawn: this script only resizes,
removes the alpha channel for the App Store icon, and masks the legacy round
Android icon.
Usage: build_icons.py <icon-1024.png> <foreground-1024.png>
"""
import json
import sys
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
INK = (0x1C, 0x14, 0x10)
square = Image.open(sys.argv[1]).convert("RGB")
fg = Image.open(sys.argv[2]).convert("RGBA")

# iOS
ios_dir = ROOT / "ios/Namu/Images.xcassets/AppIcon.appiconset"
contents = json.loads((ios_dir / "Contents.json").read_text())
for image in contents["images"]:
    size = float(image["size"].split("x")[0])
    scale = int(image["scale"][0])
    px = int(round(size * scale))
    name = f"icon-{image['size'].split('x')[0]}@{scale}x.png"
    square.resize((px, px), Image.LANCZOS).save(ios_dir / name)
    image["filename"] = name
(ios_dir / "Contents.json").write_text(json.dumps(contents, indent=2) + "\n")

# Android legacy + adaptive
res = ROOT / "android/app/src/main/res"
for density, px in {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}.items():
    out = res / f"mipmap-{density}"
    out.mkdir(parents=True, exist_ok=True)
    icon = square.resize((px, px), Image.LANCZOS)
    icon.save(out / "ic_launcher.png")
    mask = Image.new("L", (px * 4, px * 4), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, px * 4, px * 4), fill=255)
    rnd = icon.convert("RGBA")
    rnd.putalpha(mask.resize((px, px), Image.LANCZOS))
    rnd.save(out / "ic_launcher_round.png")
    # Adaptive foreground: 108dp canvas, mark kept inside the 66dp safe zone.
    canvas_px = int(px * 108 / 48)
    mark_px = int(canvas_px * 0.61)
    canvas = Image.new("RGBA", (canvas_px, canvas_px), (0, 0, 0, 0))
    mark = fg.resize((mark_px, mark_px), Image.LANCZOS)
    offset = (canvas_px - mark_px) // 2
    canvas.paste(mark, (offset, offset), mark)
    canvas.save(out / "ic_launcher_foreground.png")

anydpi = res / "mipmap-anydpi-v26"
anydpi.mkdir(parents=True, exist_ok=True)
adaptive = """<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/namu_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
"""
(anydpi / "ic_launcher.xml").write_text(adaptive)
(anydpi / "ic_launcher_round.xml").write_text(adaptive)
print("icons written")
