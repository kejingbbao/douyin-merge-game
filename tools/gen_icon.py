#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
生成《合成能量》抖音小游戏图标 (600x600 PNG)
设计：2 + 2 合成 4 的合并概念 + 能量光爆 + 底部游戏名
合规：硬边方图(无圆角)、无缩放水印、无二维码、<=6M
"""
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFont

W = H = 600
OUT = os.path.join(os.path.dirname(__file__), "..", "assets", "icon-600x600.png")
OUT = os.path.abspath(OUT)

# ---------- 背景：对角渐变（深空蓝 -> 青绿，呼应"能量"） ----------
top = np.array([22, 28, 64], dtype=np.float32)    # 深靛
bot = np.array([16, 78, 110], dtype=np.float32)   # 深青
yy, xx = np.mgrid[0:H, 0:W]
t = (xx + yy) / (W + H)                            # 0..1 对角线
grad = (top * (1 - t)[..., None] + bot * t[..., None]).astype(np.uint8)
img = Image.fromarray(grad, "RGB")
draw = ImageDraw.Draw(img)

# ---------- 字体 ----------
cn_font = None
for p in ["C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/simhei.ttf",
          "C:/Windows/Fonts/STKAITI.TTF", "C:/Windows/Fonts/msyhbd.ttc"]:
    if os.path.exists(p):
        try:
            cn_font = ImageFont.truetype(p, 60)
            break
        except Exception:
            continue
num_font = cn_font
if num_font is None:
    num_font = ImageFont.load_default()

# ---------- 圆角方块工具 ----------
def round_rect(d, x, y, w, h, r, fill, outline=None, width=0):
    d.rounded_rectangle([x, y, x + w, y + h], radius=r, fill=fill,
                        outline=outline, width=width)

# 方块配色（2048 风：暖橙 tile）
TILE_A = (243, 146, 55)   # "2" 橙
TILE_B = (243, 176, 55)   # "4" 金橙
PANEL = (20, 24, 48)

cx = W // 2
# 左方块 "2"
Lx, Ly, S = 70, 180, 150
round_rect(draw, Lx, Ly, S, S, 26, TILE_A)
draw.text((Lx + S/2, Ly + S/2), "2", font=num_font, fill=(255, 255, 255),
          anchor="mm")
# 右方块 "4"
Rx = W - 70 - S
round_rect(draw, Rx, Ly, S, S, 26, TILE_B)
draw.text((Rx + S/2, Ly + S/2), "4", font=num_font, fill=(255, 255, 255),
          anchor="mm")

# ---------- 中间能量光爆 ----------
mx, my = cx, Ly + S / 2
# 光晕
glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
for i in range(60, 0, -4):
    alpha = int(140 * (i / 60))
    gd.ellipse([mx - i, my - i, mx + i, my + i], fill=(255, 220, 120, alpha))
    gd.ellipse([mx - i*0.7, my - i*0.7, mx + i*0.7, my + i*0.7],
               fill=(120, 230, 255, int(alpha*0.6)))
# 放射线
import math
for k in range(12):
    ang = k * (math.pi / 6)
    r1, r2 = 40, 120
    gd.line([mx + r1*math.cos(ang), my + r1*math.sin(ang),
             mx + r2*math.cos(ang), my + r2*math.sin(ang)],
            fill=(255, 240, 180, 200), width=4)
img = Image.alpha_composite(img.convert("RGBA"), glow).convert("RGB")
draw = ImageDraw.Draw(img)

# 中心小火花 "+"
draw.text((mx, my), "+", font=num_font, fill=(255, 255, 255), anchor="mm")

# ---------- 底部游戏名 ----------
if cn_font:
    draw.text((cx, 470), "合成能量", font=cn_font, fill=(255, 255, 255),
              anchor="mm")
    draw.text((cx, 540), "数字合成 · 实时对战",
              font=ImageFont.truetype(cn_font.path, 30) if hasattr(cn_font, "path") else num_font,
              fill=(180, 220, 255), anchor="mm")

# ---------- 校验 ----------
img.save(OUT, "PNG")
with Image.open(OUT) as chk:
    print("saved:", OUT)
    print("size:", chk.size, "mode:", chk.mode)
    print("bytes:", os.path.getsize(OUT))
