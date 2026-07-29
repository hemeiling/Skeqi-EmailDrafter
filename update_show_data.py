#!/usr/bin/env python3
"""
从 MapYourShow 官方接口刷新 Battery Show North America 2026 的展商与展位数据。

一条命令完成：
  1. 拉展商名单 + 展位号        （search 接口，分页）
  2. 拉展位几何 STARTXY          （GetBoothByHall）
  3. 拉展商详情 网站/邮箱/地址    （getExhibitorInfo，约 5 分钟）
  4. 重建 public/booth-map/index.html 的 ALL_BOOTHS_DATA
     —— 人工整理的 zh / intro / c / p 按公司名续接，不会丢
  5. 重映射 CN_COMPANIES / DIRECT_COMP / INDIRECT_COMP / ESS_EV
     —— 这四张表按展位号索引，展位号一变就会标错展位
  6. 导出 mys_full.json 供 import_exhibitors.js 灌 CRM

用法：
    python3 update_show_data.py            # 抓取 + 重建（会先备份）
    python3 update_show_data.py --fetch-only    # 只抓取，不改文件
    python3 update_show_data.py --skip-details  # 跳过第 3 步（快，但没有网站/邮箱）

之后灌 CRM：
    node import_exhibitors.js out/mys_full.json          # 干跑
    node import_exhibitors.js out/mys_full.json --apply  # 写库

⚠ Cookie 会过期。接口靠 .env 里的 MYS_COOKIE 认证，失效后本脚本会明确报错
  并告诉你去哪里取新的（不会静默返回空数据）。
"""

import argparse
import os
import collections
import json
import re
import sys
import time
from datetime import datetime
from pathlib import Path

try:
    import requests
except ImportError:
    sys.exit("缺少依赖: pip install requests")

HERE = Path(__file__).parent
OUT = HERE / "out"
BOOTH_MAP = HERE / "public" / "booth-map" / "index.html"
HOST = "https://tbsm26.mapyourshow.com"

SEARCH = (HOST + "/8_0/ajax/remote-proxy.cfm?action=search&search=%2A"
          "&searchtype=exhibitoralpha&sortfield=title_t&sortdirection=asc&show=all")
GEOMETRY = (HOST + "/8_0/exhview/02/exh-remote-proxy.cfm"
            "?showid=TBSM26&selectedbooth=&hallid=A&action=GetBoothByHall"
            "&method=GetBoothByHall&regid=0")
DETAIL = HOST + "/8_0/exhview/02/exh-remote-proxy.cfm?action=getExhibitorInfo"

# 渲染常量 BW/BH 决定一个展位占多少格；每格英寸数必须与之配套，
# 否则展位会互相重叠或留缝。BW=BH 时展位是正方形，画布即场馆真实比例 1.95:1；
# 加大 BW 会把画布拉宽，代价是展位变成扁条（BW=52 → 20:1）。
BW, BH = 8, 8

LEGAL_SUFFIX = re.compile(
    r"(coltd|co|ltd|llc|inc|gmbh|corp|corporation|limited|ag|sa|bv|nv|srl|spa|plc|kg|as|oy|ab|pte|pty)+$")


def key(name):
    """公司名归一化：小写、去非字母数字、反复剥掉法律后缀。
    'EVE ENERGY' 与 'EVE ENERGY Co. Ltd' 必须归一到同一个键。"""
    n = re.sub(r"[^a-z0-9]", "", (name or "").lower())
    prev = None
    while n != prev:
        prev, n = n, LEGAL_SUFFIX.sub("", n)
    return n


def session():
    """凭据全部来自环境变量 —— Cookie 是会话票据，不进代码库。"""
    cookie = os.environ.get("MYS_COOKIE", "").strip()
    if not cookie:
        sys.exit(
            "✗ 未设置 MYS_COOKIE。\n"
            "  在 .env 里加一行 MYS_COOKIE=...\n"
            "  取法: 浏览器打开 " + HOST + "/8_0/exhview/index.cfm\n"
            "  → DevTools → Network → 任一 exh-remote-proxy 请求 → 复制 Cookie 请求头\n")
    s = requests.Session()
    proxy = os.environ.get("MYS_PROXY", "").strip()
    s.trust_env = False        # 实测直连即可；需要代理时设 MYS_PROXY
    if proxy:
        s.proxies.update({"http": proxy, "https": proxy})
    s.headers.update({
        "accept": "application/json, text/javascript, */*; q=0.01",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        "referer": HOST + "/8_0/exhview/index.cfm",
        "user-agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                       "(KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36"),
        "x-requested-with": "XMLHttpRequest",
        "cookie": cookie,
    })
    return s


def die_cookie(what, err):
    sys.exit(
        f"\n✗ {what} 失败: {err}\n"
        "  最可能的原因是 Cookie 过期。\n"
        "  取新 Cookie: 浏览器打开 " + HOST + "/8_0/exhview/index.cfm\n"
        "  → DevTools → Network → 任一 exh-remote-proxy 请求 → 复制 Cookie 请求头\n"
        "  → 粘贴进 TBSM2026.py 的 HEADERS['cookie']\n")


def fetch_exhibitors(s):
    """search 接口：展商名 + 展位号，每页 200。"""
    rows, start = [], 0
    while True:
        try:
            data = s.get(f"{SEARCH}&start={start}", timeout=60).json()
            block = data["DATA"]["results"]["exhibitor"]
        except Exception as e:
            die_cookie("拉取展商名单", e)
        hits, found = block.get("hit", []), int(block.get("found", 0))
        rows += [h["fields"] for h in hits]
        print(f"    {len(rows)}/{found}")
        start += len(hits)
        if not hits or start >= found:
            break
        time.sleep(0.25)

    def booths(f):
        out = []
        for b in (f.get("boothsdisplay_la") or f.get("booths_la") or []):
            b = str(b).replace("randomstring", "").strip()
            if b:
                out.append(b)
        return out

    return [{"exhid": str(f.get("exhid_l", "")), "name": (f.get("exhname_t") or "").strip(),
             "booths": booths(f), "hall": (f.get("hallid_la") or [""])[0],
             "desc": re.sub("<[^>]+>", "", f.get("exhdesc_t") or "").strip()} for f in rows]


def fetch_geometry(s):
    """GetBoothByHall：展位多边形。STARTXY 是场馆英寸坐标。"""
    try:
        d = s.get(GEOMETRY, timeout=90).json()
    except Exception as e:
        die_cookie("拉取展位几何", e)
    cols = d["COLUMNS"]
    out = {}
    for r in (dict(zip(cols, x)) for x in d["DATA"]):
        if r.get("OBJECTTYPE") != "booth" or not r.get("STARTXY"):
            continue
        n = str(r.get("BOOTHDISPLAY") or r.get("BOOTH") or "").strip()
        if not n:
            continue
        try:
            X, Y = [float(v) for v in str(r["STARTXY"]).split(",")]
        except ValueError:
            continue
        out[n] = {"X": X, "Y": Y, "exh": (r.get("EXHNAME") or "").strip(),
                  "status": r.get("BOOTHSTATUS") or "", "dims": r.get("BOOTHDIMS") or ""}
    return out


def fetch_details(s, exhibitors):
    """getExhibitorInfo：网站 / 邮箱 / 电话 / 地址。这一步最慢。"""
    strip = lambda h: (re.sub("<[^>]+>", "", h or "").replace("&nbsp;", " ")
                       .replace("&amp;", "&").replace("&quot;", '"').strip())
    out, fail = [], 0
    for i, e in enumerate(exhibitors, 1):
        try:
            d = s.get(f"{DETAIL}&exhID={e['exhid']}&showCustID=&_={int(time.time()*1000)}",
                      timeout=20).json()
            info = (d[0] if isinstance(d, list) and d else d) or {}
            out.append({**e,
                        "url": info.get("url", ""), "email": info.get("email", ""),
                        "phone": info.get("phone", ""), "city": info.get("city", ""),
                        "state": info.get("state", ""), "country": info.get("country", ""),
                        "address": info.get("address1", ""), "zip": info.get("zip", ""),
                        "linkedin": info.get("linkedin", ""),
                        "desc": strip(info.get("description")) or e.get("desc", "")})
        except Exception:
            fail += 1
            out.append(e)
        if i % 100 == 0:
            print(f"    {i}/{len(exhibitors)}  失败 {fail}")
        time.sleep(0.12)
    if fail > len(exhibitors) * 0.3:
        sys.exit(f"✗ 详情抓取失败率过高 ({fail}/{len(exhibitors)})，疑似 Cookie 失效，已中止")
    print(f"    完成，失败 {fail}")
    return out


def rebuild(geo, exhibitors):
    """用真实几何重算坐标，并把人工整理的中文内容按公司名续接过来。"""
    html = BOOTH_MAP.read_text(encoding="utf-8")
    i = html.find("const ALL_BOOTHS_DATA=[")
    j = html.find("];", i)
    old = json.loads(html[i + len("const ALL_BOOTHS_DATA="):j + 1])

    X0 = min(v["X"] for v in geo.values())
    Y0 = min(v["Y"] for v in geo.values())
    xu, yu = 120.0 / BW, 120.0 / BH

    by_booth = {str(o["n"]): o for o in old}
    by_key = collections.defaultdict(list)
    for o in old:
        if o.get("nm") and o["nm"] != "Available":
            by_key[key(o["nm"])].append(o)
    desc = {key(e["name"]): e for e in exhibitors}

    def carry(nm):
        """找出这家公司在旧数据里的记录（容忍法律后缀差异）。"""
        if not nm or nm == "Available":
            return None
        k = key(nm)
        if k in by_key:
            return by_key[k][0]
        for kk, v in by_key.items():
            if kk and (kk.startswith(k) or k.startswith(kk)) and abs(len(kk) - len(k)) <= 14:
                return v[0]
        return None

    out, src = [], collections.Counter()
    for n, g in sorted(geo.items()):
        o = by_booth.get(n)
        if o and g["exh"] and key(o.get("nm", "")) != key(g["exh"]):
            o = None                       # 展位换人了，别沿用旧记录
        if o:
            src["展位号续接"] += 1
        else:
            o = carry(g["exh"])
            src["按名字续接" if o else "全新"] += 1
        avail = g["status"] == "Available" or not g["exh"]
        rec = {"n": n, "nm": g["exh"] or "Available",
               "c": "available" if avail else (o["c"] if o else "other"),
               "p": (o["p"] if o else "ok"), "zh": (o.get("zh", "") if o else ""),
               "x": int(round((g["X"] - X0) / xu)), "y": int(round((g["Y"] - Y0) / yu)),
               "edition": (o.get("edition", "") if o else ""),
               "status": g["status"], "dims": g["dims"]}
        if o and o.get("intro"):
            rec["intro"] = o["intro"]
        else:
            e = desc.get(key(g["exh"]))
            if e and e.get("desc"):
                rec["intro_en"] = e["desc"][:400]
        out.append(rec)

    # 四张人工整理表都按展位号索引，展位号一变就会标到错误的展位上，必须重映射
    live = {key(b["nm"]): b["n"] for b in out if b["nm"] != "Available"}

    def find(nm):
        k = key(nm)
        if k in live:
            return live[k]
        for kk, v in live.items():
            if kk and (kk.startswith(k) or k.startswith(kk)) and abs(len(kk) - len(k)) <= 14:
                return v
        return None

    remap_log = []
    m = re.search(r"(CN_COMPANIES\s*=\s*)(\[.*?\])(\s*;)", html, re.S)
    cn, seen, kept = json.loads(m.group(2)), set(), []
    for c in cn:
        nn = find(c.get("name", ""))
        if nn and (nn, c.get("name")) not in seen:
            seen.add((nn, c.get("name")))
            c["booth"] = nn
            kept.append(c)
    html = html[:m.start(2)] + json.dumps(kept, ensure_ascii=False, separators=(",", ":")) + html[m.end(2):]
    remap_log.append(("CN_COMPANIES", len(cn), len(kept)))

    for name in ("DIRECT_COMP", "INDIRECT_COMP", "ESS_EV"):
        m = re.search(r"(" + name + r"\s*=\s*)(\{.*?\})(\s*;)", html, re.S)
        d = json.loads(m.group(2))
        nd = {}
        for v in d.values():
            nn = find(v.get("name", ""))
            if nn:
                nd[nn] = v
        html = html[:m.start(2)] + json.dumps(nd, ensure_ascii=False, separators=(",", ":")) + html[m.end(2):]
        remap_log.append((name, len(d), len(nd)))

    i = html.find("const ALL_BOOTHS_DATA=[")
    j = html.find("];", i)
    html = (html[:i] + "const ALL_BOOTHS_DATA="
            + json.dumps(out, ensure_ascii=False, separators=(",", ":")) + html[j + 1:])
    html = re.sub(r"const BW=\d+,BH=\d+;", f"const BW={BW},BH={BH};", html)
    return html, out, src, remap_log


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fetch-only", action="store_true", help="只抓取，不改任何文件")
    ap.add_argument("--skip-details", action="store_true", help="跳过详情抓取（快，但无网站/邮箱）")
    args = ap.parse_args()
    OUT.mkdir(exist_ok=True)
    s = session()

    print("① 展商名单 + 展位号")
    exhibitors = fetch_exhibitors(s)
    print(f"  → {len(exhibitors)} 家，其中 {sum(1 for e in exhibitors if e['booths'])} 家有展位号\n")

    print("② 展位几何")
    geo = fetch_geometry(s)
    print(f"  → {len(geo)} 个展位\n")

    if args.skip_details:
        full = exhibitors
        print("③ 展商详情 —— 已跳过\n")
    else:
        print("③ 展商详情（约 5 分钟）")
        full = fetch_details(s, exhibitors)
        print()

    (OUT / "mys_full.json").write_text(json.dumps(full, ensure_ascii=False), encoding="utf-8")
    print(f"  已写出 {OUT/'mys_full.json'}  （供 import_exhibitors.js 使用）")
    print(f"  网站 {sum(1 for r in full if r.get('url'))} | 邮箱 {sum(1 for r in full if r.get('email'))}\n")

    if args.fetch_only:
        print("--fetch-only：未改动展位图。")
        return

    print("④ 重建展位图")
    html, booths, src, remap = rebuild(geo, full)

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = OUT / f"booth-map.{stamp}.html"
    backup.write_text(BOOTH_MAP.read_text(encoding="utf-8"), encoding="utf-8")
    BOOTH_MAP.write_text(html, encoding="utf-8")

    cells = collections.Counter((b["x"], b["y"]) for b in booths)
    dup = sum(c - 1 for c in cells.values() if c > 1)
    w = max(b["x"] for b in booths) + BW
    h = max(b["y"] for b in booths) + BH
    print(f"  展位 {len(booths)} | 坐标冲突 {dup} | 画布 {w}×{h} → 宽高比 {w/h:.1f}:1")
    print(f"  续接来源 {dict(src)}")
    print(f"  保留中文名 {sum(1 for b in booths if b['zh'])} | 中文简介 {sum(1 for b in booths if b.get('intro'))}")
    for name, before, after in remap:
        print(f"  {name}: {before} → {after}")
    print(f"  备份 {backup}")
    if dup:
        print(f"  ⚠ 有 {dup} 处坐标冲突，检查 BW/BH 与每格英寸数是否配套")

    print("\n完成。接着灌 CRM：")
    print(f"  node import_exhibitors.js {OUT/'mys_full.json'}          # 干跑")
    print(f"  node import_exhibitors.js {OUT/'mys_full.json'} --apply  # 写库")


if __name__ == "__main__":
    main()
