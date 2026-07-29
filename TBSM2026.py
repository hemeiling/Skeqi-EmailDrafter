import os
import re
import time
from datetime import datetime

import requests
import pandas as pd
from tqdm import tqdm
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# --- 1. 配置信息 ---

# 代理留空即直连。实测 MapYourShow 直连可用，所以默认不走代理；
# 需要时在 .env 里设 MYS_PROXY=http://127.0.0.1:7897
_PROXY = os.environ.get("MYS_PROXY", "").strip()
PROXIES = {"http": _PROXY, "https": _PROXY} if _PROXY else {}

# Cookie 是会话凭据，不能写进代码 —— 提交到仓库就永久留在 git 历史里了。
# 放 .env 的 MYS_COOKIE，取法：浏览器打开
#   https://tbsm26.mapyourshow.com/8_0/exhview/index.cfm
#   → DevTools → Network → 任一 exh-remote-proxy 请求 → 复制 Cookie 请求头
_COOKIE = os.environ.get("MYS_COOKIE", "").strip()

HEADERS = {
    "accept": "application/json, text/javascript, */*; q=0.01",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    "referer": "https://tbsm26.mapyourshow.com/8_0/exhview/index.cfm",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
    "x-requested-with": "XMLHttpRequest",
    "cookie": _COOKIE,
}

BASE_URL_LIST = "https://tbsm26.mapyourshow.com/8_0/exhview/02/exh-remote-proxy.cfm?action=getExhibitorNames"
BASE_URL_INFO = "https://tbsm26.mapyourshow.com/8_0/exhview/02/exh-remote-proxy.cfm?action=getExhibitorInfo"

# --- 2. 初始化 Session (带自动重试逻辑) ---
session = requests.Session()
session.trust_env = False  # 必须添加这行，强制只使用我们定义的 7897 端口
session.proxies.update(PROXIES)
session.headers.update(HEADERS)
session.proxies.update(PROXIES)
session.headers.update(HEADERS)

# 设置重试策略：针对连接失败自动尝试 3 次
retry_strategy = Retry(
    total=3,
    backoff_factor=1,
    status_forcelist=[429, 500, 502, 503, 504],
)
adapter = HTTPAdapter(max_retries=retry_strategy)
session.mount("https://", adapter)
session.mount("http://", adapter)

def clean_html(raw_html):
    """清理简介中的 HTML 标签并处理转义字符"""
    if not raw_html: return ""
    # 去除 HTML 标签
    clean = re.compile('<.*?>')
    text = re.sub(clean, '', raw_html)
    # 替换常见的 HTML 实体
    text = text.replace('&nbsp;', ' ').replace('&amp;', '&').replace('&quot;', '"')
    return text.strip()

def get_exhibitor_ids():
    """获取所有展商的 ID 列表"""
    print(f"正在通过代理端口 7897 连接...")
    try:
        url = f"{BASE_URL_LIST}&_={int(time.time()*1000)}"
        response = session.get(url, timeout=20)
        response.raise_for_status()
        data = response.json()
        # 提取 fieldvalue 且不为空的 ID
        ids = [item['fieldvalue'] for item in data if item.get('fieldvalue')]
        print(f"✅ 获取名单成功！当前共有 {len(ids)} 家展商。")
        return ids
    except Exception as e:
        print(f"❌ 无法连接到服务器。请检查：\n1. Clash 是否开启了系统代理或 TUN 模式\n2. 代理端口是否确认为 7897\n3. 错误详情: {e}")
        return []

def fetch_details(id_list):
    """遍历抓取所有展商的详细信息"""
    all_data = []
    # tqdm 提供进度条支持
    for exh_id in tqdm(id_list, desc="正在爬取详情"):
        try:
            url = f"{BASE_URL_INFO}&exhID={exh_id}&showCustID=&_={int(time.time()*1000)}"
            resp = session.get(url, timeout=15)
            if resp.status_code == 200:
                details = resp.json()
                if details and len(details) > 0:
                    info = details[0]
                    # 清洗简介
                    info['description'] = clean_html(info.get('description', ''))
                    all_data.append(info)
            
            # 稍微停顿，模拟人工点击，防止被反爬虫机制封禁
            time.sleep(0.15) 
        except Exception:
            # 单个失败跳过，保证整体运行
            continue
            
    return all_data

def main():
    # 第一步：拿 ID
    ids = get_exhibitor_ids()
    if not ids:
        return

    # 第二步：拿详情
    print("开始获取详细信息，这可能需要几分钟时间...")
    final_data = fetch_details(ids)

    # 第三步：导出 Excel
    if final_data:
        df = pd.DataFrame(final_data)
        
        # 整理列名，使其更符合阅读习惯
        column_map = {
            'exhname': '公司名称',
            'url': '官方网站',
            'email': '联系邮箱',
            'phone': '电话',
            'address1': '地址',
            'city': '城市',
            'state': '州/省',
            'country': '国家',
            'description': '公司简介',
            'zip': '邮编'
        }
        
        # 只保留我们关心的列并重命名
        present_cols = [c for c in column_map.keys() if c in df.columns]
        df = df[present_cols].rename(columns=column_map)
        today_str = datetime.now().strftime("%Y%m%d")
        
        output_file = f"North_America_Battery_Show_2026_{today_str}.xlsx"
        df.to_excel(output_file, index=False)
        print(f"\n🎉 任务完成！共保存 {len(final_data)} 条数据至: {output_file}")
    else:
        print("未获取到有效详情数据。")

if __name__ == "__main__":
    main()