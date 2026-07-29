#!/usr/bin/env python3
"""Convert the project plan Markdown to a management-ready .docx.

- renders mermaid blocks as pre-generated PNGs (docs/diagrams/)
- sizes every image to fit the page (wide diagrams go on landscape pages)
- replaces the hand-written TOC with a real, updatable Word TOC field
- builds a reference.docx with Chinese typography (宋体 body / 微软雅黑 headings)
"""
import os, re, struct, subprocess, shutil, zipfile, sys

ROOT = "/Users/meilinghe/Library/CloudStorage/OneDrive-Personal/ClaudeCode/EmailDrafter"
DOCS = os.path.join(ROOT, "docs")
MD = os.path.join(DOCS, "SKEQI_AI_Email_Drafter_项目规划书.md")
SP = "/private/tmp/claude-501/-Users-meilinghe-Library-CloudStorage-OneDrive-Personal-ClaudeCode-EmailDrafter/80950d39-f0f3-4e44-9011-127ce2e82eb3/scratchpad"
PANDOC = os.path.join(SP, "pandoc-3.10.1-arm64/bin/pandoc")
WORK = os.path.join(SP, "docxbuild")
OUT_DOCX = os.path.join(DOCS, "SKEQI_AI_Email_Drafter_项目规划书.docx")

# ── page geometry (twips: 1cm = 567) ──────────────────────────────────────
A4_W, A4_H = 11906, 16838          # portrait A4
MARGIN = 1134                       # 2.0 cm
PORT_W_CM = (A4_W - 2 * MARGIN) / 567
PORT_H_CM = (A4_H - 2 * MARGIN) / 567 - 1.8      # leave room for caption/heading
LAND_W_CM = (A4_H - 2 * MARGIN) / 567
LAND_H_CM = (A4_W - 2 * MARGIN) / 567 - 1.8
WIDE_AR = 2.4                       # aspect ratio above which we go landscape

os.makedirs(WORK, exist_ok=True)


def png_dims(path):
    with open(path, "rb") as f:
        return struct.unpack(">II", f.read(24)[16:24])


def fit(path, max_w, max_h):
    """Return width in cm that fits the image into (max_w, max_h)."""
    w, h = png_dims(path)
    ar = w / h
    return round(min(max_w, max_h * ar), 2), ar


# ══ 1. transform the markdown ═════════════════════════════════════════════
src = open(MD, encoding="utf-8").read()

# 1a. superscript: <sup>x</sup> -> pandoc ^x^
src = re.sub(r"<sup>(.*?)</sup>", r"^\1^", src)

# 1b. drop the hand-written TOC (pandoc emits a real Word TOC field instead)
src = re.sub(r"\n## 目录\n.*?\n---\n", "\n---\n", src, count=1, flags=re.S)

# 1c. mermaid blocks -> images, wide ones wrapped in landscape sections
LAND_OPEN = (
    '\n```{=openxml}\n<w:p><w:pPr><w:sectPr>'
    f'<w:pgSz w:w="{A4_W}" w:h="{A4_H}"/>'
    f'<w:pgMar w:top="{MARGIN}" w:right="{MARGIN}" w:bottom="{MARGIN}" w:left="{MARGIN}"'
    ' w:header="708" w:footer="708" w:gutter="0"/>'
    '</w:sectPr></w:pPr></w:p>\n```\n\n'
)
LAND_CLOSE = (
    '\n```{=openxml}\n<w:p><w:pPr><w:sectPr>'
    f'<w:pgSz w:w="{A4_H}" w:h="{A4_W}" w:orient="landscape"/>'
    f'<w:pgMar w:top="{MARGIN}" w:right="{MARGIN}" w:bottom="{MARGIN}" w:left="{MARGIN}"'
    ' w:header="708" w:footer="708" w:gutter="0"/>'
    '</w:sectPr></w:pPr></w:p>\n```\n\n'
)

report = []
counter = {"i": 0}

# figure captions — numbering must match 附录 A
DIAGRAM_TITLES = [
    "整体业务流程图", "一次完整业务旅程时序图", "系统分层架构图", "核心数据流图",
    "缓存与成本优化数据流图", "Prompt 构建流程图", "Company Tag 选择机制流程图",
    "邮件系统架构图", "邮件发送时序图", "产品路线图甘特图", "Phase 2 依赖关系图",
    "Phase 2 人员投入时间分布甘特图", "核心实体关系图（ER · 32 张表）",
    "Phase 2 目标部署架构图（Azure）",
]


def mermaid_sub(m):
    counter["i"] += 1
    i = counter["i"]
    rel = f"diagrams/diagram-{i:02d}.png"
    absp = os.path.join(DOCS, rel)
    if not os.path.exists(absp):
        report.append(f"  ! diagram-{i:02d} missing, left as code")
        return m.group(0)
    wide = png_dims(absp)[0] / png_dims(absp)[1] > WIDE_AR
    w_cm, ar = fit(absp, LAND_W_CM if wide else PORT_W_CM,
                        LAND_H_CM if wide else PORT_H_CM)
    report.append(f"  diagram-{i:02d}  AR {ar:4.2f}  {'LANDSCAPE' if wide else 'portrait '}  width {w_cm}cm")
    title = DIAGRAM_TITLES[i - 1] if i <= len(DIAGRAM_TITLES) else ""
    img = f'![图 {i}　{title}]({rel}){{width="{w_cm}cm"}}'
    return (LAND_OPEN + img + LAND_CLOSE) if wide else ("\n" + img + "\n")


src = re.sub(r"```mermaid\n.*?```", mermaid_sub, src, flags=re.S)

# 1d. size the screenshots — very tall ones were pre-sliced into page-shaped
#     parts so each part can be shown at full page width instead of shrunk.
import json
SLICES = {}
_sf = os.path.join(SP, "slices.json")
if os.path.exists(_sf):
    SLICES = json.load(open(_sf, encoding="utf-8"))


def shot_sub(m):
    alt, rel = m.group(1), m.group(2)
    absp = os.path.join(DOCS, rel)
    if not os.path.exists(absp):
        report.append(f"  ! {rel} missing"); return m.group(0)

    info = SLICES.get(rel)
    if info:
        out, n = [], info["n"]
        for k, part in enumerate(info["parts"], 1):
            pabs = os.path.join(DOCS, part["rel"])
            w_cm, par = fit(pabs, PORT_W_CM, PORT_H_CM)
            out.append(f'![{alt}（第 {k}/{n} 部分）]({part["rel"]}){{width="{w_cm}cm"}}')
        report.append(f"  {os.path.basename(rel):42s} AR {info['ar']:4.2f}  SPLIT into {n} parts @ full width")
        return "\n\n".join(out)

    w_cm, ar = fit(absp, PORT_W_CM, PORT_H_CM)
    flag = "  ⚠ narrow" if w_cm < PORT_W_CM * 0.8 else ""
    report.append(f"  {os.path.basename(rel):42s} AR {ar:4.2f}  width {w_cm}cm{flag}")
    return f'![{alt}]({rel}){{width="{w_cm}cm"}}'


src = re.sub(r"!\[([^\]]*)\]\((screenshots/[^)]+)\)", shot_sub, src)

work_md = os.path.join(WORK, "plan.md")
open(work_md, "w", encoding="utf-8").write(src)
print("\n".join(report))

# ══ 2. build the reference.docx (Chinese typography + A4) ═════════════════
ref_raw = os.path.join(WORK, "ref-default.docx")
with open(ref_raw, "wb") as f:
    subprocess.run([PANDOC, "--print-default-data-file", "reference.docx"], stdout=f, check=True)

ref_dir = os.path.join(WORK, "ref")
shutil.rmtree(ref_dir, ignore_errors=True)
with zipfile.ZipFile(ref_raw) as z:
    z.extractall(ref_dir)

styles_p = os.path.join(ref_dir, "word/styles.xml")
st = open(styles_p, encoding="utf-8").read()

BODY_LATIN, BODY_EA = "Calibri", "宋体"
HEAD_LATIN, HEAD_EA = "Calibri", "微软雅黑"
MONO = "Consolas"


def set_style(xml, style_id, latin, ea, half_pt=None, bold=None):
    """Patch rFonts / sz / b inside a given w:style block."""
    pat = re.compile(r'(<w:style [^>]*w:styleId="' + re.escape(style_id) + r'".*?</w:style>)', re.S)
    m = pat.search(xml)
    if not m:
        return xml, False
    block = m.group(1)
    if "<w:rPr>" not in block:
        block = block.replace("</w:style>", "<w:rPr></w:rPr></w:style>")
    rpr = re.search(r"<w:rPr>(.*?)</w:rPr>", block, re.S)
    inner = rpr.group(1)
    inner = re.sub(r"<w:rFonts[^/]*/>", "", inner)
    inner = re.sub(r"<w:sz w:val=\"\d+\"/>", "", inner)
    inner = re.sub(r"<w:szCs w:val=\"\d+\"/>", "", inner)
    new = (f'<w:rFonts w:ascii="{latin}" w:hAnsi="{latin}" w:eastAsia="{ea}" w:cs="{latin}"/>')
    if half_pt:
        new += f'<w:sz w:val="{half_pt}"/><w:szCs w:val="{half_pt}"/>'
    if bold:
        new += "<w:b/>"
    inner = new + inner
    block = block[:rpr.start(1)] + inner + block[rpr.end(1):]
    return xml[:m.start(1)] + block + xml[m.end(1):], True


# body 10.5pt (五号) = 21 half-points; headings scale down from pandoc defaults
plan = [
    ("Normal", BODY_LATIN, BODY_EA, 21, None),
    ("BodyText", BODY_LATIN, BODY_EA, 21, None),
    ("FirstParagraph", BODY_LATIN, BODY_EA, 21, None),
    ("Heading1", HEAD_LATIN, HEAD_EA, 32, True),
    ("Heading2", HEAD_LATIN, HEAD_EA, 26, True),
    ("Heading3", HEAD_LATIN, HEAD_EA, 23, True),
    ("Heading4", HEAD_LATIN, HEAD_EA, 21, True),
    ("Heading5", HEAD_LATIN, HEAD_EA, 21, True),
    ("Title", HEAD_LATIN, HEAD_EA, 44, True),
    ("Subtitle", HEAD_LATIN, HEAD_EA, 26, None),
    ("VerbatimChar", MONO, MONO, 19, None),
    ("Compact", BODY_LATIN, BODY_EA, 21, None),
    ("BlockText", BODY_LATIN, BODY_EA, 20, None),
    ("Caption", BODY_LATIN, HEAD_EA, 18, None),
    ("ImageCaption", BODY_LATIN, HEAD_EA, 18, None),
    ("TableCaption", BODY_LATIN, HEAD_EA, 18, None),
]
missing = []
for sid, la, ea, sz, bold in plan:
    st, ok = set_style(st, sid, la, ea, sz, bold)
    if not ok:
        missing.append(sid)

# table text a bit smaller so the many wide tables still fit
for sid in ("Table", "TableNormal"):
    st, _ = set_style(st, sid, BODY_LATIN, BODY_EA, 18, None)

# pandoc styles code blocks with "Source Code"; the default template has no such
# style, so define it explicitly (Consolas 8.5pt, light grey box, no line wrap).
if 'w:styleId="SourceCode"' not in st:
    src_style = (
        '<w:style w:type="paragraph" w:customStyle="1" w:styleId="SourceCode">'
        '<w:name w:val="Source Code"/><w:basedOn w:val="Normal"/>'
        '<w:pPr><w:keepLines/><w:spacing w:before="40" w:after="40" w:line="240" w:lineRule="auto"/>'
        '<w:shd w:val="clear" w:color="auto" w:fill="F7F7F9"/>'
        '<w:ind w:left="113" w:right="113"/></w:pPr>'
        f'<w:rPr><w:rFonts w:ascii="{MONO}" w:hAnsi="{MONO}" w:eastAsia="{BODY_EA}" w:cs="{MONO}"/>'
        '<w:sz w:val="17"/><w:szCs w:val="17"/></w:rPr></w:style>'
    )
    st = st.replace("</w:styles>", src_style + "</w:styles>")

# make the document default font Chinese-aware too
st = re.sub(r'(<w:docDefaults>.*?<w:rPr>)',
            r'\1<w:rFonts w:ascii="%s" w:hAnsi="%s" w:eastAsia="%s" w:cs="%s"/>'
            % (BODY_LATIN, BODY_LATIN, BODY_EA, BODY_LATIN), st, count=1, flags=re.S)
open(styles_p, "w", encoding="utf-8").write(st)
if missing:
    print("  (styles not present in template, skipped: " + ", ".join(missing) + ")")

# page size / margins on the reference document body
doc_p = os.path.join(ref_dir, "word/document.xml")
dx = open(doc_p, encoding="utf-8").read()
dx = re.sub(r"<w:pgSz[^/]*/>", f'<w:pgSz w:w="{A4_W}" w:h="{A4_H}"/>', dx)
dx = re.sub(r"<w:pgMar[^/]*/>",
            f'<w:pgMar w:top="{MARGIN}" w:right="{MARGIN}" w:bottom="{MARGIN}" '
            f'w:left="{MARGIN}" w:header="708" w:footer="708" w:gutter="0"/>', dx)
open(doc_p, "w", encoding="utf-8").write(dx)

# ask Word to refresh the TOC page numbers on open
set_p = os.path.join(ref_dir, "word/settings.xml")
sx = open(set_p, encoding="utf-8").read()
if "updateFields" not in sx:
    sx = sx.replace("<w:settings", "<w:settings", 1)
    sx = re.sub(r"(<w:settings[^>]*>)", r'\1<w:updateFields w:val="true"/>', sx, count=1)
open(set_p, "w", encoding="utf-8").write(sx)

ref_docx = os.path.join(WORK, "reference.docx")
if os.path.exists(ref_docx):
    os.remove(ref_docx)
with zipfile.ZipFile(ref_docx, "w", zipfile.ZIP_DEFLATED) as z:
    for base, _, files in os.walk(ref_dir):
        for fn in files:
            full = os.path.join(base, fn)
            z.write(full, os.path.relpath(full, ref_dir))

# ══ 3. run pandoc ═════════════════════════════════════════════════════════
cmd = [
    PANDOC, work_md,
    "-f", "markdown+pipe_tables+raw_attribute+superscript+raw_html+implicit_figures",
    "-t", "docx",
    "--reference-doc", ref_docx,
    "--toc", "--toc-depth=2",
    "--resource-path", DOCS,
    "--metadata", "title=SKEQI AI Email Drafter 项目规划书",
    "--metadata", "subtitle=立项与预算申请文档 v1.0",
    "--metadata", "date=2026-07-26",
    "-o", OUT_DOCX,
]
print("\nrunning pandoc…")
r = subprocess.run(cmd, capture_output=True, text=True)
print(r.stdout[-3000:] if r.stdout else "", file=sys.stderr if r.returncode else sys.stdout)
if r.stderr:
    print("pandoc stderr:\n" + r.stderr[-4000:])
if r.returncode:
    sys.exit(r.returncode)
print(f"\n✓ {OUT_DOCX}  ({os.path.getsize(OUT_DOCX)/1024/1024:.1f} MB)")
