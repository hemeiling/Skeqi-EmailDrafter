/* ══════════════════════════════════════════════════════════════════════
   Bilingual UI · 双语界面

   One convention, applied everywhere: English first, Chinese second, with
   the Chinese rendered smaller and lighter so a control reads as one label
   rather than two competing ones —  "Find contacts 查找联系人".

   Why a dictionary pass rather than editing ~690 strings in place:

   · It covers text this file never sees. Most of the CRM's chrome — table
     rows, status pills, empty states, plan previews, toasts — is built by
     app.js at render time, so hand-editing the HTML would localise the
     shell and leave the working surface English.
   · Translations live in one list instead of being scattered across two
     large files, so a wording change is a one-line edit and an audit is a
     matter of reading a single table.
   · It works in both directions. Some labels were Chinese-only
     ("在展位图中定位", "不限展会"); those gain English by the same mechanism.

   SAFETY — business data is never touched. Only text that EXACTLY matches
   a dictionary entry is ever rewritten, so company names, contact names,
   job titles, tags, AI research and email bodies pass through untouched
   because they simply do not match. On top of that, whole subtrees can opt
   out with data-no-i18n, which is applied to the regions that render user
   and AI content, in case a company is ever literally named "Contacts".
   ══════════════════════════════════════════════════════════════════════ */

/* Each entry is [English, 中文]. Keys must match the rendered text exactly,
   trimmed. Order is irrelevant; grouping is purely for readability. */
const I18N_PAIRS = [
  // ── App shell / navigation ──
  ["Home", "首页概览"],
  ["Booth map", "展会地图"],
  ["Account research", "账户研究报告"],
  ["AI email drafting", "AI 邮件起草"],
  ["CRM", "CRM 管理"],
  ["Customer intelligence", "客户情报"],
  ["Analytics", "数据分析"],
  ["Settings", "设置中心"],
  ["Exhibitor outreach", "展商拓展"],

  // ── Exhibitor Outreach ──
  ["Download", "下载"],
  ["Export current view", "导出当前视图"],
  ["Export all exhibitors", "导出全部展商"],
  ["Exhibitors", "展商"],
  ["With contacts", "有联系人"],
  ["With email", "有邮箱"],
  ["Drafted", "已起草"],
  ["Needs outreach", "待拓展"],
  ["exhibitors", "家展商"],
  ["exhibitor", "家展商"],
  ["Booth", "展位"],
  ["Classification", "分类"],
  ["Outreach status", "拓展状态"],
  ["Actions", "操作"],
  ["Draft email", "起草邮件"],
  ["View/Edit draft", "查看/编辑草稿"],
  ["Mark sent", "标记已发送"],
  ["Save as sent", "保存为已发送"],
  ["Undo sent", "撤销已发送"],
  ["View emails", "查看邮件"],
  ["Reveal & draft", "揭示并起草"],
  ["Open in CRM", "在 CRM 中打开"],
  ["Find contacts in CRM", "在 CRM 中查找联系人"],
  ["Hide contacts", "收起联系人"],
  ["★ Best contact", "★ 最佳联系人"],
  ["Needs draft", "待起草"],
  ["Unmatched", "未匹配"],
  ["No contact", "无联系人"],
  ["No email", "无邮箱"],
  ["Not sent", "未发送"],
  ["Email locked", "邮箱未揭示"],
  ["Withdrawn", "已退展"],
  ["Include withdrawn", "包含已退展"],
  ["Clear filters", "清除筛选"],
  ["Done", "完成"],
  ["Sort", "排序"],
  ["‹ Previous", "上一页"],
  ["Next ›", "下一页"],
  ["Scan business card", "扫描名片"],
  ["AI usage", "AI 使用"],
  ["Collapse sidebar", "收起侧栏"],
  ["View all", "查看全部"],

  // ── CRM object tabs & page header ──
  ["Research company", "研究公司"],
  ["Import contacts", "导入联系人"],
  ["Add more contacts", "补充联系人"],
  ["New contact", "新建联系人"],
  ["Target total", "目标总数"],
  ["Append contacts", "追加联系人"],
  ["Nothing to append", "无需追加"],
  ["Type to search saved companies", "输入以搜索已保存的公司"],
  ["The number you want this company to end up with. Only the difference is fetched.",
   "你希望该公司最终达到的联系人数量，系统只获取差额部分。"],
  ["Already at or above the target — raise it to pull more.", "已达到或超过目标数量 —— 调高目标即可获取更多。"],
  ["Contacts", "联系人"],
  ["Companies", "公司"],
  ["Find contacts", "查找联系人"],
  ["Add contact", "添加联系人"],
  ["Import email", "导入邮件"],
  ["New company", "新建公司"],
  ["Refresh", "刷新"],
  ["Search", "搜索"],
  ["Searching…", "搜索中…"],

  // ── Filter rail ──
  ["Filters", "筛选"],
  ["Clear", "清除"],
  ["Clear all", "全部清除"],
  ["Company", "公司"],
  ["Contact", "联系人"],
  ["Trade show", "展会"],
  ["Category", "分类"],
  ["More filters", "更多筛选"],
  ["Event", "展会活动"],
  ["Industry", "行业"],
  ["Follow-up status", "跟进状态"],
  ["Salesperson", "销售负责人"],
  ["Department", "部门"],
  ["Seniority", "职级"],
  ["Apply filters", "应用筛选"],
  ["Matching companies", "匹配公司"],
  ["Merge selected", "合并所选"],
  ["All shows", "不限展会"],
  ["Locate on the booth map", "在展位图中定位"],
  ["Fill into search", "填入搜索框"],
  ["View contacts", "查看联系人"],
  ["No matching companies", "没有匹配的公司"],
  ["No trade shows under the current filters", "上游筛选下没有展会数据"],
  ["No categories in this show", "该展会下暂无分类"],
  ["Pick a trade show first", "先选择一个展会"],

  // ── Contacts table ──
  ["Activity", "互动记录"],
  ["Email", "邮箱"],
  ["Tags", "标签"],
  ["Status", "状态"],
  ["Draft", "草稿"],
  ["Source", "来源"],
  ["Details", "详情"],
  ["View", "查看"],
  ["Redraft", "重新生成"],
  ["Draft Email", "生成邮件"],
  ["Enrich Email", "补全邮箱"],
  ["No draft", "无草稿"],
  ["Saved", "已保存"],
  ["No interactions", "暂无互动"],
  ["Checking…", "检查中…"],
  ["No contacts match", "没有匹配的联系人"],
  ["No contacts yet", "暂无联系人"],
  ["Select all on this page", "全选本页"],
  ["← Prev", "← 上一页"],
  ["Next →", "下一页 →"],

  // ── Follow-up statuses (also used as select options) ──
  ["not contacted", "未联系"],
  ["contacted", "已联系"],
  ["replied", "已回复"],
  ["meeting scheduled", "已约会面"],
  ["closed", "已结束"],
  ["Not contacted", "未联系"],
  ["Contacted", "已联系"],
  ["Replied", "已回复"],
  ["Meeting scheduled", "已约会面"],
  ["Closed", "已结束"],
  ["Any", "全部"],

  // ── Bulk action bar ──
  ["Draft emails", "批量生成邮件"],
  ["Delete", "删除"],
  ["Clear selection", "取消选择"],
  ["Draft options", "生成选项"],

  // ── Draft generation options ──
  ["Length", "篇幅"],
  ["Ultra short", "极简"],
  ["Short", "简短"],
  ["Medium", "适中"],
  ["Long", "详细"],
  ["Custom", "自定义"],
  ["Tone", "语气"],
  ["Professional", "专业"],
  ["Warm", "亲和"],
  ["Direct", "直接"],
  ["Consultative", "顾问式"],
  ["Formal", "正式"],
  ["Language", "语言"],
  ["English", "英文"],
  ["Match recipient", "匹配收件人"],
  ["Call to action", "行动号召"],
  ["Default for this type", "按邮件类型默认"],
  ["Book a call", "预约通话"],
  ["Meet in person", "当面会面"],
  ["Send materials", "发送资料"],
  ["Just ask a reply", "仅请求回复"],
  ["No ask", "不作请求"],
  ["Tone, language & call to action", "语气、语言与行动号召"],

  // ── Find contacts dialog ──
  ["Company name(s)", "公司名称"],
  ["(comma-separated for multiple)", "（多个用逗号分隔）"],
  ["Target contacts per company", "每家公司目标联系人数"],
  ["Maximum new contacts (all companies)", "本次最多新增联系人数"],
  ["How many you want to end up with. Contacts you already have count toward it.",
   "你希望最终达到的数量，已有联系人计入其中。"],
  ["Safety cap on this one run.", "本次运行的安全上限。"],
  ["Append", "追加"],
  ["Full refresh", "完全刷新"],
  ["— keep everything, add only what's missing", "— 保留全部，仅补充缺少的部分"],
  ["— re-query Apollo for contacts already saved", "— 对已保存的联系人重新查询 Apollo"],
  ["Target departments", "目标部门"],
  ["What this will do", "本次操作预览"],
  ["now", "当前"],
  ["target", "目标"],
  ["to retrieve", "将获取"],
  ["to re-query", "将重新查询"],
  ["Searches Apollo and saves matching contacts into your CRM for review — it does not draft emails.",
   "搜索 Apollo 并将匹配的联系人保存到 CRM 供你审阅 —— 不会自动生成邮件。"],

  // ── Companies list & account record ──
  ["AI analysis", "AI 分析"],
  ["Next step", "下一步"],
  ["All", "全部"],
  ["No contacts", "无联系人"],
  ["Not analyzed", "未分析"],
  ["Analyzed", "已分析"],
  ["Tags need review", "标签待确认"],
  ["Ready", "就绪"],
  ["Run AI analysis", "运行 AI 分析"],
  ["Add contacts", "添加联系人"],
  ["Review tags", "确认标签"],
  ["Review the suggested tags", "确认 AI 建议的标签"],
  ["Refresh the analysis", "刷新 AI 分析"],
  ["Ready to work", "可以开始跟进"],
  ["← Companies", "← 返回公司列表"],
  ["No companies match", "没有匹配的公司"],
  ["Company intelligence", "公司情报"],
  ["Generate AI Analysis", "生成 AI 分析"],
  ["Refresh AI Analysis", "刷新 AI 分析"],
  ["Generate AI analysis", "生成 AI 分析"],
  ["Mark Reviewed", "标记为已确认"],
  ["Business description (AI research)", "业务描述（AI 研究）"],
  ["Preview import", "预览导入"],
  ["View in CRM", "在 CRM 中查看"],
  ["Get more contacts", "获取更多联系人"],
  ["from the Contact Engine", "来自联系人引擎"],
  ["with email", "含邮箱"],
  ["Saved · reviewed", "已保存 · 已确认"],
  ["Saved · needs review", "已保存 · 待确认"],
  ["Analysis stale", "分析已过期"],
  ["AI suggested", "AI 建议"],
  ["Confirmed", "已确认"],
  ["Manual", "手动添加"],
  ["Needs review", "待确认"],
  ["Rejected", "已拒绝"],

  // ── New company dialog ──
  ["Company name", "公司名称"],
  ["Chinese name", "中文名称"],
  ["Website", "官网"],
  ["(required)", "（必填）"],
  ["(optional)", "（选填）"],
  ["(optional — helps the AI research it)", "（选填 —— 有助于 AI 研究）"],
  ["Create and open", "创建并打开"],
  ["Cancel", "取消"],
  ["Creates a CRM account you can analyze and staff with contacts straight away.",
   "创建一个 CRM 账户，可立即进行分析并添加联系人。"],

  // ── Draft / email modal ──
  ["Drafts for this Contact", "该联系人的草稿"],
  ["Additional instructions", "补充说明"],
  ["Generate Draft", "生成草稿"],
  ["+ Add Existing Email", "+ 添加已有邮件"],
  ["Manage Attachment Library", "管理附件库"],
  ["Sent / Imported Emails", "已发送 / 已导入邮件"],
  ["Subject", "主题"],
  ["Body", "正文"],
  ["Send", "发送"],
  ["Save", "保存"],
  ["Close", "关闭"],
  ["Attachments", "附件"],
  ["Attachment Library", "附件库"],
  ["Prompt Inspector", "提示词检查器"],
  ["Reset this section", "重置本节"],
  ["Reset all sections", "重置所有分节"],
  ["View / Edit Tags", "查看 / 编辑标签"],

  // ── Placeholders (matched and rewritten as "English 中文") ──
  // Kept short: the field is already wide, and a doubled long sentence is
  // exactly the clutter bilingual UI is accused of.
  ["Search contacts and companies", "搜索联系人与公司"],
  ["Filter by department…", "按部门筛选…"],
  ["Filter by seniority…", "按职级筛选…"],
  ["Salesperson name", "销售负责人姓名"],
  ["Additional instructions (optional)", "补充说明（选填）"],
  ["e.g. mention our new automation line", "例如：提及我们的新自动化产线"],
  ["e.g. Battery Show", "例如：Battery Show"],
  ["e.g. Battery", "例如：电池"],
  ["e.g. CATL, BYD, Tesla", "例如：CATL, BYD, Tesla"],
  ["e.g. Acme Battery Materials", "例如：Acme Battery Materials"],
  ["tags…", "标签…"],

  // ── Import plan preview ──
  ["Append only.", "仅追加。"],
  ["Full refresh.", "完全刷新。"],
  ["Import contacts", "导入联系人"],
  ["Cancel import", "取消导入"],
  ["No Apollo requests — nothing to fetch", "无需请求 Apollo —— 没有需要获取的内容"],

  // ── Contact detail dialog ──
  ["Event / Trade show", "展会活动"],
  ["Booth number", "展位号"],
  ["Meeting date", "会面日期"],
  ["Meeting notes", "会面记录"],
  ["Interest level", "意向程度"],
  ["Products discussed", "已讨论产品"],
  ["Assigned salesperson", "指派销售"],
  ["Timeline", "互动时间线"],
  ["Save details", "保存详情"],

  // ── AI email drafting view ──
  ["Upload Company List (CSV or Excel)", "上传公司列表（CSV 或 Excel）"],
  ["Click to browse", "点击选择文件"],
  ["or drag-and-drop your CSV/Excel file here", "或将 CSV / Excel 文件拖放到此处"],
  ["Search Selected", "搜索所选"],
  ["Show all", "显示全部"],
  ["Force refresh", "强制刷新"],
  ["Select all", "全选"],

  // ── Customer intelligence view ──
  ["Customer Intelligence", "客户情报"],
  ["SKQ Capability Matrix", "SKQ 能力矩阵"],
  ["Duplicate companies", "重复公司"],
  ["Select a company…", "选择公司…"],
  ["Refresh list", "刷新列表"],
  ["Select a company to view and review its customer intelligence.",
   "选择一家公司以查看并确认其客户情报。"],

  // ── Analytics view ──
  ["AI Usage & Cost", "AI 用量与成本"],
  ["Today", "今天"],
  ["Last 7 days", "近 7 天"],
  ["Last 30 days", "近 30 天"],
  ["This month", "本月"],
  ["Previous month", "上月"],
  ["This year", "今年"],
  ["All time", "全部时间"],
  ["Custom…", "自定义…"],
  ["Export CSV", "导出 CSV"],

  // ── Settings · profile & tags ──
  ["Your Profile", "个人资料"],
  ["Your Name", "姓名"],
  ["Your Title", "职位"],
  ["Your Company", "公司"],
  ["(used to personalise outreach emails)", "（用于个性化外联邮件）"],
  ["Display language", "显示语言"],
  ["English only", "仅英文"],
  ["Tag Prioritization", "标签优先级"],
  ["Maximum tags", "标签数量上限"],
  ["(0 = no limit)", "（0 = 不限）"],
  ["Minimum relevance", "最低相关度"],
  ["Always include", "始终包含"],
  ["(comma-separated tag names)", "（标签名，用逗号分隔）"],
  ["Prefer technical tags (product scope, cell format)", "优先技术类标签（产品范围、电芯形态）"],
  ["Prefer business tags (segment, applications, priorities)", "优先业务类标签（板块、应用、优先级）"],
  ["Prompt Analytics", "提示词分析"],

  // ── Settings · organization email ──
  ["Organization Email Configuration", "组织邮箱配置"],
  ["Configured", "已配置"],
  ["Auto detect", "自动检测"],
  ["Email address (for detection)", "邮箱地址（用于检测）"],
  ["Provider", "服务商"],
  ["Email provider", "邮箱服务商"],
  ["Choose a provider…", "选择服务商…"],
  ["Custom SMTP + IMAP", "自定义 SMTP + IMAP"],
  ["Organization email domain", "组织邮箱域名"],
  ["Display name (optional)", "显示名称（选填）"],
  ["SMTP (outgoing)", "SMTP（发件）"],
  ["IMAP (incoming)", "IMAP（收件）"],
  ["SMTP host", "SMTP 服务器"],
  ["SMTP port", "SMTP 端口"],
  ["SMTP encryption", "SMTP 加密方式"],
  ["SMTP auth method", "SMTP 认证方式"],
  ["IMAP host", "IMAP 服务器"],
  ["IMAP port", "IMAP 端口"],
  ["IMAP encryption", "IMAP 加密方式"],
  ["IMAP auth method", "IMAP 认证方式"],
  ["None", "无"],
  ["Password / authorization code", "密码 / 授权码"],
  ["OAuth", "OAuth 授权"],
  ["Folders", "邮件文件夹"],
  ["Inbox", "收件箱"],
  ["Sent", "已发送"],
  ["Drafts", "草稿箱"],
  ["Archive", "归档"],
  ["Trash", "已删除"],
  ["Sync & limits", "同步与限额"],
  ["Sync interval (seconds)", "同步间隔（秒）"],
  ["Max attachment size (MB)", "附件大小上限（MB）"],
  ["Hourly sending limit", "每小时发送上限"],
  ["Daily sending limit", "每日发送上限"],
  ["IMAP IDLE support", "支持 IMAP IDLE"],
  ["Server IP allowlisting required", "需要服务器 IP 白名单"],
  ["App password / authorization code required", "需要应用专用密码 / 授权码"],
  ["Domain authentication (DNS)", "域名认证（DNS）"],
  ["Save Configuration", "保存配置"],
  ["Test SMTP server", "测试 SMTP 服务器"],
  ["Test IMAP server", "测试 IMAP 服务器"],
  ["Check domain DNS", "检查域名 DNS"],

  // ── Settings · my mailbox ──
  ["My Email Account", "我的邮箱账户"],
  ["Connected", "已连接"],
  ["Organization provider configured", "组织服务商已配置"],
  ["SMTP settings configured", "SMTP 设置已配置"],
  ["Authorized email domain", "授权邮箱域名"],
  ["Mailbox email", "邮箱地址"],
  ["Password / app password", "密码 / 应用专用密码"],
  ["Connection verified", "连接已验证"],
  ["Email address", "邮箱地址"],
  ["Sender name", "发件人名称"],
  ["Reply-to address", "回复地址"],
  ["Mailbox username", "邮箱用户名"],
  ["Authentication method", "认证方式"],
  ["App password", "应用专用密码"],
  ["Mailbox synchronization enabled", "已启用邮箱同步"],
  ["Save without testing", "不测试直接保存"],
  ["Send Test Email", "发送测试邮件"],
  ["Disconnect", "断开连接"],

  // ── Settings · signature & preferences ──
  ["Email Signature & Sending Preferences", "邮件签名与发送偏好"],
  ["Email signature", "邮件签名"],
  ["Default CC", "默认抄送"],
  ["Default BCC", "默认密送"],
  ["Default reply-to", "默认回复地址"],
  ["Default sending mode", "默认发送方式"],
  ["Save as draft", "保存为草稿"],
  ["Send immediately", "立即发送"],
  ["Schedule", "定时发送"],
  ["Preferred sync frequency", "同步频率"],
  ["Real-time (IDLE)", "实时（IDLE）"],
  ["Normal (5 min)", "常规（5 分钟）"],
  ["Low (30 min)", "较低（30 分钟）"],
  ["Manual only", "仅手动"],
  ["Confirm before sending", "发送前确认"],
  ["Save preferences", "保存偏好"],
  ["Connection Test History", "连接测试记录"],
  ["When", "时间"],
  ["Test", "测试项"],
  ["Target", "目标"],
  ["Result", "结果"],
  ["Detail", "详情"],
  ["No tests run yet.", "尚未运行任何测试。"],

  // ── Settings · remaining prose and icon buttons ──
  // Emoji are part of the rendered text, so they are part of the key.
  ["🔎 Auto Detect Provider", "🔎 自动检测服务商"],
  ["🔌 Test Connection", "🔌 测试连接"],
  ["⚙️ Advanced Settings — SMTP / IMAP servers, folders, limits, DNS",
   "⚙️ 高级设置 —— SMTP / IMAP 服务器、文件夹、限额、DNS"],
  ["⚙️ Advanced — sender name, reply-to, username, auth method",
   "⚙️ 高级 —— 发件人名称、回复地址、用户名、认证方式"],
  ["The AI always receives the English tag names for consistency; this only changes what you see.",
   "为保持一致性，AI 始终接收英文标签名；此设置仅影响你看到的显示。"],
  ["— tune how saved company tags feed email drafting, no code changes",
   "—— 调整已保存的公司标签如何参与邮件生成，无需改动代码"],
  ["— admin / IT only · set once for the whole team",
   "—— 仅限管理员 / IT · 全团队配置一次"],
  ["— connect your authorized @ mailbox", "—— 连接你已授权的邮箱"],
  ["(auto-filled; override only if your provider differs)",
   "（自动填充；仅当你的服务商不同时才需修改）"],
  ["Saving valid servers enables sending automatically — individual users still connect their own mailbox in “My Email Account.” Server/DNS tests above are optional diagnostics.",
   "保存有效的服务器配置后即可自动启用发送 —— 每位用户仍需在「我的邮箱账户」中连接自己的邮箱。上方的服务器 / DNS 测试为可选诊断。"],
  ["provided", "已填写"],
  ["GoDaddy Workspace Email", "GoDaddy 企业邮箱"],

  // ── Common actions & states ──
  ["Save changes", "保存修改"],
  ["Confirm", "确认"],
  ["Yes", "是"],
  ["No", "否"],
  ["Loading…", "加载中…"],
  ["Usage data not loaded yet.", "用量数据尚未加载。"],
  ["Load usage data", "加载用量数据"],
  ["Nothing yet", "暂无数据"],
  ["none yet", "暂无"],
  ["Add", "添加"],
  ["Edit", "编辑"],
  ["Remove", "移除"],
];

/* Attributes worth localising. `value` is deliberately absent: it holds
   user-entered data, and a button's label is its text, not its value. */
const I18N_ATTRS = ["placeholder", "title", "aria-label"];

const I18N_EN = new Map();   // english  -> chinese
const I18N_ZH = new Map();   // chinese  -> english
I18N_PAIRS.forEach(([en, zh]) => {
  // A self-mapping entry would render the label twice ("Gmail Gmail").
  // Brand names and proper nouns simply do not belong in the dictionary.
  if (en === zh) return;
  if (!I18N_EN.has(en)) I18N_EN.set(en, zh);
  if (!I18N_ZH.has(zh)) I18N_ZH.set(zh, en);
});

// Never descend into these: they hold business data, user input, or code.
const I18N_SKIP_TAGS = new Set(["SCRIPT", "STYLE", "TEXTAREA", "CODE", "PRE", "IFRAME", "OPTION"]);

function i18nPairFor(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  if (I18N_EN.has(t)) return { en: t, zh: I18N_EN.get(t) };
  if (I18N_ZH.has(t)) return { en: I18N_ZH.get(t), zh: t };
  return null;
}

// "Find contacts" -> "Find contacts 查找联系人" for attribute text, where
// markup isn't available.
function i18nAttrText(text) {
  const p = i18nPairFor(text);
  return p ? `${p.en} ${p.zh}` : null;
}

/* Rewrites one text node into "English 中文".

   BOTH halves are wrapped. Wrapping only the Chinese leaves the English as a
   bare text node that still matches its own dictionary key, so the next pass
   localises it again — and because each pass mutates the DOM, the observer
   schedules another one and the label grows without bound. Wrapping the
   English in .i18n-en puts it behind the walker's reject rule, which is what
   makes repeated passes idempotent. */
function i18nApplyToTextNode(node) {
  const pair = i18nPairFor(node.nodeValue);
  if (!pair) return;
  const en = document.createElement("span");
  en.className = "i18n-en";
  en.textContent = pair.en;
  const zh = document.createElement("span");
  zh.className = "i18n-zh";
  zh.textContent = pair.zh;
  const frag = document.createDocumentFragment();
  frag.appendChild(en);
  frag.appendChild(zh);
  node.parentNode.replaceChild(frag, node);
}

/* Walks `root` and localises matching text nodes and attributes.
   Safe to call repeatedly — already-localised text no longer matches a
   dictionary key, so nothing is doubled. */
function applyI18n(root) {
  const scope = root || document.body;
  if (!scope || !scope.querySelectorAll) return;

  // Attributes first; they can't be affected by the text pass.
  const attrTargets = scope.querySelectorAll("[placeholder], [title], [aria-label]");
  attrTargets.forEach((el) => {
    if (el.closest("[data-no-i18n]")) return;
    I18N_ATTRS.forEach((a) => {
      const v = el.getAttribute(a);
      // dataset keys must be valid identifiers: "aria-label" -> "i18nAriaLabel".
      const flag = "i18n" + a.replace(/(^|-)([a-z])/g, (_, __, c) => c.toUpperCase());
      if (!v || el.dataset[flag] === "1") return;
      const out = i18nAttrText(v);
      if (out) { el.setAttribute(a, out); el.dataset[flag] = "1"; }
    });
  });

  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (I18N_SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if (parent.classList.contains("i18n-zh") || parent.classList.contains("i18n-en")) return NodeFilter.FILTER_REJECT;
      if (parent.closest("[data-no-i18n]")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  nodes.forEach(i18nApplyToTextNode);
}

/* <option> text can't hold markup, so selects are localised separately and
   inline: "Medium 适中". */
function applyI18nSelects(root) {
  const scope = root || document.body;
  scope.querySelectorAll("select").forEach((sel) => {
    if (sel.closest("[data-no-i18n]")) return;
    Array.from(sel.options).forEach((opt) => {
      if (opt.dataset.i18nDone === "1") return;
      const out = i18nAttrText(opt.textContent);
      if (out) { opt.textContent = out; opt.dataset.i18nDone = "1"; }
    });
  });
}

/* The CRM renders continuously — tables, dialogs, plan previews — so rather
   than asking every render path to remember to call this, one observer
   localises whatever appears. Batched on animation frames so a large table
   render costs a single pass. */
let _i18nQueued = false;
let _i18nApplying = false;
function scheduleI18n() {
  if (_i18nQueued || _i18nApplying) return;
  _i18nQueued = true;
  requestAnimationFrame(() => {
    _i18nQueued = false;
    _i18nApplying = true;
    try {
      applyI18n(document.body);
      applyI18nSelects(document.body);
    } finally {
      // Cleared after the observer has drained this pass's own records.
      requestAnimationFrame(() => { _i18nApplying = false; });
    }
  });
}

function initI18n() {
  applyI18n(document.body);
  applyI18nSelects(document.body);
  new MutationObserver((records) => {
    if (_i18nApplying) return;               // our own spans, not new content
    for (const r of records) {
      if (r.addedNodes && r.addedNodes.length) { scheduleI18n(); return; }
    }
  }).observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initI18n);
} else {
  initI18n();
}
