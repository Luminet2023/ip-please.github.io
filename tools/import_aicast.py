#!/usr/bin/env python3
"""把 「Ai 资源」 里的 AI 娘立绘处理成游戏用的 180x128 像素立绘 + 40x50 证件照。

  python tools/import_aicast.py --src "C:/Users/AzurLane/Downloads/Ai 资源" --preview
  python tools/import_aicast.py --src "C:/Users/AzurLane/Downloads/Ai 资源"

输出 tools/assets/AICAST/<KEY>/booth/<KEY>_<expr>_180x128.png
     tools/assets/AICAST/<KEY>/passport/<KEY>_photo_40x50.png

处理流程（和 DAFEIYU 素材保持一致的「像素立绘」观感）：
  1. 保留 PNG 原有透明通道；仅对不透明图片从四边去除背景
  2. 用 alpha bbox 找到人物本体
  3. 以头部为中心裁一个 1.4:1 的窗口（头 + 肩 + 胸）
  4. BOX 缩小到 180x128，再量化到 56 色，保持像素风
  5. 证件照：从同一张中性立绘上取头部，40x50，12 色
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

TOOLS = Path(__file__).resolve().parent
OUT_ROOT = TOOLS / "assets" / "AICAST"

# 目录名 → 立绘 key（ASSETS.people）
CAST = {
    "Claude": "CLAUDE_AI",
    "GPT": "GPT_AI",
    "Qwen": "QWEN_AI",
    "Grok": "GROK_AI",
    "GLM": "GLM_AI",
    "Kimi": "KIMI_AI",
    "Gemini": "GEMINI_AI",
}
# 8 个表情槽位（顺序必须和 build_assets.py 的 EXPRS 一致）
EXPRS = ["neutral", "smile", "grin", "talk", "shock", "nervous", "sad", "angry"]

BW, BH = 180, 128


# ———————————————————— 去背景 ————————————————————

def strip_background(im: Image.Image, tol: int = 40) -> Image.Image:
    """已经有 alpha 的直接用；整张不透明的（比如带灰底的肖像）从四边 flood fill 掉底色。"""
    im = im.convert("RGBA")
    a = np.asarray(im)
    if im.getextrema()[3][0] < 255:
        return im
    rgb = a[:, :, :3].astype(np.int16)
    h, w, _ = rgb.shape
    corners = np.array([rgb[0, 0], rgb[0, w - 1], rgb[h - 1, 0], rgb[h - 1, w - 1]])
    seed = np.median(corners, axis=0)
    near = np.abs(rgb - seed).sum(axis=2) <= tol
    from collections import deque
    mask = np.zeros((h, w), dtype=bool)
    dq = deque()
    for x in range(w):
        for y in (0, h - 1):
            if near[y, x] and not mask[y, x]:
                mask[y, x] = True
                dq.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if near[y, x] and not mask[y, x]:
                mask[y, x] = True
                dq.append((y, x))
    while dq:
        y, x = dq.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and near[ny, nx] and not mask[ny, nx]:
                mask[ny, nx] = True
                dq.append((ny, nx))
    out = a.copy()
    out[mask, 3] = 0
    return Image.fromarray(out, "RGBA")


def face_window(im: Image.Image) -> tuple[int, int, int, int]:
    """裁一个「头顶到胸口」的 1.4:1 窗口。原图是胸像：头在上部、基本居中，头发会一直流到底边。"""
    w, h = im.size
    a = np.asarray(im.getchannel("A")).astype(np.uint8)
    rows = (a > 40).mean(axis=1)
    # 头顶：第一行有 2% 以上不透明像素
    top = next((y for y in range(h) if rows[y] > 0.01), 0)
    # 生成的胸像基本都在画面正中，直接用画幅中线，比按头发像素算中位数稳
    cx = w // 2
    cw = int(w * 0.95)
    ch = int(cw * BH / BW)
    left = int(np.clip(cx - cw // 2, 0, max(0, w - cw)))
    top = int(np.clip(top - int(h * 0.02), 0, max(0, h - ch)))
    return (left, top, left + cw, top + ch)


def to_sprite(im: Image.Image, colors: int = 56) -> Image.Image:
    win = face_window(im)
    crop = im.crop(win)
    crop = crop.resize((BW, BH), Image.BOX)
    # 少量锐化，压掉 BOX 缩小后的糊感
    crop = crop.filter(ImageFilterSharp())
    rgb = crop.convert("RGB").quantize(colors=colors, method=Image.MEDIANCUT, dither=Image.NONE).convert("RGB")
    out = rgb.convert("RGBA")
    out.putalpha(crop.getchannel("A"))
    return out


def ImageFilterSharp():
    from PIL import ImageFilter
    return ImageFilter.UnsharpMask(radius=1.2, percent=110, threshold=2)


def passport_photo(sprite: Image.Image, colors: int = 12) -> Image.Image:
    """从立绘上部取头肩，40x50，压到 12 色 —— 和游戏里其它证件照一个味道。"""
    head = sprite.crop((38, 4, 142, 134)).resize((40, 50), Image.BOX)
    q = head.convert("RGB").quantize(colors=colors, method=Image.MEDIANCUT, dither=Image.NONE).convert("RGB")
    bg = Image.new("RGB", (40, 50), (176, 180, 176))
    bg.paste(q, (0, 0), head.getchannel("A").resize((40, 50), Image.BOX))
    return bg


# ———————————————————— 预览 ————————————————————

def montage(src: Path, out: Path):
    rows = []
    for d in CAST:
        files = sorted((src / d).glob("*.png"))
        rows.append((d, files))
    cols = max(len(f) for _, f in rows)
    cw, chh = 220, 165
    sheet = Image.new("RGB", (cols * cw, len(rows) * chh), (30, 28, 28))
    dr = ImageDraw.Draw(sheet)
    for r, (name, files) in enumerate(rows):
        dr.text((4, r * chh + 4), name, fill=(255, 220, 120))
        for c, f in enumerate(files):
            im = Image.open(f).convert("RGBA")
            im.thumbnail((cw - 8, chh - 20), Image.LANCZOS)
            sheet.paste(im, (c * cw + 4, r * chh + 16), im)
            dr.text((c * cw + 6, r * chh + chh - 14), f.name[-8:], fill=(200, 200, 200))
    sheet.save(out)
    print("预览图：", out, sheet.size)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--preview", action="store_true")
    ap.add_argument("--map", help="JSON：{目录: {expr: 文件名后缀序号}}，不给就按文件名顺序")
    args = ap.parse_args()
    src = Path(args.src)
    if args.preview:
        montage(src, TOOLS / "preview_aicast.png")
        return
    mapping = json.loads(Path(args.map).read_text(encoding="utf-8")) if args.map else {}
    for d, key in CAST.items():
        # 竖构图的那张是「肖像」（1122x1402），裁成 180x128 会变形，只用来做证件照素材，不进立绘序列
        files = []
        for f in sorted((src / d).glob("*.png")):
            with Image.open(f) as original:
                if original.width > original.height:
                    files.append(f)
        if not files:
            print("跳过（没有图）：", d)
            continue
        box = OUT_ROOT / key / "booth"
        box.mkdir(parents=True, exist_ok=True)
        (OUT_ROOT / key / "passport").mkdir(parents=True, exist_ok=True)
        order = mapping.get(key) or {}
        generated = set()
        for i, f in enumerate(files):
            expr = order.get(str(i)) or (EXPRS[i] if i < len(EXPRS) else None)
            if not expr:
                continue
            with Image.open(f) as original:
                im = strip_background(original)
            spr = to_sprite(im)
            for e in ([expr] if isinstance(expr, str) else expr):
                spr.save(box / f"{key}_{e}_{BW}x{BH}.png")
                generated.add(e)
                if e == "neutral":
                    passport_photo(spr).save(OUT_ROOT / key / "passport" / f"{key}_photo_40x50.png")

        # 有的角色生成图不够 8 张：缺的表情就用最接近的补上，保证 exprKey 永远有图
        for e in EXPRS:
            dst = box / f"{key}_{e}_{BW}x{BH}.png"
            if e in generated:
                continue
            for src_e in ("neutral", "talk", "smile", "sad", "grin", "angry", "nervous"):
                s = box / f"{key}_{src_e}_{BW}x{BH}.png"
                if src_e in generated and s.exists():
                    import shutil
                    shutil.copyfile(s, dst)
                    break
        print(f"{d} → {key}: {len(files)} 张")


if __name__ == "__main__":
    main()
