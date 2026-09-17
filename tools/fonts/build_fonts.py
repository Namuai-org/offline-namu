"""Release tool: produce Namu's bundled font assets from official upstream sources.

Inputs (downloaded by fetch.sh from the official Google repositories, see
docs/assets/asset-inventory.md for the pinned upstream commits):
  - DMSans[opsz,wght].ttf                       (SIL OFL 1.1)
  - MaterialSymbolsRounded[FILL,GRAD,opsz,wght].ttf + .codepoints (Apache-2.0)

Outputs (committed):
  - src/design/fonts/DMSans-Regular.ttf / -Medium.ttf / -SemiBold.ttf
  - src/design/fonts/MaterialSymbolsRounded-Subset.ttf
  - src/design/icons/glyphs.json   (icon name -> codepoint)

File names equal PostScript names so the same fontFamily string resolves on
Android (file name) and iOS (PostScript name).

Python is a release tool only; it is not part of the mobile app.
"""
import json
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = Path(__file__).resolve().parents[2]
SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "tools/fonts/upstream"
FONTS_OUT = ROOT / "src/design/fonts"
ICONS_OUT = ROOT / "src/design/icons"

DM_SANS_INSTANCES = {
    "DMSans-Regular": ("Regular", 400),
    "DMSans-Medium": ("Medium", 500),
    "DMSans-SemiBold": ("SemiBold", 600),
}
# Optical size for UI text between 14 and 28 logical pixels.
DM_SANS_OPSZ = 14

ICON_PS_NAME = "MaterialSymbolsRounded-Subset"


def set_names(font: TTFont, family: str, style: str, ps_name: str) -> None:
    name = font["name"]
    for record in list(name.names):
        if record.nameID in (1, 2, 3, 4, 6, 16, 17, 21, 22, 25):
            name.removeNames(nameID=record.nameID)
    full = f"{family} {style}"
    for platform, enc, lang in ((3, 1, 0x409), (1, 0, 0)):
        name.setName(full if style != "Regular" else family, 1, platform, enc, lang)
        name.setName("Regular", 2, platform, enc, lang)
        name.setName(f"Namu build;{ps_name}", 3, platform, enc, lang)
        name.setName(full, 4, platform, enc, lang)
        name.setName(ps_name, 6, platform, enc, lang)
        name.setName(family, 16, platform, enc, lang)
        name.setName(style, 17, platform, enc, lang)


def build_dm_sans() -> None:
    source = SRC / "DMSans.ttf"
    for ps_name, (style, weight) in DM_SANS_INSTANCES.items():
        font = TTFont(source)
        static = instancer.instantiateVariableFont(
            font, {"wght": weight, "opsz": DM_SANS_OPSZ}, inplace=False
        )
        set_names(static, "DM Sans", style, ps_name)
        static["OS/2"].usWeightClass = weight
        # Every static file is addressed by its own family name from React
        # Native, so mark each as a regular (non-bold) face.
        static["OS/2"].fsSelection = (static["OS/2"].fsSelection & ~0x21) | 0x40
        static["head"].macStyle = 0
        out = FONTS_OUT / f"{ps_name}.ttf"
        static.save(out)
        print("wrote", out.relative_to(ROOT), out.stat().st_size)


def build_icons() -> None:
    wanted = json.loads((ICONS_OUT / "icon-names.json").read_text())
    codepoints = {}
    for line in (SRC / "MSR.codepoints").read_text().splitlines():
        parts = line.split()
        if len(parts) == 2:
            codepoints[parts[0]] = int(parts[1], 16)
    missing = [n for n in wanted if n not in codepoints]
    if missing:
        raise SystemExit(f"Unknown Material Symbols names: {missing}")

    font = TTFont(SRC / "MSR.ttf")
    static = instancer.instantiateVariableFont(
        font, {"FILL": 0, "GRAD": 0, "opsz": 24, "wght": 400}, inplace=False
    )
    options = subset.Options()
    options.layout_features = []  # codepoint addressing only; drop ligatures
    options.name_IDs = ["*"]
    options.notdef_outline = True
    options.glyph_names = False
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=[codepoints[n] for n in wanted])
    subsetter.subset(static)
    set_names(static, "Material Symbols Rounded Subset", "Regular", ICON_PS_NAME)
    out = FONTS_OUT / f"{ICON_PS_NAME}.ttf"
    static.save(out)
    print("wrote", out.relative_to(ROOT), out.stat().st_size)

    glyphs = {n: codepoints[n] for n in sorted(wanted)}
    (ICONS_OUT / "glyphs.json").write_text(json.dumps(glyphs, indent=2) + "\n")
    print("wrote", (ICONS_OUT / "glyphs.json").relative_to(ROOT), len(glyphs))


if __name__ == "__main__":
    FONTS_OUT.mkdir(parents=True, exist_ok=True)
    build_dm_sans()
    build_icons()
