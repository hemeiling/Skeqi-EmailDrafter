#!/usr/bin/env python3
"""Re-render the widest diagrams with a taller layout so text stays legible on an A4 page."""
import re, os, subprocess, struct

DOCS = "/Users/meilinghe/Library/CloudStorage/OneDrive-Personal/ClaudeCode/EmailDrafter/docs"
MD = os.path.join(DOCS, "SKEQI_AI_Email_Drafter_项目规划书.md")
OUT = os.path.join(DOCS, "diagrams")
SP = "/private/tmp/claude-501/-Users-meilinghe-Library-CloudStorage-OneDrive-Personal-ClaudeCode-EmailDrafter/80950d39-f0f3-4e44-9011-127ce2e82eb3/scratchpad"
MMD = os.path.join(SP, "mmd")

blocks = re.findall(r"```mermaid\n(.*?)```", open(MD, encoding="utf-8").read(), re.S)

# index -> transform of the first line
FIX = {5: ("flowchart LR", "flowchart TB"),
       7: ("flowchart LR", "flowchart TB"),
       11: ("flowchart LR", "flowchart TB"),
       13: ("erDiagram", "erDiagram\n    direction TB")}

def dims(p):
    return struct.unpack(">II", open(p, "rb").read()[16:24])

for i, (old, new) in FIX.items():
    code = blocks[i - 1]
    if old not in code:
        print(f"  ! diagram-{i:02d}: '{old}' not found, skipped"); continue
    code2 = code.replace(old, new, 1)
    name = f"diagram-{i:02d}"
    mmd = os.path.join(MMD, name + "-tall.mmd")
    png = os.path.join(MMD, name + "-tall.png")
    open(mmd, "w", encoding="utf-8").write(code2)
    subprocess.run([os.path.join(MMD, "node_modules/.bin/mmdc"), "-i", mmd, "-o", png,
                    "-p", os.path.join(MMD, "pptr.json"), "-b", "white", "-s", "2", "-w", "1600"],
                   capture_output=True, text=True)
    cur = os.path.join(OUT, name + ".png")
    ow, oh = dims(cur)
    if not os.path.exists(png):
        print(f"  ✗ {name}: reflow render failed, keeping original {ow}x{oh}"); continue
    nw, nh = dims(png)
    oar, nar = ow / oh, nw / nh
    # keep the reflowed version only if it is meaningfully less wide
    if nar < oar * 0.75:
        os.replace(png, cur)
        print(f"  ✓ {name}: {ow}x{oh} (AR {oar:.2f}) -> {nw}x{nh} (AR {nar:.2f})  ADOPTED")
    else:
        print(f"  – {name}: reflow AR {nar:.2f} not better than {oar:.2f}, keeping original")
