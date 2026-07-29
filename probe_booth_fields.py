"""
探针：确认 MapYourShow 的 getExhibitorInfo / getExhibitorNames 到底返回哪些字段，
特别是展位号（booth）和平面坐标（x/y）。

只读，只发 2~4 个请求，不做批量爬取。

凭据从环境变量读（.env 的 MYS_COOKIE），不写进代码 —— Cookie 是会话票据，
提交到仓库就永久留在 git 历史里了。代理可选：设 MYS_PROXY 才走代理，
实测直连即可。

用法：
    python3 probe_booth_fields.py
"""

import json
import os
import re
import sys
import time
from pathlib import Path

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

HERE = Path(__file__).parent
BOOTH_MAP = HERE / "public" / "booth-map" / "index.html"


def build_session():
    """凭据来自环境变量，不写进代码（Cookie 是会话票据）。"""
    cookie = os.environ.get("MYS_COOKIE", "").strip()
    if not cookie:
        sys.exit("✗ 未设置 MYS_COOKIE。在 .env 里加一行，取法见文件顶部说明。")
    s = requests.Session()
    proxy = os.environ.get("MYS_PROXY", "").strip()
    s.trust_env = False
    if proxy:
        s.proxies.update({"http": proxy, "https": proxy})
    s.headers.update({
        "accept": "application/json, text/javascript, */*; q=0.01",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        "referer": "https://tbsm26.mapyourshow.com/8_0/exhview/index.cfm",
        "user-agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                       "(KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36"),
        "x-requested-with": "XMLHttpRequest",
        "cookie": cookie,
    })
    _adapter = HTTPAdapter(max_retries=Retry(
        total=2, backoff_factor=1, status_forcelist=[429, 500, 502, 503, 504]))
    s.mount("https://", _adapter)
    s.mount("http://", _adapter)
    return s


BASE = "https://tbsm26.mapyourshow.com/8_0/exhview/02/exh-remote-proxy.cfm"


class T:  # 让下面的引用保持原样
    session = build_session()
    BASE_URL_LIST = BASE + "?action=getExhibitorNames"
    BASE_URL_INFO = BASE + "?action=getExhibitorInfo"

# 这些关键词一旦出现在字段名里，就是我们要找的东西
BOOTH_HINTS = ("booth", "stand", "space", "location", "hall", "room", "aisle")
COORD_HINTS = ("x", "y", "coord", "lat", "lng", "map", "pos", "geo")


def load_known_booths():
    """从展位图里读出 名称 → 展位号，用于交叉验证接口返回值是否可信。"""
    if not BOOTH_MAP.exists():
        print(f"  (跳过交叉验证：找不到 {BOOTH_MAP})")
        return {}
    s = BOOTH_MAP.read_text(encoding="utf-8")
    i = s.find("const ALL_BOOTHS_DATA=[")
    if i < 0:
        return {}
    j = s.find("];", i)
    arr = json.loads(s[i + len("const ALL_BOOTHS_DATA=") : j + 1])
    return {r["nm"].strip().lower(): r for r in arr if r.get("nm")}


def show(label, value, indent="      "):
    v = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    v = re.sub(r"\s+", " ", v).strip()
    if len(v) > 110:
        v = v[:110] + "…"
    print(f"{indent}{label:<26} {v}")


def classify(key):
    k = key.lower()
    if any(h in k for h in BOOTH_HINTS):
        return "BOOTH"
    # 坐标类字段名往往很短（x/y），用精确匹配避免误报
    if k in ("x", "y", "px", "py") or any(h in k for h in COORD_HINTS if len(h) > 2):
        return "COORD"
    return None


def main():
    known = load_known_booths()
    print(f"展位图已知展商: {len(known)} 家\n")

    # ── 1. 名单接口 ──────────────────────────────────────────────────
    print("── getExhibitorNames ──────────────────────────────────────")
    url = f"{T.BASE_URL_LIST}&_={int(time.time() * 1000)}"
    try:
        r = T.session.get(url, timeout=20)
        r.raise_for_status()
        names = r.json()
    except Exception as e:  # noqa: BLE001
        sys.exit(
            f"✗ 请求失败: {e}\n"
            "  最常见原因是 .env 里的 MYS_COOKIE 已过期。\n"
            "  Cookie 从浏览器 DevTools → Network → 任一 exh-remote-proxy 请求里复制。"
        )

    print(f"  返回 {len(names)} 条")
    if names:
        print(f"  单条字段: {list(names[0].keys())}")
        show("样例", names[0], "  ")
        hits = [k for k in names[0] if classify(k)]
        print(f"  → 疑似展位/坐标字段: {hits or '无'}")
    print()

    ids = [x["fieldvalue"] for x in names if x.get("fieldvalue")]
    if not ids:
        sys.exit("✗ 名单里没有 fieldvalue，无法继续")

    # ── 2. 详情接口 ──────────────────────────────────────────────────
    # 优先挑展位图里认识的展商，这样才能交叉验证展位号对不对
    picked, seen_names = [], []
    for x in names:
        if len(picked) >= 3:
            break
        nm = (x.get("fieldname") or x.get("exhname") or "").strip()
        if nm and nm.lower() in known:
            picked.append(x["fieldvalue"])
            seen_names.append(nm)
    while len(picked) < 3 and ids:
        cand = ids[len(picked)]
        if cand not in picked:
            picked.append(cand)
            seen_names.append("(展位图中无此展商)")

    print("── getExhibitorInfo ───────────────────────────────────────")
    all_keys, booth_keys, coord_keys = set(), set(), set()

    for exh_id, nm in zip(picked, seen_names):
        url = f"{T.BASE_URL_INFO}&exhID={exh_id}&showCustID=&_={int(time.time() * 1000)}"
        try:
            resp = T.session.get(url, timeout=15)
            d = resp.json()
        except Exception as e:  # noqa: BLE001
            print(f"  exhID={exh_id} 失败: {e}")
            continue
        if not d:
            print(f"  exhID={exh_id} 返回空")
            continue

        info = d[0] if isinstance(d, list) else d
        all_keys |= set(info.keys())
        print(f"\n  exhID={exh_id}  {info.get('exhname', '?')}")
        print(f"    共 {len(info)} 个字段")

        for k, v in info.items():
            tag = classify(k)
            if tag == "BOOTH":
                booth_keys.add(k)
                show(f"[展位] {k}", v)
            elif tag == "COORD":
                coord_keys.add(k)
                show(f"[坐标] {k}", v)

        # 交叉验证：接口给的展位号 == 展位图里记的展位号？
        rec = known.get((info.get("exhname") or "").strip().lower())
        if rec:
            print(f"    展位图记录: 展位 {rec['n']}  坐标 ({rec['x']},{rec['y']})  分类 {rec['c']}")
            for k in booth_keys:
                got = str(info.get(k, "")).strip()
                if got:
                    ok = "✓ 一致" if got == str(rec["n"]) else f"✗ 不一致（图上是 {rec['n']}）"
                    print(f"    → {k}={got}  {ok}")
        time.sleep(0.2)

    # ── 结论 ─────────────────────────────────────────────────────────
    print("\n" + "═" * 60)
    print("结论")
    print("═" * 60)
    print(f"  详情接口全部字段 ({len(all_keys)}):")
    print("    " + ", ".join(sorted(all_keys)))
    print()
    print(f"  展位号字段: {sorted(booth_keys) or '❌ 没有 —— 需要另找平面图接口'}")
    print(f"  坐标字段  : {sorted(coord_keys) or '❌ 没有 —— x/y 必须从平面图接口取'}")
    print()

    # TBSM2026.py 的 column_map 白名单（用于对比接口返回了多少被丢弃的字段）
    kept = {"exhname", "url", "email", "phone", "address1", "city",
            "state", "country", "description", "zip"}
    dropped = all_keys - kept
    print(f"  TBSM2026.py 当前保留 {len(all_keys & kept)} 个字段，")
    print(f"  静默丢弃 {len(dropped)} 个: {', '.join(sorted(dropped)) or '无'}")
    if booth_keys & dropped:
        print(f"\n  ⚠ 展位号字段 {sorted(booth_keys & dropped)} 接口有返回，但被 column_map 白名单过滤掉了。")
        print("    在 TBSM2026.py 的 column_map 里加一行即可捡回。")


if __name__ == "__main__":
    main()
