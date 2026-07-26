# -*- coding: utf-8 -*-
"""将 design-manual.md 渲染为 A4 PDF（reportlab）。

特性：
- 封面：《合成能量》V1.0 软件说明书
- 支持 #/##/### 标题、段落、加粗/斜体/行内代码、链接、图片、表格、无序列表、引用块、代码块
- 保留 mermaid 代码块作为等宽文本输出（不渲染为图）
- 图片按相对路径 ./screenshots/xxx.png 自动嵌入并缩放
- 页眉/页脚带页码
- 中文使用系统微软雅黑（失败则回退 STSong-Light）
"""
import os
import re
from PIL import Image as PILImage

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.platypus import (
    BaseDocTemplate, PageTemplate, Frame, Paragraph, Image, Spacer,
    Preformatted, Table, TableStyle, PageBreak, NextPageTemplate, HRFlowable,
    KeepTogether
)

# ------------------------------------------------------------------
# 路径配置
# ------------------------------------------------------------------
BASE = r"C:\Users\kejin\WorkBuddy\2026-07-23-22-10-18\douyin-merge-game\docs\software-copyright"
SRC = os.path.join(BASE, "design-manual.md")
OUT = os.path.join(BASE, "design-manual.pdf")

# ------------------------------------------------------------------
# 字体注册
# ------------------------------------------------------------------
def register_fonts():
    """优先注册 Windows 微软雅黑（含粗体），失败则回退 reportlab 内置 STSong-Light。"""
    yahei = r"C:\Windows\Fonts\msyh.ttc"
    yahei_bold = r"C:\Windows\Fonts\msyhbd.ttc"
    if os.path.exists(yahei) and os.path.exists(yahei_bold):
        pdfmetrics.registerFont(TTFont("YaHei", yahei, subfontIndex=0))
        pdfmetrics.registerFont(TTFont("YaHei-Bold", yahei_bold, subfontIndex=0))
        pdfmetrics.registerFontFamily(
            "YaHei",
            normal="YaHei",
            bold="YaHei-Bold",
            italic="YaHei",
            boldItalic="YaHei-Bold",
        )
        return "YaHei", "YaHei-Bold"
    # 回退
    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    return "STSong-Light", "STSong-Light"

FONT, FONT_BOLD = register_fonts()
MONO_FONT = "Courier"  # reportlab 内置等宽字体

# ------------------------------------------------------------------
# 样式定义
# ------------------------------------------------------------------
styles = {
    "cover_title": ParagraphStyle(
        "cover_title", fontName=FONT_BOLD, fontSize=32, leading=42,
        alignment=1, spaceAfter=8*mm
    ),
    "cover_subtitle": ParagraphStyle(
        "cover_subtitle", fontName=FONT, fontSize=22, leading=30,
        alignment=1, spaceAfter=6*mm
    ),
    "cover_info": ParagraphStyle(
        "cover_info", fontName=FONT, fontSize=12, leading=18,
        alignment=1, spaceAfter=2*mm
    ),
    "h1": ParagraphStyle(
        "h1", fontName=FONT_BOLD, fontSize=18, leading=26,
        spaceBefore=10*mm, spaceAfter=5*mm,
        borderWidth=0, borderColor=colors.black,
        borderPadding=0
    ),
    "h2": ParagraphStyle(
        "h2", fontName=FONT_BOLD, fontSize=15, leading=22,
        spaceBefore=8*mm, spaceAfter=4*mm
    ),
    "h3": ParagraphStyle(
        "h3", fontName=FONT_BOLD, fontSize=12.5, leading=18,
        spaceBefore=6*mm, spaceAfter=3*mm
    ),
    "h4": ParagraphStyle(
        "h4", fontName=FONT_BOLD, fontSize=11, leading=16,
        spaceBefore=4*mm, spaceAfter=2*mm
    ),
    "body": ParagraphStyle(
        "body", fontName=FONT, fontSize=11, leading=19,
        spaceBefore=1*mm, spaceAfter=2*mm,
        firstLineIndent=0
    ),
    "list": ParagraphStyle(
        "list", fontName=FONT, fontSize=11, leading=19,
        leftIndent=6*mm, spaceBefore=1*mm, spaceAfter=1*mm
    ),
    "quote": ParagraphStyle(
        "quote", fontName=FONT, fontSize=10.5, leading=18,
        leftIndent=6*mm, rightIndent=6*mm,
        textColor=colors.HexColor("#333333"),
        spaceBefore=2*mm, spaceAfter=2*mm
    ),
    "caption": ParagraphStyle(
        "caption", fontName=FONT, fontSize=9.5, leading=14,
        alignment=1, textColor=colors.HexColor("#444444"),
        spaceAfter=4*mm
    ),
    "code": ParagraphStyle(
        "code", fontName=MONO_FONT, fontSize=8, leading=10.5,
        leftIndent=4*mm, rightIndent=4*mm,
        spaceBefore=2*mm, spaceAfter=2*mm
    ),
    "table_header": ParagraphStyle(
        "table_header", fontName=FONT_BOLD, fontSize=9, leading=12,
        alignment=1
    ),
    "table_cell": ParagraphStyle(
        "table_cell", fontName=FONT, fontSize=9, leading=12,
        wordWrap="CJK"
    ),
}

# ------------------------------------------------------------------
# Markdown → 块级 token
# ------------------------------------------------------------------
def parse_markdown(text):
    """将 Markdown 文本解析为块级 token 列表。"""
    blocks = []
    lines = text.splitlines()
    i = 0
    n = len(lines)
    while i < n:
        ln = lines[i]
        s = ln.strip()

        # 代码围栏
        if s.startswith("```"):
            lang = s[3:].strip()
            i += 1
            code_lines = []
            while i < n and not lines[i].strip().startswith("```"):
                code_lines.append(lines[i])
                i += 1
            blocks.append(("code", "\n".join(code_lines), lang))
            i += 1
            continue

        # HTML 注释分页：<!-- pagebreak --> 或 <!-- new_page -->
        if s.startswith("<!--") and s.endswith("-->"):
            inner = s[4:-3].strip().lower().replace("_", "")
            if inner in ("pagebreak", "newpage", "new page"):
                blocks.append(("pagebreak",))
            i += 1
            continue

        # 分隔线
        if s == "---":
            blocks.append(("hr",))
            i += 1
            continue

        # 图片（单独一行）
        m = re.match(r"!\[(.*?)\]\((.*?)\)", s)
        if m:
            blocks.append(("image", m.group(1), m.group(2)))
            i += 1
            continue

        # 标题
        m = re.match(r"^(#{1,6})\s+(.*)$", s)
        if m:
            level = len(m.group(1))
            blocks.append(("h", level, m.group(2).strip()))
            i += 1
            continue

        # 表格
        if s.startswith("|"):
            rows = []
            while i < n and lines[i].strip().startswith("|"):
                rows.append(lines[i].strip())
                i += 1
            blocks.append(("table", rows))
            continue

        # 引用块
        if s.startswith(">"):
            parts = []
            while i < n and lines[i].strip().startswith(">"):
                parts.append(lines[i].strip()[1:].strip())
                i += 1
            blocks.append(("quote", " ".join(parts)))
            continue

        # 无序列表
        if s.startswith("- ") or s.startswith("* "):
            items = []
            while i < n:
                ss = lines[i].strip()
                if ss.startswith("- "):
                    items.append(ss[2:].strip())
                elif ss.startswith("* "):
                    items.append(ss[2:].strip())
                else:
                    break
                i += 1
            blocks.append(("list", items))
            continue

        # 空行
        if not s:
            i += 1
            continue

        # 段落（连续非空、非特殊行合并）
        para = []
        while i < n:
            ss = lines[i].strip()
            if not ss:
                break
            if ss.startswith(("#", "|", ">", "- ", "* ", "!", "```")) or ss == "---":
                break
            para.append(ss)
            i += 1
        blocks.append(("para", " ".join(para)))

    return blocks


# ------------------------------------------------------------------
# 行内格式 → reportlab XML
# ------------------------------------------------------------------
def inline_xml(text):
    """将 Markdown 行内格式转为 Paragraph 可识别的 XML。

    采用从左到右的顺序匹配，避免已生成的 <font>/<b>/<i> 标签被后续规则交叉破坏。
    """
    # 先转义 XML 特殊字符
    text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    # 匹配规则：按优先级列出 (pattern, kind)
    rules = [
        (r"`([^`]+)`", "code"),
        (r"\[([^\]]+)\]\(([^)]+)\)", "link"),
        (r"\*\*(.+?)\*\*", "bold"),
        (r"__(.+?)__", "bold"),
        (r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)", "italic"),
    ]

    out = []
    pos = 0
    while pos < len(text):
        best = None
        for pat, kind in rules:
            m = re.search(pat, text[pos:])
            if m:
                if best is None or m.start() < best[0]:
                    best = (m.start(), m.end(), m, kind)
        if best is None:
            out.append(text[pos:])
            break
        start, end, m, kind = best
        out.append(text[pos:pos + start])
        if kind == "code":
            out.append(f"<font name='{MONO_FONT}'>{m.group(1)}</font>")
        elif kind == "link":
            out.append(f'<a href="{m.group(2)}" color="blue"><u>{m.group(1)}</u></a>')
        elif kind == "bold":
            out.append(f"<b>{m.group(1)}</b>")
        elif kind == "italic":
            out.append(f"<i>{m.group(1)}</i>")
        pos += end
    return "".join(out)


# ------------------------------------------------------------------
# 块 → Flowable
# ------------------------------------------------------------------
def build_image(src, alt, max_width, max_height):
    """构造图片 Flowable，保持比例并限制最大宽高。"""
    if src.startswith(("http://", "https://")):
        return Paragraph(f"<i>[网络图片未嵌入: {alt}]</i>", styles["body"])
    # 相对 SRC 目录解析
    path = os.path.normpath(os.path.join(os.path.dirname(SRC), src))
    if not os.path.exists(path):
        return Paragraph(f"<i>[图片缺失: {alt} ({src})]</i>", styles["body"])
    try:
        with PILImage.open(path) as im:
            w, h = im.size
    except Exception as e:
        return Paragraph(f"<i>[图片读取失败: {alt} ({e})]</i>", styles["body"])
    # 按宽度缩放
    scale = min(max_width / w, 1.0)
    # 若高度仍超出页面可用高度的 70%，继续缩放
    if h * scale > max_height * 0.7:
        scale = max_height * 0.7 / h
    new_w = w * scale
    new_h = h * scale
    return Image(path, width=new_w, height=new_h)


def build_table(rows, max_width):
    """由 Markdown 表格行构造 reportlab Table。"""
    parsed = []
    for row in rows:
        # 去掉首尾的 |
        r = row.strip()
        if r.startswith("|"):
            r = r[1:]
        if r.endswith("|"):
            r = r[:-1]
        parsed.append([c.strip() for c in r.split("|")])
    if not parsed:
        return Spacer(1, 1)

    has_header = False
    body = parsed
    if len(parsed) >= 2:
        if all(re.match(r"^[-:]+$", c) for c in parsed[1]):
            has_header = True
            body = parsed[2:]

    data = []
    if has_header:
        data.append([Paragraph(inline_xml(c), styles["table_header"]) for c in parsed[0]])
    for row in body:
        data.append([Paragraph(inline_xml(c), styles["table_cell"]) for c in row])

    ncols = len(data[0]) if data else 1
    col_w = max_width / max(ncols, 1)
    t = Table(data, colWidths=[col_w] * ncols, repeatRows=1 if has_header else 0)

    ts = [
        ("FONTNAME", (0, 0), (-1, -1), FONT),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
        ("LEFTPADDING", (0, 0), (-1, -1), 2*mm),
        ("RIGHTPADDING", (0, 0), (-1, -1), 2*mm),
        ("TOPPADDING", (0, 0), (-1, -1), 1.5*mm),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1.5*mm),
    ]
    if has_header:
        ts.append(("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eeeeee")))
    t.setStyle(TableStyle(ts))
    return t


def blocks_to_story(blocks, max_width, max_height):
    """将 token 列表转换为 reportlab story。"""
    story = []
    for blk in blocks:
        typ = blk[0]
        if typ == "h":
            _, level, text = blk
            key = f"h{min(level, 4)}"
            story.append(Paragraph(inline_xml(text), styles[key]))
        elif typ == "para":
            _, text = blk
            story.append(Paragraph(inline_xml(text), styles["body"]))
        elif typ == "quote":
            _, text = blk
            story.append(Paragraph(inline_xml(text), styles["quote"]))
        elif typ == "list":
            _, items = blk
            for item in items:
                story.append(Paragraph("• " + inline_xml(item), styles["list"]))
        elif typ == "code":
            _, code, lang = blk
            if lang:
                story.append(Paragraph(f"<i>{lang}</i>", styles["caption"]))
            story.append(Preformatted(code, styles["code"]))
        elif typ == "table":
            _, rows = blk
            story.append(Spacer(1, 2*mm))
            story.append(build_table(rows, max_width))
            story.append(Spacer(1, 2*mm))
        elif typ == "image":
            _, alt, src = blk
            img = build_image(src, alt, max_width, max_height)
            story.append(Spacer(1, 2*mm))
            story.append(img)
        elif typ == "hr":
            story.append(Spacer(1, 4*mm))
            story.append(HRFlowable(width="100%", thickness=0.5, color=colors.grey))
            story.append(Spacer(1, 4*mm))
        elif typ == "pagebreak":
            story.append(PageBreak())
    return story


# ------------------------------------------------------------------
# 页眉页脚
# ------------------------------------------------------------------
def noop(canvas, doc):
    """空回调，用于封面页。"""
    pass


def draw_header_footer(canvas, doc):
    canvas.saveState()
    canvas.setFont(FONT, 9)
    p = canvas.getPageNumber()
    # 页眉
    canvas.drawString(18 * mm, A4[1] - 12 * mm, "《合成能量》V1.0 软件说明书")
    canvas.drawRightString(A4[0] - 18 * mm, A4[1] - 12 * mm, "第 %d 页" % p)
    # 页脚线
    canvas.setStrokeColor(colors.grey)
    canvas.line(18 * mm, 14 * mm, A4[0] - 18 * mm, 14 * mm)
    canvas.drawCentredString(A4[0] / 2, 9 * mm, "第 %d 页" % p)
    canvas.restoreState()


# ------------------------------------------------------------------
# 主流程
# ------------------------------------------------------------------
def main():
    text = open(SRC, encoding="utf-8").read()
    blocks = parse_markdown(text)

    doc = BaseDocTemplate(
        OUT,
        pagesize=A4,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
        topMargin=20 * mm,
        bottomMargin=18 * mm,
    )

    cover_frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="cover")
    content_frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="content")

    doc.addPageTemplates([
        PageTemplate(id="cover", frames=[cover_frame], onPage=noop),
        PageTemplate(id="content", frames=[content_frame], onPage=draw_header_footer),
    ])

    # 封面
    story = []
    story.append(Spacer(1, 70 * mm))
    story.append(Paragraph("《合成能量》", styles["cover_title"]))
    story.append(Spacer(1, 8 * mm))
    story.append(Paragraph("V1.0 软件说明书", styles["cover_subtitle"]))
    story.append(Spacer(1, 12 * mm))
    story.append(Paragraph("（软著申请用用户手册）", styles["cover_info"]))
    story.append(Spacer(1, 60 * mm))
    story.append(Paragraph("著作权人：个人", styles["cover_info"]))
    story.append(Paragraph("运行平台：抖音小游戏（tt.* 运行时）", styles["cover_info"]))
    story.append(Paragraph("文档版本：V1.0", styles["cover_info"]))

    story.append(PageBreak())
    story.append(NextPageTemplate("content"))

    # 正文
    story.extend(blocks_to_story(blocks, doc.width, doc.height))

    # 附 C：完整截图映射表（单独文件 mapping.md）
    mapping_path = os.path.join(BASE, "screenshots", "mapping.md")
    if os.path.exists(mapping_path):
        story.append(PageBreak())
        story.append(Paragraph("附 C：截图映射与候选池说明（完整版）", styles["h1"]))
        mapping_text = open(mapping_path, encoding="utf-8").read()
        story.extend(blocks_to_story(parse_markdown(mapping_text), doc.width, doc.height))

    doc.build(story)
    print("PDF 生成完成:", OUT)


if __name__ == "__main__":
    main()
