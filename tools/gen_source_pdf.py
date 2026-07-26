# -*- coding: utf-8 -*-
import re
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.platypus import BaseDocTemplate, PageTemplate, Frame, Preformatted, PageBreak
from reportlab.lib.styles import ParagraphStyle

BASE = r"C:\Users\kejin\WorkBuddy\2026-07-23-22-10-18\douyin-merge-game\docs\software-copyright"
SRC = BASE + r"\source-code.md"
OUT = BASE + r"\source-code.pdf"
TOTAL_PAGES = 60

# ---- 1. 从 markdown 抽取所有代码块内容（去掉 ``` 围栏）----
text = open(SRC, encoding="utf-8").read()
lines = []
in_block = False
for ln in text.splitlines():
    if ln.strip().startswith("```"):
        in_block = not in_block
        continue
    if in_block:
        lines.append(ln)
print("抽取代码行数:", len(lines))

# ---- 2. 均分为 60 页，每页 >=50 行 ----
per = (len(lines) + TOTAL_PAGES - 1) // TOTAL_PAGES
print("每页行数:", per)

# ---- 3. 字体（STSong-Light 同时支持中文与 ASCII，避免缺字）----
pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
FONT = "STSong-Light"

style = ParagraphStyle(
    "code", fontName=FONT, fontSize=7.5, leading=9.5, leftIndent=2
)

doc = BaseDocTemplate(
    OUT, pagesize=A4,
    leftMargin=18 * mm, rightMargin=18 * mm,
    topMargin=18 * mm, bottomMargin=16 * mm,
)
frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="f")

def deco(canvas, d):
    canvas.saveState()
    canvas.setFont(FONT, 8)
    p = canvas.getPageNumber()
    # 页眉
    canvas.drawString(18 * mm, A4[1] - 12 * mm,
                      "软件名称：合成能量  V1.0   （程序鉴别材料）")
    canvas.drawRightString(A4[0] - 18 * mm, A4[1] - 12 * mm,
                           "第 %d 页 / 共 %d 页" % (p, TOTAL_PAGES))
    # 页脚
    canvas.drawCentredString(A4[0] / 2, 10 * mm,
                             "第 %d 页 / 共 %d 页" % (p, TOTAL_PAGES))
    canvas.restoreState()

doc.addPageTemplates([PageTemplate(id="main", frames=[frame], onPage=deco)])

story = []
for i in range(TOTAL_PAGES):
    chunk = lines[i * per:(i + 1) * per]
    if not chunk:
        chunk = [""]
    block = "\n".join(chunk)
    story.append(Preformatted(block, style))
    story.append(PageBreak())  # 强制每页一个代码块，保证精确 60 页

doc.build(story)
print("PDF 生成完成:", OUT)
