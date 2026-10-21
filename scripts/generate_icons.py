"""Generate Qivra launcher, adaptive, splash, notification and favicon PNGs.

Mark: a heavy ring (the "Q") with a small light-green square as its tail.
Run: server/.venv/bin/python scripts/generate_icons.py  (needs Pillow)
"""
from pathlib import Path
from PIL import Image, ImageDraw

ASSETS = Path(__file__).resolve().parent.parent / "assets"
INK, PAPER, GREEN = (10, 10, 10, 255), (255, 255, 255, 255), (155, 229, 155, 255)


def mark(size, fg, accent, bg=None, scale=0.62):
    img = Image.new("RGBA", (size, size), bg or (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = size * scale / 2
    cx = cy = size / 2
    w = r * 0.34
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fg)
    d.ellipse([cx - r + w, cy - r + w, cx + r - w, cy + r - w], fill=bg or (0, 0, 0, 0))
    s = r * 0.62
    x0, y0 = cx + r * 0.42, cy + r * 0.42
    d.rounded_rectangle([x0, y0, x0 + s, y0 + s], radius=s * 0.18, fill=accent)
    return img


mark(1024, PAPER, GREEN, INK).save(ASSETS / "icon.png")                 # legacy launcher (dark tile)
mark(1024, PAPER, GREEN, None, scale=0.42).save(ASSETS / "adaptive-icon.png")  # foreground, safe zone
mark(1024, INK, (27, 122, 53, 255), None, scale=0.36).save(ASSETS / "splash-icon.png")
mark(96, PAPER, PAPER, None, scale=0.8).save(ASSETS / "notification-icon.png")  # monochrome white
mark(48, INK, (27, 122, 53, 255), PAPER).save(ASSETS / "favicon.png")
print("icons written to", ASSETS)
