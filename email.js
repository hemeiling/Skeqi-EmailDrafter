// Email service: SMTP verify/send (nodemailer), TCP/TLS reachability probes,
// and SPF/DKIM/DMARC DNS checks. Real sending stays disabled until the org
// configuration is enabled and verified (enforced in server.js).

const net = require('net');
const tls = require('tls');
const dns = require('dns').promises;
const nodemailer = require('nodemailer');

// TCP/TLS reachability probe (no auth) — used for org-level "Test SMTP/IMAP".
function probeHost(host, port, secure, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (!host || !port) return resolve({ ok: false, message: 'Host and port are required' });
    let sock;
    const t = setTimeout(() => { try { sock && sock.destroy(); } catch { /* noop */ } resolve({ ok: false, message: `Timed out connecting to ${host}:${port}` }); }, timeoutMs);
    const done = (r) => { clearTimeout(t); resolve(r); };
    try {
      if (secure) {
        sock = tls.connect({ host, port: Number(port), servername: host, rejectUnauthorized: false }, () => {
          try { sock.end(); } catch { /* noop */ } done({ ok: true, message: `TLS handshake OK at ${host}:${port}` });
        });
      } else {
        sock = net.connect({ host, port: Number(port) }, () => {
          try { sock.end(); } catch { /* noop */ } done({ ok: true, message: `TCP connect OK at ${host}:${port}` });
        });
      }
      sock.on('error', (e) => done({ ok: false, message: e.message || 'Connection failed' }));
    } catch (e) { done({ ok: false, message: e.message }); }
  });
}

// Raw TCP reachability (the "network" stage) — no TLS, no auth.
function tcpConnect(host, port, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (!host || !port) return resolve({ ok: false, message: 'SMTP host and port are required' });
    const start = Date.now();
    let sock;
    const t = setTimeout(() => { try { sock && sock.destroy(); } catch { /* noop */ } resolve({ ok: false, message: `Timed out connecting to ${host}:${port}` }); }, timeoutMs);
    try {
      sock = net.connect({ host, port: Number(port) }, () => {
        clearTimeout(t); const ms = Date.now() - start; try { sock.end(); } catch { /* noop */ }
        resolve({ ok: true, message: `Reached ${host}:${port} in ${ms}ms`, ms });
      });
      sock.on('error', (e) => { clearTimeout(t); resolve({ ok: false, message: e.message || `Cannot reach ${host}:${port}` }); });
    } catch (e) { clearTimeout(t); resolve({ ok: false, message: e.message }); }
  });
}

// TLS handshake (the "TLS" stage) for implicit-TLS ports (SSL/465/993).
function tlsHandshake(host, port, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (!host || !port) return resolve({ ok: false, message: 'Host and port are required' });
    let sock;
    const t = setTimeout(() => { try { sock && sock.destroy(); } catch { /* noop */ } resolve({ ok: false, message: `TLS handshake timed out at ${host}:${port}` }); }, timeoutMs);
    try {
      sock = tls.connect({ host, port: Number(port), servername: host, rejectUnauthorized: false }, () => {
        clearTimeout(t);
        const proto = (sock.getProtocol && sock.getProtocol()) || '';
        const cipher = (sock.getCipher && sock.getCipher()) || {};
        try { sock.end(); } catch { /* noop */ }
        resolve({ ok: true, message: `Secure channel established${proto ? ' (' + proto + (cipher.name ? ', ' + cipher.name : '') + ')' : ''}` });
      });
      sock.on('error', (e) => { clearTimeout(t); resolve({ ok: false, message: e.message || 'TLS handshake failed' }); });
    } catch (e) { clearTimeout(t); resolve({ ok: false, message: e.message }); }
  });
}

function transportFor({ host, port, encryption, user, pass }) {
  const secure = encryption === 'ssl' || encryption === 'tls' || Number(port) === 465;
  return nodemailer.createTransport({
    host, port: Number(port), secure,
    auth: user ? { user, pass } : undefined,
    requireTLS: encryption === 'starttls',
    tls: { rejectUnauthorized: false },
    connectionTimeout: 10000, greetingTimeout: 8000, socketTimeout: 15000,
  });
}

// Provider-specific SMTP rejections. A raw "535 5.7.0 ERR.LOGIN.REQCODE" tells
// the user nothing; the fix (use the client authorization code, not the mailbox
// password) is completely opaque from the code alone. Each entry is matched
// against the server's response text, so it works for both verify() and send().
//
// The NetEase behaviours below were confirmed against smtp.qiye.163.com:465:
//   user = heml@skeqi.com  → 535 ERR.LOGIN.REQCODE      (username form accepted)
//   user = heml            → 535 email format login fail (username form rejected)
// i.e. this provider requires the FULL email address as the SMTP username.
const SMTP_ERROR_HINTS = [
  {
    match: /ERR\.LOGIN\.REQCODE/i,
    providers: ['netease_enterprise'],
    message: '网易企业邮箱要求使用「客户端授权码」，不是邮箱登录密码。'
           + '登录 qiye.163.com → 设置 → 客户端授权码（或 POP3/SMTP/IMAP）→ 生成授权码，'
           + '然后把它填进上面的密码框。'
           + ' (NetEase requires a client authorization code, not the mailbox login password.)',
  },
  {
    match: /email format login fail/i,
    message: 'SMTP 用户名必须是完整邮箱地址（例如 you@skeqi.com），不能只填邮箱名。'
           + ' (This provider requires the full email address as the SMTP username.)',
  },
  {
    // Seen when an address from another domain is tested against this provider's
    // SMTP host — the credentials are irrelevant, the domain simply isn't hosted
    // here. Easy to mistake for a password problem and waste time on it.
    match: /ERR\.LOGIN\.DOMAINNOTEXIST/i,
    message: '该邮箱的域名不在此服务商托管。请确认「组织邮箱域名」与你要连接的邮箱域名一致，'
           + '或为这个邮箱选择正确的服务商 —— 与密码无关。'
           + ' (The address\'s domain is not hosted by this provider; not a credential problem.)',
  },
  {
    match: /ERR\.LOGIN\.PASSERR|Invalid user name or password|authentication failed/i,
    message: '用户名或密码/授权码不正确。若服务商要求授权码，请确认填的不是登录密码。',
  },
  {
    match: /ERR\.LOGIN\.SMTPLIMIT|too many|rate limit|frequency/i,
    message: '认证过于频繁，已被服务商临时限流。等几分钟再试，不要连续点测试。',
  },
  {
    match: /must issue a STARTTLS/i,
    message: '服务器要求先建立 STARTTLS。把加密方式改成 STARTTLS（端口通常 587）。',
  },
];

// Returns an actionable message when the SMTP response matches a known
// provider quirk, otherwise the server's own text.
function explainSmtpError(err, providerType) {
  const raw = [err && err.response, err && err.message].filter(Boolean).join(' ');
  if (!raw) return 'SMTP verification failed';
  for (const hint of SMTP_ERROR_HINTS) {
    if (hint.providers && providerType && !hint.providers.includes(providerType)) continue;
    if (hint.match.test(raw)) return `${hint.message}\n\n服务器原文: ${raw.trim().replace(/\s+/g, ' ')}`;
  }
  return raw.trim().replace(/\s+/g, ' ');
}

async function verifySmtpAuth(cfg) {
  try { await transportFor(cfg).verify(); return { ok: true, message: 'SMTP authentication succeeded' }; }
  catch (e) { return { ok: false, message: explainSmtpError(e, cfg && cfg.providerType) }; }
}

// General send used by the provider abstraction. `message` is a nodemailer
// message object ({ from, to, subject, text, html, cc, bcc, replyTo, attachments }).
async function sendMail(cfg, message) {
  try {
    const info = await transportFor(cfg).sendMail(message);
    return { ok: true, message: `Sent to ${message.to} (id ${info.messageId || '?'})`, id: info.messageId };
  } catch (e) { return { ok: false, message: explainSmtpError(e, cfg && cfg.providerType) }; }
}

async function sendTestMail(cfg, from, to) {
  try {
    const info = await transportFor(cfg).sendMail({
      from, to,
      subject: 'Skeqi EmailDrafter — test email',
      text: 'This is a test email from Skeqi EmailDrafter. If you received it, sending is working.',
    });
    return { ok: true, message: `Test email sent to ${to} (id ${info.messageId || '?'})` };
  } catch (e) { return { ok: false, message: explainSmtpError(e, cfg && cfg.providerType) }; }
}

// Resolve TXT with a hard per-lookup timeout so a non-resolving domain can't
// stall the request (each lookup otherwise waits the full resolver timeout).
function withTimeout(p, ms, fallback) {
  return Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]);
}
async function txt(name) {
  try { const r = await withTimeout(dns.resolveTxt(name), 3500, []); return (r || []).map((a) => a.join('')); } catch { return []; }
}

// SPF / DMARC / DKIM presence via DNS TXT — all lookups run in parallel and
// time out fast. DKIM selectors vary, so we probe several common ones.
async function validateDomain(domain) {
  const selectors = ['default', 'google', 'selector1', 'selector2', 's1', 's2', 'k1', 'dkim', 'mail'];
  const [spfRecs, dmarcRecs, ...dkimRecsList] = await Promise.all([
    txt(domain),
    txt('_dmarc.' + domain),
    ...selectors.map((sel) => txt(sel + '._domainkey.' + domain)),
  ]);
  const spf = spfRecs.find((v) => /v=spf1/i.test(v));
  const dmarc = dmarcRecs.find((v) => /v=DMARC1/i.test(v));
  let dkim = null;
  for (let i = 0; i < selectors.length; i++) {
    if ((dkimRecsList[i] || []).find((v) => /v=DKIM1|p=[A-Za-z0-9]/i.test(v))) { dkim = selectors[i]; break; }
  }
  return {
    spf: spf ? 'pass' : 'missing',
    dkim: dkim ? `pass (selector: ${dkim})` : 'not found (selector-specific)',
    dmarc: dmarc ? 'pass' : 'missing',
    details: { spf: spf || null, dmarc: dmarc || null },
  };
}

// ── OAuth: connect a Microsoft 365 / Google Workspace account ────────────────
// Client credentials come from env (the org's registered OAuth app). This is
// the one deployment prerequisite the admin (Skeqi IT) must set up once.
const OAUTH_PROVIDERS = {
  microsoft365: {
    label: 'Microsoft 365',
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'openid email profile offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.Send',
    extraAuth: { prompt: 'select_account' },
    env: { id: 'MS_CLIENT_ID', secret: 'MS_CLIENT_SECRET' },
    userInfoUrl: 'https://graph.microsoft.com/v1.0/me',
    parseUser: (d) => ({ email: d.mail || d.userPrincipalName || '', name: d.displayName || '' }),
  },
  google: {
    label: 'Google Workspace',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile https://www.googleapis.com/auth/gmail.send',
    extraAuth: { access_type: 'offline', prompt: 'consent' },
    env: { id: 'GOOGLE_CLIENT_ID', secret: 'GOOGLE_CLIENT_SECRET' },
    userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    parseUser: (d) => ({ email: d.email || '', name: d.name || '' }),
  },
};

function oauthProviderMeta(provider) { return OAUTH_PROVIDERS[provider] || null; }
function oauthEnvNames(provider) { const p = OAUTH_PROVIDERS[provider]; return p ? p.env : null; }
function oauthCreds(provider) {
  const p = OAUTH_PROVIDERS[provider];
  if (!p) return null;
  return { clientId: process.env[p.env.id] || '', clientSecret: process.env[p.env.secret] || '' };
}
function oauthConfigured(provider) {
  const c = oauthCreds(provider);
  return Boolean(c && c.clientId && c.clientSecret);
}
function oauthAuthUrl(provider, { clientId, redirectUri, state }) {
  const p = OAUTH_PROVIDERS[provider];
  const params = new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: redirectUri, scope: p.scope,
    state, ...(p.extraAuth || {}),
  });
  return `${p.authUrl}?${params.toString()}`;
}
async function oauthExchangeCode(provider, { code, clientId, clientSecret, redirectUri }) {
  const p = OAUTH_PROVIDERS[provider];
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri, grant_type: 'authorization_code' });
  const r = await fetch(p.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error_description || d.error || 'Token exchange failed');
  return d; // { access_token, refresh_token?, expires_in }
}
async function oauthUserInfo(provider, accessToken) {
  const p = OAUTH_PROVIDERS[provider];
  const r = await fetch(p.userInfoUrl, { headers: { authorization: 'Bearer ' + accessToken } });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || d.error || 'Failed to read account profile');
  return p.parseUser(d);
}

module.exports = { explainSmtpError,
  probeHost, tcpConnect, tlsHandshake, verifySmtpAuth, sendMail, sendTestMail, validateDomain, transportFor,
  OAUTH_PROVIDERS, oauthProviderMeta, oauthEnvNames, oauthCreds, oauthConfigured,
  oauthAuthUrl, oauthExchangeCode, oauthUserInfo,
};
