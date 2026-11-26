#!/usr/bin/env python3
"""Generate every icon SENTINEL needs from one vector-ish definition.

Pure Pillow (no cairo) so it runs anywhere, including CI.
Outputs: build/icon.png|ico|tray.png, ui/assets/icon-*.png,
Android launcher mipmaps (square + round).
"""

import math
import os
import pathlib

from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parent.parent
S = 2048  # supersampled canvas
BG = (7, 11, 18, 255)
CYAN = (60, 224, 255)
VIOLET = (139, 123, 255)


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(len(a)))


def gradient(size, horizontal=False):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    for i in range(size):
        t = i / max(1, size - 1)
        color = lerp(CYAN, VIOLET, t) + (255,)
        if horizontal:
            draw.line([(i, 0), (i, size)], fill=color)
        else:
            draw.line([(0, i), (size, i)], fill=color)
    return img


def shield_points(cx, cy, w, h):
    """Classic shield: flat shoulders, sides falling into a point."""
    top = cy - h / 2
    shoulder = top + h * 0.14
    bottom = cy + h / 2
    left = cx - w / 2
    right = cx + w / 2
    pts = [(cx, top), (right, shoulder), (right, cy + h * 0.12)]
    # right curve to the tip
    for i in range(1, 41):
        t = i / 40
        x = right + (cx - right) * (t ** 0.72)
        y = (cy + h * 0.12) + (bottom - (cy + h * 0.12)) * t
        pts.append((x, y))
    for i in range(39, 0, -1):
        t = i / 40
        x = left + (cx - left) * (t ** 0.72)
        y = (cy + h * 0.12) + (bottom - (cy + h * 0.12)) * t
        pts.append((x, y))
    pts += [(left, cy + h * 0.12), (left, shoulder)]
    return pts


def stroke_mask(points, width, closed=False):
    mask = Image.new("L", (S, S), 0)
    draw = ImageDraw.Draw(mask)
    if closed:
        points = points + [points[0]]
    draw.line(points, fill=255, width=width, joint="curve")
    r = width / 2
    for (x, y) in (points[0], points[-1]):
        draw.ellipse([x - r, y - r, x + r, y + r], fill=255)
    return mask


def build():
    icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    draw = ImageDraw.Draw(icon)

    # rounded background
    radius = int(S * 0.225)
    draw.rounded_rectangle([0, 0, S, S], radius=radius, fill=BG)

    # soft radial glow in the upper left
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow)
    cx, cy = int(S * 0.34), int(S * 0.22)
    for i in range(60, 0, -1):
        r = int(S * 0.09 * i)
        alpha = int(1.35 * (60 - i) / 60 * 26)
        gdraw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=CYAN + (alpha,))
    glow = glow.filter(__import__("PIL.ImageFilter", fromlist=["GaussianBlur"]).GaussianBlur(S * 0.045))
    icon = Image.alpha_composite(icon, glow)

    # shield outline
    shield = shield_points(S / 2, S / 2, S * 0.56, S * 0.66)
    mask = stroke_mask(shield + [shield[0]], int(S * 0.036))
    grad = gradient(S, horizontal=False)
    icon.paste(grad, (0, 0), mask)

    # circuit marks
    marks = Image.new("L", (S, S), 0)
    mdraw = ImageDraw.Draw(marks)
    w = int(S * 0.026)
    mid = S / 2
    mdraw.line([(mid, S * 0.395), (mid, S * 0.70)], fill=255, width=w)
    for y in (S * 0.47, S * 0.545, S * 0.62):
        mdraw.line([(mid - S * 0.115, y), (mid + S * 0.115, y)], fill=255, width=w)
    for (x, y) in [(mid, S * 0.395), (mid, S * 0.70), (mid - S * 0.115, S * 0.47), (mid + S * 0.115, S * 0.47),
                   (mid - S * 0.115, S * 0.62), (mid + S * 0.115, S * 0.62)]:
        r = w / 2
        mdraw.ellipse([x - r, y - r, x + r, y + r], fill=255)
    icon.paste(grad, (0, 0), marks)

    master = icon.resize((1024, 1024), Image.LANCZOS)

    def save(path, size, img=None):
        path = ROOT / path
        path.parent.mkdir(parents=True, exist_ok=True)
        (img or master).resize((size, size), Image.LANCZOS).save(path)
        print("wrote", path.relative_to(ROOT), size)

    save("build/icon.png", 512)
    save("build/tray.png", 64)
    save("ui/assets/icon-192.png", 192)
    save("ui/assets/icon-512.png", 512)

    ico = ROOT / "build/icon.ico"
    ico.parent.mkdir(parents=True, exist_ok=True)
    master.resize((256, 256), Image.LANCZOS).save(ico, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("wrote", ico.relative_to(ROOT))

    # Android launcher icons
    densities = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
    for name, size in densities.items():
        base = ROOT / "mobile/android/app/src/main/res" / f"mipmap-{name}"
        base.mkdir(parents=True, exist_ok=True)
        square = master.resize((size, size), Image.LANCZOS)
        square.save(base / "ic_launcher.png")
        # round variant
        round_img = square.copy()
        m = Image.new("L", (size * 4, size * 4), 0)
        ImageDraw.Draw(m).ellipse([0, 0, size * 4 - 1, size * 4 - 1], fill=255)
        m = m.resize((size, size), Image.LANCZOS)
        round_img.putalpha(m)
        round_img.save(base / "ic_launcher_round.png")
        # adaptive foreground (transparent, centred art at 66%)
        fg = Image.new("RGBA", (size * 3, size * 3), (0, 0, 0, 0))
        art = master.resize((int(size * 3 * 0.6),) * 2, Image.LANCZOS)
        fg.paste(art, (int(size * 3 * 0.2), int(size * 3 * 0.2)), art)
        fg.save(base / "ic_launcher_foreground.png")
    print("android mipmaps written")

    # splash logo used by Capacitor's launch screen
    splash_dir = ROOT / "mobile/android/app/src/main/res/drawable"
    if splash_dir.exists():
        save("mobile/android/app/src/main/res/drawable/splash.png", 512)


if __name__ == "__main__":
    build()
