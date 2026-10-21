#!/usr/bin/env python3
"""把 ImageGen 生成的家属立绘处理成 import_aicast.py 能吃的源图。

  python tools/prep_gen_aicast.py --dir tools/assets/_gen/Haiku

处理链（每一步都是为了「抠干净」）：
  1. strip_background：抠掉模型画的棋盘格 / 纯色底（import_aicast.checker_mask）
  2. defringe：把透明区域向内收 1px，吃掉边缘那圈浅色描边
  3. remove_specks：面积不到主体 2% 的孤岛全部清掉（棋盘碎片、白色闪光点）
  4. bleed_colors：透明像素的 RGB 改成最近的不透明像素颜色，避免缩放时白边渗进边缘
  5. pad_to_43 + normalize：补成 4:3，人物按 bbox 统一缩放到同一高度，表情切换不跳大小
  6. 收尾把 alpha < 16 的半透明毛边直接压成 0，并断言四边完全透明

原地覆盖，文件名不变（先用 <序号>_<表情>.png 命名，import 就按序号取表情）。
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from scipy import ndimage
from PIL import Image

from import_aicast import strip_background

CANVAS_W, CANVAS_H = 1536, 1152
TARGET_H = 1000      # 人物（不透明区域）统一缩放到这个高度
TOP = 56             # 头顶留白
EDGE = 24            # 四边必须完全透明的宽度


def alpha_of(im: Image.Image) -> np.ndarray:
    return np.asarray(im.getchannel("A"))


def defringe(im: Image.Image, px: int = 1) -> Image.Image:
    """把 alpha=0 的区域向内膨胀一圈，吃掉抠图边缘残留的浅色描边。"""
    a = np.asarray(im).copy()
    solid = a[:, :, 3] > 8
    outer = ndimage.binary_dilation(~solid, iterations=px)
    a[outer, 3] = 0
    return Image.fromarray(a, "RGBA")


def remove_specks(im: Image.Image, min_size: int = 2000) -> Image.Image:
    """只保留主体：面积小于 min_size 像素的孤岛全部清掉（棋盘碎片、白色闪光点）。"""
    a = np.asarray(im).copy()
    solid = a[:, :, 3] > 8
    labels, count = ndimage.label(solid)
    if count <= 1:
        return im
    sizes = ndimage.sum(solid, labels, range(1, count + 1))
    keep = [i + 1 for i, s in enumerate(sizes) if s >= min_size]
    keep_mask = np.isin(labels, keep)
    a[~keep_mask, 3] = 0
    return Image.fromarray(a, "RGBA")


def bleed_colors(im: Image.Image) -> Image.Image:
    """透明像素的 RGB 用最近的不透明像素填满，缩放时不会把白底渗到边缘。"""
    a = np.asarray(im).copy()
    solid = a[:, :, 3] > 8
    if not solid.any():
        return im
    idx = ndimage.distance_transform_edt(~solid, return_distances=False, return_indices=True)
    a[:, :, :3] = a[:, :, :3][tuple(idx)]
    return Image.fromarray(a, "RGBA")


def remove_white_holes(im: Image.Image, min_size: int = 250, std_min: float = 8.5) -> Image.Image:
    """头发/肩膀围住的棋盘洞：边框 flood fill 到不了，得单独认。

    判据：近中性白 + 亮度方差大（棋盘是两色交替，缩放后是一团噪声；
    人物自己的白色高光是一条平滑渐变，方差通常 < 6）+ 够大或够细长。
    眼睛里的高光是小方块（std 低、20px 左右），会被下面两条尺寸条件挡掉。
    """
    a = np.asarray(im).copy()
    rgb = a[:, :, :3].astype(np.int16)
    al = a[:, :, 3]
    spread = rgb.max(axis=2) - rgb.min(axis=2)
    lum = rgb.mean(axis=2)
    near = (al > 8) & (spread <= 6) & (rgb.min(axis=2) >= 200)
    labels, count = ndimage.label(near)
    for i, sl in enumerate(ndimage.find_objects(labels), start=1):
        if sl is None:
            continue
        comp = labels[sl] == i
        size = int(comp.sum())
        if size < min_size:
            continue
        h = sl[0].stop - sl[0].start
        w = sl[1].stop - sl[1].start
        if not (size >= 1000 or max(w, h) >= 60):
            continue
        if lum[sl][comp].std() < std_min:
            continue
        block = a[sl]
        block[comp, 3] = 0
    return Image.fromarray(a, "RGBA")


def drop_white_islands(im: Image.Image, max_size: int = 4000, white_frac: float = 0.5) -> Image.Image:
    """最后一道：小块孤岛里只要有超过一半是近白色，就当背景残留删掉（真的人物碎片不会是白色）。"""
    a = np.asarray(im).copy()
    rgb = a[:, :, :3].astype(np.int16)
    al = a[:, :, 3]
    solid = al > 8
    labels, count = ndimage.label(solid)
    if count <= 1:
        return im
    spread = rgb.max(axis=2) - rgb.min(axis=2)
    whitish = (spread <= 8) & (rgb.min(axis=2) >= 195)
    sizes = ndimage.sum(solid, labels, range(1, count + 1))
    main = int(np.argmax(sizes)) + 1
    for i in range(1, count + 1):
        if i == main or sizes[i - 1] > max_size:
            continue
        comp = labels == i
        if whitish[comp].mean() >= white_frac:
            a[comp, 3] = 0
    return Image.fromarray(a, "RGBA")


def pad_to_43(im: Image.Image) -> Image.Image:
    w, h = im.size
    target = round(w * 3 / 4)
    if h >= target:
        return im
    out = Image.new("RGBA", (w, target), (0, 0, 0, 0))
    out.paste(im, (0, 0), im)
    return out


def normalize(im: Image.Image) -> Image.Image:
    """把人物按 alpha bbox 统一缩放并摆到画布同一位置，表情切换时不会缩放抖动。"""
    bbox = im.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox()
    if not bbox:
        return im
    left, top, right, bottom = bbox
    scale = max(0.3, min(3.0, TARGET_H / (bottom - top)))
    body = im.crop(bbox)
    body = body.resize((max(1, round(body.width * scale)), max(1, round(body.height * scale))), Image.LANCZOS)
    out = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    out.paste(body, ((CANVAS_W - body.width) // 2, TOP), body)
    return out


def harden_edge(im: Image.Image) -> Image.Image:
    a = np.asarray(im).copy()
    a[a[:, :, 3] < 16, 3] = 0
    return Image.fromarray(a, "RGBA")


def inspect(im: Image.Image) -> dict:
    a = np.asarray(im)
    al = a[:, :, 3]
    rgb = a[:, :, :3].astype(np.int16)
    solid = al > 8
    border = np.concatenate([al[:EDGE].ravel(), al[-EDGE:].ravel(),
                             al[:, :EDGE].ravel(), al[:, -EDGE:].ravel()])
    spread = rgb.max(axis=2) - rgb.min(axis=2)
    white_like = solid & (spread <= 6) & (rgb.min(axis=2) >= 205)
    labels, count = ndimage.label(solid)
    sizes = ndimage.sum(solid, labels, range(1, count + 1)) if count else np.array([0])
    stray = (sizes.sum() - sizes.max()) if count else 0
    return {
        "border_dirty": int((border > 0).sum()),
        "white_like": float(white_like.sum()) / max(1, int(solid.sum())),
        "islands": int(count),
        "stray": float(stray) / max(1, int(solid.sum())),
        "opaque": float(solid.mean()),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    args = ap.parse_args()
    d = Path(args.dir)
    raw = d.parent / "_raw" / d.name
    # 原始素材留一份到 _raw/：以后重跑都从 _raw/ 出发，重复处理不会越抠越小；
    # 新生成还没进 _raw 的图，先按原样补进去
    raw.mkdir(parents=True, exist_ok=True)
    for f in sorted(d.glob("*.png")):
        if not (raw / f.name).exists():
            (raw / f.name).write_bytes(f.read_bytes())
    files = sorted(raw.glob("*.png"))
    if not files:
        raise SystemExit(f"没有 png：{raw}")
    bad = []
    for f in files:
        with Image.open(f) as original:
            im = strip_background(original)
        im = remove_white_holes(im)          # 围在头发里的棋盘洞
        im = defringe(im)                    # 边缘内收 1px，去掉浅色描边
        im = remove_specks(im, 600)          # 剩余孤岛
        im = drop_white_islands(im)          # 白色残块
        im = harden_edge(normalize(pad_to_43(bleed_colors(im))))
        im.save(d / f.name)
        info = inspect(im)
        ok = not info["border_dirty"] and info["stray"] < 0.001 and info["white_like"] < 0.01
        print(f"{f.name}  {im.size}  主体 {info['opaque']:.0%}  "
              f"孤立块 {info['islands']}（碎屑 {info['stray']:.2%}）  "
              f"边缘非透明 {info['border_dirty']}px  近白 {info['white_like']:.2%}"
              f"{'' if ok else '  ⚠️ 没抠干净'}")
        if not ok:
            bad.append(f.name)
    if bad:
        raise SystemExit(f"这些图还有残留：{', '.join(bad)}")


if __name__ == "__main__":
    main()
