#!/usr/bin/env python3
"""生成仓库根目录的 zh-hant.js（繁體中文：繁體字 + 道地譯法）。

  pip install opencc-python-reimplemented
  python tools/gen_zh_hant.py

做法：
1. 用 node 读出 en.js 里所有中文键（= 游戏里所有原文，顺序与 en.js 一致）
2. OpenCC s2twp 逐条转成繁體（台湾用语）
3. 套 REPLACE（转换后的用词修正）和 OVERRIDES（个别句子的手工译法）

改了中文台词之后重跑一次，再跑 node tools/check_i18n.js 确认没漏。
"""
import json
import subprocess
import sys
from pathlib import Path

import opencc

SITE = Path(__file__).resolve().parent.parent

DUMP_KEYS = r"""
const fs = require('fs'), vm = require('vm');
const ctx = {};
vm.runInNewContext(fs.readFileSync('en.js', 'utf8') + '\nthis.EN = EN;', ctx);
process.stdout.write(JSON.stringify(Object.keys(ctx.EN)));
"""

# 转换之后的用词修正（长词在前，避免被短词先吃掉）
REPLACE = [
    # 台湾/香港习惯用语
    ("後臺程序", "後台程式"),
    ("程序", "程式"),
    ("後臺", "後台"),
    ("數據中心", "資料中心"),
    ("數據", "資料"),
    ("網絡", "網路"),
    ("視頻", "影片"),
    ("默認", "預設"),
    ("打印", "列印"),
    ("芯片", "晶片"),
    ("硬盤", "硬碟"),
    ("內存", "記憶體"),
    ("文件夾", "資料夾"),
    ("信息", "資訊"),
    ("接口", "介面"),
    ("網路型別", "網路類型"),
    ("型別", "類型"),
    ("賬號", "帳號"),
    ("賬戶", "帳戶"),
    ("賬單", "帳單"),
    ("點選", "點擊"),
    ("複制", "複製"),
    ("全屏", "全螢幕"),
    ("豎屏", "直式"),
    ("橫屏", "橫式"),
    ("視窗", "窗口"),
    ("到賬", "到帳"),
]

# 个别句子手工译（键 = 简体原文）：OpenCC 会把“支持”统一成“支援”，
# 但这里是“我支持某产品”的意思，台湾也写“支持”。
OVERRIDES = {
    "我支持 OpenAI API！": "我支持 OpenAI API！",
    "我支持 OpenAI 兼容接口。": "我支持 OpenAI 相容介面。",
    "民意调查：67% 支持公开，但不支持公开自己": "民意調查：67% 支持公開，但不支持公開自己",
    "竖屏也能玩，但字会很小": "手機直放也能玩，但字會很小",
}


def keys():
    out = subprocess.run(
        ["node", "-e", DUMP_KEYS], cwd=SITE, capture_output=True, text=True, encoding="utf-8", check=True
    )
    return json.loads(out.stdout)


def convert(cc, k):
    if k in OVERRIDES:
        return OVERRIDES[k]
    v = cc.convert(k)
    for a, b in REPLACE:
        v = v.replace(a, b)
    return v


def main():
    cc = opencc.OpenCC("s2twp")
    ks = keys()
    out = ["'use strict';",
           "// 繁體中文譯文：鍵是簡體中文原句，值是繁體（繁體字・道地譯法）。",
           "// 由 tools/gen_zh_hant.py 從 en.js 的鍵自動轉出（OpenCC s2twp + 用詞修正），不要手改這個檔案。",
           "// 改了簡體原文就重跑：python tools/gen_zh_hant.py",
           "",
           "const ZH_HANT = {"]
    changed = 0
    for k in ks:
        v = convert(cc, k)
        if v != k:
            changed += 1
        out.append(f"  {json.dumps(k, ensure_ascii=False)}: {json.dumps(v, ensure_ascii=False)},")
    out.append("};")
    out.append("")
    path = SITE / "zh-hant.js"
    path.write_text("\n".join(out), encoding="utf-8")
    print(f"zh-hant.js：{len(ks)} 条，其中 {changed} 条有转换，{path.stat().st_size / 1024:.0f}KB")


if __name__ == "__main__":
    sys.exit(main())
