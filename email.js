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

async function verifySmtpAuth(cfg) {
  try { await transportFor(cfg).verify(); return { ok: true, message: 'SMTP authentication succeeded' }; }
  catch (e) { return { ok: false, message: e.message || 'SMTP verification failed' }; }
}

// General send used by the provider abstraction. `message` is a nodemailer
// message object ({ from, to, subject, text, html, cc, bcc, replyTo, attachments }).
async function sendMail(cfg, message) {
  try {
    const info = await transportFor(cfg).sendMail(message);
    return { ok: true, message: `Sent to ${message.to} (id ${info.messageId || '?'})`, id: info.messageId };
  } catch (e) { return { ok: false, message: e.message || 'Send failed' }; }
}

async function sendTestMail(cfg, from, to) {
  try {
    const info = await transportFor(cfg).sendMail({
      from, to,
      subject: 'Skeqi EmailDrafter — test email',
      text: 'This is a test email from Skeqi EmailDrafter. If you received it, sending is working.',
    });
    return { ok: true, message: `Test email sent to ${to} (id ${info.messageId || '?'})` };
  } catch (e) { return { ok: false, message: e.message || 'Send failed' }; }
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

module.exports = {
  probeHost, tcpConnect, tlsHandshake, verifySmtpAuth, sendMail, sendTestMail, validateDomain, transportFor,
  OAUTH_PROVIDERS, oauthProviderMeta, oauthEnvNames, oauthCreds, oauthConfigured,
  oauthAuthUrl, oauthExchangeCode, oauthUserInfo,
};
