#!/usr/bin/env python3
"""Extract mermaid blocks from the project plan and render each to PNG."""
import re, os, subprocess, sys, struct

DOCS = "/Users/meilinghe/Library/CloudStorage/OneDrive-Personal/ClaudeCode/EmailDrafter/docs"
MD = os.path.join(DOCS, "SKEQI_AI_Email_Drafter_项目规划书.md")
OUT = os.path.join(DOCS, "diagrams")
SP = "/private/tmp/claude-501/-Users-meilinghe-Library-CloudStorage-OneDrive-Personal-ClaudeCode-EmailDrafter/80950d39-f0f3-4e44-9011-127ce2e82eb3/scratchpad"
MMD = os.path.join(SP, "mmd")

os.makedirs(OUT, exist_ok=True)
src = open(MD, encoding="utf-8").read()
blocks = re.findall(r"```mermaid\n(.*?)```", src, re.S)
print(f"found {len(blocks)} mermaid blocks")

for i, code in enumerate(blocks, 1):
    name = f"diagram-{i:02d}"
    mmd = os.path.join(MMD, name + ".mmd")
    png = os.path.join(OUT, name + ".png")
    open(mmd, "w", encoding="utf-8").write(code)
    kind = code.strip().split("\n")[0].strip()
    # gantt/sequence render better with a wider canvas
    width = "1800" if kind.startswith(("gantt", "sequenceDiagram")) else "1600"
    cmd = [os.path.join(MMD, "node_modules/.bin/mmdc"), "-i", mmd, "-o", png,
           "-p", os.path.join(MMD, "pptr.json"), "-b", "white", "-s", "2", "-w", width]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if not os.path.exists(png):
        print(f"  ✗ {name} ({kind}) FAILED")
        print("    stdout:", r.stdout.strip()[:400])
        print("    stderr:", r.stderr.strip()[:600])
        continue
    d = open(png, "rb").read()[16:24]
    w, h = struct.unpack(">II", d)
    print(f"  ✓ {name} ({kind}) {w}x{h}")
