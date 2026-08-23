"""
Build the ROM Convert app icon.

Drawn geometrically rather than set from a font, so it stays crisp at 16px in
the taskbar where a glyph would turn to mush. The mark is a chevron pushing
into a bar: something going through a process and coming out changed.

    python scripts/make_icon.py
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"

VOID = (13, 10, 20, 255)
VIOLET = (124, 58, 237)
PINK = (255, 45, 154)

# Drawn oversized, then downsampled — cheap antialiasing without a filter pass.
SS = 8
SIZE = 512
W = SIZE * SS


def lerp(a, b, t: float):
    t = max(0.0, min(1.0, t))
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient_mask(mask: Image.Image) -> Image.Image:
    """Paints the ROM violet→pink ramp through an alpha mask."""
    grad = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(grad)
    for x in range(0, W, SS):
        # Diagonal ramp reads better on a square mark than a flat horizontal one.
        c = lerp(VIOLET, PINK, x / W)
        d.rectangle([x, 0, x + SS, W], fill=c + (255,))
    out = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    out.paste(grad, (0, 0), mask)
    return out


def build() -> None:
    ASSETS.mkdir(exist_ok=True)

    icon = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(icon)

    # Rounded tile. Windows renders app icons on every shade of background, so
    # the mark needs its own ground rather than floating transparent.
    d.rounded_rectangle([0, 0, W - 1, W - 1], radius=int(W * 0.22), fill=VOID)

    mask = Image.new("L", (W, W), 0)
    m = ImageDraw.Draw(mask)

    u = W / 512.0
    cy = W / 2

    # An arrow: the one mark everyone reads as "this becomes that". Shaft and
    # head are drawn as one path so the join stays clean at small sizes.
    thick = 56 * u
    shaft_x0, shaft_x1 = 118 * u, 360 * u
    m.rounded_rectangle(
        [shaft_x0, cy - thick / 2, shaft_x1, cy + thick / 2],
        radius=thick / 2,
        fill=255,
    )

    tip = 394 * u
    spread = 104 * u
    m.line(
        [(tip - spread, cy - spread), (tip, cy), (tip - spread, cy + spread)],
        fill=255,
        width=int(thick),
        joint="curve",
    )

    icon.alpha_composite(gradient_mask(mask))

    full = icon.resize((SIZE, SIZE), Image.LANCZOS)
    full.save(ASSETS / "icon.png")
    full.resize((256, 256), Image.LANCZOS).save(ASSETS / "icon-256.png")

    # Every size Windows actually asks for; letting it downscale one big frame
    # gives a blurry 16px in the taskbar and title bar.
    full.save(
        ASSETS / "icon.ico",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )

    for f in ("icon.png", "icon-256.png", "icon.ico"):
        p = ASSETS / f
        print(f"wrote {p.name} ({p.stat().st_size} bytes)")


if __name__ == "__main__":
    build()
