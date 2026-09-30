/* ═══════════════════════════════════════════════════════════════════════════
   Company identity by domain — one implementation, used everywhere.

   Two companies share an identity signal only when they share a REGISTRABLE
   domain: the part a company actually registers, resolved against the Public
   Suffix List (tldts). Comparing the last two labels instead is wrong in a
   way that looks right — every ".com.cn", ".co.uk" and ".com.my" address
   "matches" every other one. An early version of the exhibitor scan made
   exactly that mistake and tied Gotion's contacts to six unrelated Chinese
   exhibitors.

   Free-mail domains are never company evidence: two people with gmail.com
   addresses tells us nothing about where either of them works.
   ═══════════════════════════════════════════════════════════════════════════ */

const { getDomain } = require('tldts');

const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.co.jp', 'ymail.com', 'hotmail.com', 'outlook.com',
  'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.de',
  'web.de', 'mail.com', 'yandex.com', 'yandex.ru', 'zoho.com', 'qq.com', 'foxmail.com', '163.com', '126.com', 'yeah.net',
  'sina.com', 'sina.cn', 'sohu.com', 'aliyun.com', 'naver.com', 'daum.net', 'hanmail.net', 'rediffmail.com',
]);

/** Registrable domain of a URL, bare host or domain; null when there is none. */
function registrableDomain(value) {
  const s = String(value || '').trim().toLowerCase();
  if (!s || s.startsWith('(')) return null;
  let host = s;
  try { host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(s) ? s : `https://${s}`).hostname; } catch { /* use as given */ }
  const d = getDomain(host, { allowPrivateDomains: false });
  return d || null;
}

/** Registrable domain of an email address; null for placeholders and free mail. */
function companyEmailDomain(email) {
  const m = String(email || '').trim().toLowerCase().match(/^[^\s@()]+@([^\s@()]+)$/);
  if (!m) return null;
  const d = registrableDomain(m[1]);
  return d && !FREE_MAIL.has(d) ? d : null;
}

function isFreeMailDomain(domain) { return FREE_MAIL.has(String(domain || '').toLowerCase()); }

module.exports = { registrableDomain, companyEmailDomain, isFreeMailDomain, FREE_MAIL };
