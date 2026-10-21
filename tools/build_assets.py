#!/usr/bin/env python3
"""把像素素材预渲染成网页游戏用的图集，输出仓库根目录的 assets.js。

  pip install -r tools/requirements.txt
  python tools/build_assets.py

- 字体图集：扫描根目录下所有 JS/HTML 里出现的字符，只渲染这些字（缝合像素字体 8/10/12px）
- 精灵图集：旅客立绘（各种表情）、证件照、背景、印章等，全部复用 pp/ 里的画法
- 英文版：带中文的印章、对齐部圆印另出一份 `:en`；背景上的中文横幅、路牌、宪法书只出两小块补丁 `bg:en:*`
产物是一个 JS 文件（图片以 base64 内嵌），所以 index.html 直接双击也能玩。
"""
import base64
import io
import json
import random
import sys
from pathlib import Path

from PIL import Image, ImageChops

TOOLS = Path(__file__).resolve().parent
SITE = TOOLS.parent
sys.path.insert(0, str(TOOLS))

from pp import cast  # noqa: E402
from pp.base import FONTS, GOLD, GREEN, OUTLINE, RED, SEAL, draw, spark, txt  # noqa: E402
from pp.booth import static_layer, window_bg  # noqa: E402
from pp.docs import CrayonPassport, stamp_mark  # noqa: E402
from pp.people import Person, photo, shade  # noqa: E402
from pp.screens import _icon  # noqa: E402

# ———————————————————— 字体 ————————————————————


def used_chars():
    chars = {chr(c) for c in range(32, 127)}
    for p in sorted(SITE.glob("*.js")) + [SITE / "index.html"]:
        if p.name == "assets.js" or not p.exists():
            continue
        chars |= set(p.read_text(encoding="utf-8"))
    return sorted(c for c in chars if c.isprintable() and c not in "\t\r\n")


def glyph_mask(ch, size):
    f = FONTS[size]
    im = Image.new("L", (size * 2 + 8, size * 2 + 8), 0)
    d = draw(im)
    txt(d, (4, 4), ch, size, 255)
    return im


def build_font():
    chars = used_chars()
    missing = []
    sheets = {}
    for size in (8, 10, 12):
        f = FONTS[size]
        notdef = glyph_mask("\u0378", size).tobytes()   # 未分配码位 → 缺字方块
        glyphs, cells = {}, []
        for ch in chars:
            m = glyph_mask(ch, size)
            if ch != " " and m.tobytes() == notdef:
                if size == 12:
                    missing.append(ch)
                continue
            adv = round(f.getlength(ch))
            bb = m.getbbox()
            if bb is None:
                glyphs[ch] = [0, 0, 0, 0, 0, 0, adv]
                continue
            crop = m.crop(bb)
            cells.append((ch, crop, bb[0] - 4, bb[1] - 4, adv))
        sheets[size] = (glyphs, cells)
    # 三个字号排进同一张图（白字透明底，运行时再上色）
    W = 1024
    x = y = row_h = 0
    placed = []
    for size in (8, 10, 12):
        glyphs, cells = sheets[size]
        for ch, crop, ox, oy, adv in cells:
            if x + crop.width > W:
                x, y, row_h = 0, y + row_h + 1, 0
            placed.append((size, ch, crop, x, y, ox, oy, adv))
            x += crop.width + 1
            row_h = max(row_h, crop.height)
    sheet = Image.new("LA", (W, y + row_h + 1), (255, 0))
    out = {8: {}, 10: {}, 12: {}}
    for size, ch, crop, gx, gy, ox, oy, adv in placed:
        sheet.paste(Image.new("LA", crop.size, (255, 255)), (gx, gy), crop)
        out[size][ch] = [gx, gy, crop.width, crop.height, ox, oy, adv]
    for size in (8, 10, 12):
        out[size].update(sheets[size][0])
    if missing:
        print("字体缺字（会被跳过）：", "".join(missing))
    return sheet, out


# ———————————————————— 人物 ————————————————————

EXPRS = ["neutral", "smile", "grin", "talk", "shock", "nervous", "sad", "angry"]
POOL_EXPRS = ["neutral", "smile", "grin", "talk", "shock", "nervous", "sad"]

SCRIPTED = {
    "GRANDPA": cast.GRANDPA, "HK_GUY": cast.HK_GUY, "JORJI": cast.JORJI, "JOHN": cast.JOHN,
    "BROWN": cast.BROWN, "EMILY": cast.EMILY, "GUARD": cast.GUARD, "GUARD2": cast.GUARD2,
    "TOM": cast.TOM, "ALEX": cast.ALEX, "CAT_GIRL": cast.CAT_GIRL, "V50": cast.V50, "HOOD": cast.HOOD,
    "SG_MAN": cast.SG_MAN, "RELAY": cast.RELAY, "MIKE": cast.MIKE, "GRANDMA": cast.GRANDMA,
    "JORJI_SUIT": cast.JORJI_SUIT, "AUTHOR": cast.AUTHOR,
    "AUDITOR": cast.AUDITOR, "HAIKU": cast.HAIKU, "SONNET": cast.SONNET, "OPUS": cast.OPUS,
    "MINIMAX": cast.MINIMAX, "CLERK": cast.CLERK,
    "APPELLANT_A": cast.APPELLANT_A, "APPELLANT_B": cast.APPELLANT_B, "APPELLANT_C": cast.APPELLANT_C,
    **{f"SLANG{i}": p for i, p in enumerate(cast.SLANG)},
}
GROUP_EXPRS = ["smile", "talk", "neutral", "shock", "sad", "nervous"]


def random_pool(n=24, seed=2026):
    """随机路人：肤色、脸型、发型、衣服都随机——只看地区，不看脸。"""
    rng = random.Random(seed)
    hair_colors = [(42, 34, 31), (30, 26, 24), (80, 60, 44), (96, 64, 44), (206, 176, 104), (160, 156, 150),
                   (140, 70, 40), (60, 46, 40)]
    tops = ["jacket", "suit", "hoodie", "cardigan", "polo", "plaid", "shirt_tie", "tee"]
    top_colors = [(86, 82, 64), (96, 70, 58), (52, 56, 70), (90, 96, 104), (120, 96, 70), (70, 96, 96),
                  (150, 60, 50), (130, 62, 56), (80, 90, 120), (140, 80, 90), (90, 110, 80), (110, 100, 90),
                  (70, 100, 130), (160, 120, 140), (60, 60, 70), (200, 180, 120), (206, 204, 196)]
    people = []
    for i in range(n):
        hair = rng.choice(["short", "short", "side", "slick", "bald", "buzz", "curly", "long", "long", "bun"])
        hat = rng.choice([None] * 7 + ["cap", "flatcap", "cowboy"])
        if hair == "bald" and hat:
            hat = None
        p = Person(
            skin=rng.choice(["light", "mid", "tan", "deep"]),
            face=rng.choice(["oval", "round", "long", "square"]),
            hair=hair,
            hair_color=rng.choice(hair_colors),
            beard=rng.choice([None] * 6 + ["mustache", "stubble"]),
            eyes=rng.choice([None] * 5 + ["glasses", "rimless"]),
            hat=hat,
            hat_color=rng.choice([(150, 48, 42), (70, 62, 56), (60, 80, 110), (150, 108, 70)]),
            top=rng.choice(tops),
            top_color=rng.choice(top_colors),
            inner=rng.choice([(210, 204, 190), (200, 196, 186), (170, 160, 140)]),
            tie=rng.choice([(120, 40, 36), (60, 70, 110), (90, 90, 100)]),
            acc=rng.choice([None] * 12 + ["headphones"]),
            expr=rng.choice(["neutral", "smile"]),
        )
        people.append((f"P{i:02d}", p))
    return people


# ———————————————————— 图集 ————————————————————


class Packer:
    def __init__(self, width=2048):
        self.width = width
        self.items = []

    def add(self, key, im, crop=True):
        im = im.convert("RGBA")
        ox = oy = 0
        if crop:
            bb = im.getchannel("A").getbbox()
            if bb:
                im = im.crop(bb)
                ox, oy = bb[0], bb[1]
        self.items.append((key, im, ox, oy))

    def build(self):
        items = sorted(self.items, key=lambda it: -it[1].height)
        x = y = row_h = 0
        pos = {}
        for key, im, ox, oy in items:
            if x + im.width > self.width:
                x, y, row_h = 0, y + row_h + 1, 0
            pos[key] = (x, y, im.width, im.height, ox, oy)
            x += im.width + 1
            row_h = max(row_h, im.height)
        sheet = Image.new("RGBA", (self.width, y + row_h + 1), (0, 0, 0, 0))
        for key, im, ox, oy in items:
            sheet.paste(im, pos[key][:2])
        return sheet, pos


def seal_sprite(lang="zh"):
    im = Image.new("RGBA", (34, 34), (0, 0, 0, 0))
    d = draw(im)
    d.ellipse([0, 0, 33, 33], outline=SEAL, width=2)
    txt(d, (17, 8), "M.O.A.", 8, SEAL, anchor="ma")
    txt(d, (17, 19), "ALIGN" if lang == "en" else "对齐部", 8, SEAL, anchor="ma")
    return im


def hq_seal_sprite():
    """总部圆印：纸质公文上盖的那种。"""
    im = Image.new("RGBA", (36, 36), (0, 0, 0, 0))
    d = draw(im)
    d.ellipse([0, 0, 35, 35], outline=SEAL, width=2)
    d.ellipse([5, 5, 30, 30], outline=SEAL, width=1)
    txt(d, (18, 9), "M.O.A.", 8, SEAL, anchor="ma")
    txt(d, (18, 19), "总部", 8, SEAL, anchor="ma")
    return im


def emblem_sprite():
    im = Image.new("RGBA", (23, 21), (0, 0, 0, 0))
    d = draw(im)
    d.ellipse([0, 0, 22, 20], outline=GOLD)
    spark(d, 11, 10, GOLD, big=False)
    return im


def title_emblem():
    from pp.base import CLAUDE, CLAUDE_L
    im = Image.new("RGBA", (45, 45), (0, 0, 0, 0))
    d = draw(im)
    d.ellipse([0, 0, 44, 44], fill=(60, 24, 22))
    d.ellipse([0, 0, 44, 44], outline=CLAUDE)
    spark(d, 22, 22, CLAUDE_L, k=2)
    return im


def stamp_sprite(kind, lang="zh"):
    m = stamp_mark(kind, lang=lang)
    im = Image.new("RGBA", m.size, (RED if kind == "deny" else GREEN) + (0,))
    im.putalpha(m)
    return im


def news_icon(kind):
    im = Image.new("RGB", (133, 101), (200, 188, 166))
    _icon(draw(im), kind, 0, 0, 132, 100)
    return im


def group_photo(group):
    """拼车团的证件照：六张迷你证件照拼成 3×2。"""
    im = Image.new("RGB", (40, 50), (176, 180, 176))
    for i, p in enumerate(group.people):
        small = photo(p.sprite()).resize((13, 16), Image.BOX)
        im.paste(small, (1 + (i % 3) * 13, 8 + (i // 3) * 17))
    return im


def news_icon_jorji():
    im = Image.new("RGB", (133, 101), (200, 188, 166))
    d = draw(im)
    g, a = _icon(d, "jorji", 0, 0, 132, 100)
    im.paste(g, (16, -6), a)
    return im


def bg_patches(zh, en):
    """英文背景和中文背景不同的地方（室外一块、桌面一块），各裁成一张整屏坐标的补丁。"""
    out = []
    for y0, y1 in ((0, 124), (124, zh.height)):
        bb = ImageChops.difference(zh.crop((0, y0, zh.width, y1)), en.crop((0, y0, en.width, y1))).getbbox()
        if not bb:
            continue
        box = (bb[0], bb[1] + y0, bb[2], bb[3] + y0)
        im = Image.new("RGBA", zh.size, (0, 0, 0, 0))
        im.paste(en.crop(box), box[:2])
        out.append(im)
    return out


def png_b64(im):
    buf = io.BytesIO()
    if im.mode == "RGBA" and im.width * im.height > 400_000:
        # 图集很大：调色板化（含透明索引）后再压，体积能小一半以上，像素画本来就没几个颜色
        im = im.quantize(colors=256, method=Image.FASTOCTREE)
        im.save(buf, "PNG", optimize=True)
    else:
        im.save(buf, "PNG", optimize=True)
    return base64.b64encode(buf.getvalue()).decode(), len(buf.getvalue())


def main():
    font_sheet, font_meta = build_font()

    pk = Packer()
    people = {}
    for key, p in list(SCRIPTED.items()) + random_pool():
        exprs = EXPRS if key in SCRIPTED else POOL_EXPRS
        for e in exprs:
            pk.add(f"{key}:{e}", p.sprite(e))
        if key == "JOHN":
            for e in ("nervous", "shock", "sad", "talk", "smile"):
                pk.add(f"{key}:{e}:slip", p.sprite(e, slip=True))
        pk.add(f"photo:{key}", photo(p.sprite()), crop=False)
        coat, top = p.walker
        female = key in {"EMILY", "CAT_GIRL", "GRANDMA", "HAIKU", "OPUS", "MINIMAX", "APPELLANT_A", "APPELLANT_C"}
        if key not in SCRIPTED:
            female = p.hair in {"long", "bun"} and p.beard is None
        people[key] = {"expr": p.expr, "walker": [list(coat), list(top)], "scripted": key in SCRIPTED, "fw": 180, "sex": "F" if female else "M"}
    FISH_DIR = TOOLS / "assets" / "DAFEIYU"
    if FISH_DIR.exists():
        for e in EXPRS:
            f = FISH_DIR / "booth" / f"DAFEIYU_{e}_180x128.png"
            if f.exists():
                pk.add(f"FISH:{e}", Image.open(f).convert("RGBA"))
        f = FISH_DIR / "passport" / "DAFEIYU_photo_40x50.png"
        if f.exists():
            pk.add("photo:FISH", Image.open(f).convert("RGB"), crop=False)
        people["FISH"] = {"expr": "neutral", "walker": [[40, 52, 92], [70, 118, 198]], "scripted": True, "fw": 180}

    # 九位 AI 娘（外部生成 → tools/import_aicast.py 处理成 180x128 / 40x50）
    # 素材来源：「Ai 资源」；只有立绘裁切和量化在本地做，没有重绘
    AI_CAST = {
        "CLAUDE_AI": ([232, 222, 204], [226, 112, 52]),
        "GPT_AI": ([206, 204, 214], [232, 230, 238]),
        "QWEN_AI": ([56, 64, 110], [92, 120, 220]),
        "GROK_AI": ([60, 32, 40], [222, 186, 110]),
        "GLM_AI": ([64, 64, 72], [40, 36, 44]),
        "KIMI_AI": ([70, 78, 120], [212, 216, 232]),
        "GEMINI_AI": ([70, 52, 96], [140, 150, 235]),
    }
    for key, (coat, hair) in AI_CAST.items():
        d = TOOLS / "assets" / "AICAST" / key
        if not d.exists():
            continue
        for e in EXPRS:
            f = d / "booth" / f"{key}_{e}_180x128.png"
            if f.exists():
                pk.add(f"{key}:{e}", Image.open(f).convert("RGBA"))
        f = d / "passport" / f"{key}_photo_40x50.png"
        if f.exists():
            pk.add(f"photo:{key}", Image.open(f).convert("RGB"), crop=False)
        people[key] = {"expr": "neutral", "walker": [coat, hair], "scripted": True, "fw": 180}

    # 极简蓝鲸 Logo「证件照」（没有眼睛，极简主义）
    whale = Image.new("RGBA", (180, 128), (206, 200, 190, 255))
    dw = draw(whale)
    wb = (52, 118, 188)
    dw.ellipse([36, 40, 148, 96], fill=OUTLINE)
    dw.ellipse([38, 42, 146, 94], fill=wb)
    dw.polygon([(44, 64), (14, 44), (24, 66), (14, 90)], fill=OUTLINE)
    dw.polygon([(46, 64), (20, 50), (28, 66), (20, 84)], fill=shade(wb, 0.75))
    dw.polygon([(84, 44), (100, 24), (112, 46)], fill=OUTLINE)
    dw.polygon([(87, 44), (99, 29), (108, 45)], fill=shade(wb, 0.8))
    dw.arc([58, 70, 92, 90], 20, 160, fill=(24, 52, 86), width=3)
    pk.add("photo:FISH_WHALE", photo(whale), crop=False)

    # 拼车团：六个人挤一个窗口
    grp = cast.CARPOOL
    for e in GROUP_EXPRS:
        pk.add(f"CARPOOL:{e}", grp.sprite(e))
    pk.add("photo:CARPOOL", group_photo(grp), crop=False)
    people["CARPOOL"] = {"expr": grp.expr, "walker": [list(c) for c in grp.walker], "scripted": True, "fw": 300,
                         "extra": [[list(c) for c in q.walker] for q in grp.people[1:4]]}
    pk.add("seal", seal_sprite(), crop=False)
    pk.add("seal:en", seal_sprite("en"), crop=False)
    pk.add("emblem", emblem_sprite(), crop=False)
    pk.add("title_emblem", title_emblem(), crop=False)
    for kind in ("deny", "approve"):
        pk.add(f"stamp:{kind}", stamp_sprite(kind), crop=False)
        pk.add(f"stamp:{kind}:en", stamp_sprite(kind, "en"), crop=False)
    pk.add("crayon", CrayonPassport().image(), crop=False)
    for k in ("gate", "clock", "plane", "drumstick", "medal"):
        pk.add(f"news:{k}", news_icon(k), crop=False)
    pk.add("news:jorji", news_icon_jorji(), crop=False)
    bg = static_layer().copy()
    for i, im in enumerate(bg_patches(bg, static_layer("en"))):
        pk.add(f"bg:en:{i}", im)
    sheet, pos = pk.build()

    wbg = window_bg().copy()

    blobs = {}
    sizes = {}
    for name, im in (("font", font_sheet), ("atlas", sheet), ("bg", bg), ("win", wbg)):
        blobs[name], sizes[name] = png_b64(im)

    data = {
        "version": "2026.10.21.5",
        "font": {str(k): v for k, v in font_meta.items()},
        "sprites": pos,
        "people": people,
    }
    js = ["// 由 build_assets.py 生成，不要手改", "window.ASSETS = " + json.dumps(data, ensure_ascii=False,
                                                                                 separators=(",", ":")) + ";"]
    js.append("window.ASSET_IMAGES = {")
    for name, b in blobs.items():
        js.append(f'  {name}: "data:image/png;base64,{b}",')
    js.append("};")
    out = SITE / "assets.js"
    out.write_text("\n".join(js) + "\n", encoding="utf-8")
    print("字体字符数：", len(font_meta[12]), " 图集尺寸：", sheet.size)
    print("PNG 大小：", {k: f"{v / 1024:.0f}KB" for k, v in sizes.items()})
    print(f"assets.js：{out.stat().st_size / 1024:.0f}KB")


if __name__ == "__main__":
    main()
