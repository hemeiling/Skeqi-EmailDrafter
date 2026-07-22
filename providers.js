// Email provider abstraction. The rest of the CRM (AI drafting, contacts,
// conversations, attachments) never depends on which provider is active —
// switching from a GoDaddy test mailbox to Skeqi production is config-only.
//
// PROVIDERS is the single source of truth: adding a provider here is the only
// change needed to support it end-to-end (labels, connection type, and default
// SMTP/IMAP endpoints all live in one place).

const dns = require('dns').promises;
const emailSvc = require('./email');

const PROVIDERS = {
  godaddy_m365: {
    id: 'godaddy_m365', label: 'GoDaddy Microsoft 365', type: 'smtp',
    note: 'Microsoft 365 mailbox hosted by GoDaddy. Uses SMTP AUTH with an app password — ideal for testing today.',
    defaults: {
      smtp_host: 'smtp.office365.com', smtp_port: 587, smtp_encryption: 'starttls',
      imap_host: 'outlook.office365.com', imap_port: 993, imap_encryption: 'ssl',
      app_password_required: true,
    },
  },
  godaddy_workspace: {
    id: 'godaddy_workspace', label: 'GoDaddy Workspace Email', type: 'smtp',
    note: 'GoDaddy legacy Workspace email (SMTP/IMAP via secureserver.net).',
    defaults: {
      smtp_host: 'smtpout.secureserver.net', smtp_port: 465, smtp_encryption: 'ssl',
      imap_host: 'imap.secureserver.net', imap_port: 993, imap_encryption: 'ssl',
      app_password_required: false,
    },
  },
  netease_enterprise: {
    id: 'netease_enterprise', label: 'NetEase Enterprise Mail / 网易企业邮箱', type: 'smtp',
    note: '网易企业邮箱 (qiye.163.com). Requires a client authorization code (客户端授权码).',
    defaults: {
      smtp_host: 'smtp.qiye.163.com', smtp_port: 465, smtp_encryption: 'ssl',
      imap_host: 'imap.qiye.163.com', imap_port: 993, imap_encryption: 'ssl',
      app_password_required: true,
    },
  },
  microsoft365: {
    id: 'microsoft365', label: 'Microsoft 365 / Outlook', type: 'oauth', oauthKey: 'microsoft365',
    note: 'Enterprise Microsoft 365 via OAuth sign-in.',
    defaults: {
      smtp_host: 'smtp.office365.com', smtp_port: 587, smtp_encryption: 'starttls',
      imap_host: 'outlook.office365.com', imap_port: 993, imap_encryption: 'ssl',
    },
  },
  google: {
    id: 'google', label: 'Google Workspace / Gmail', type: 'oauth', oauthKey: 'google',
    note: 'Google Workspace / Gmail via OAuth sign-in.',
    defaults: {
      smtp_host: 'smtp.gmail.com', smtp_port: 587, smtp_encryption: 'starttls',
      imap_host: 'imap.gmail.com', imap_port: 993, imap_encryption: 'ssl',
    },
  },
  custom_imap: {
    id: 'custom_imap', label: 'Custom SMTP + IMAP', type: 'smtp',
    note: 'Any provider — enter SMTP/IMAP endpoints manually.',
    defaults: {},
  },
};
// Display order for the provider dropdown.
const PROVIDER_ORDER = ['godaddy_m365', 'godaddy_workspace', 'netease_enterprise', 'microsoft365', 'google', 'custom_imap'];

function listProviders() {
  return PROVIDER_ORDER.map((id) => {
    const p = PROVIDERS[id];
    return { id: p.id, label: p.label, type: p.type, note: p.note, defaults: p.defaults };
  });
}
function getProvider(id) { return PROVIDERS[id] || null; }

// ── Auto Detect: infer the provider from the email domain's MX records ─────
// GoDaddy Microsoft 365 and enterprise Microsoft 365 share the same Outlook MX,
// so an Outlook match resolves to microsoft365 with a GoDaddy hint attached.
const MX_HINTS = [
  { match: ['secureserver.net'], provider: 'godaddy_workspace' },
  { match: ['qiye.163.com', '163qiye', 'qiye163', 'mxbiz'], provider: 'netease_enterprise' },
  { match: ['aspmx.l.google.com', 'googlemail.com', 'google.com'], provider: 'google' },
  { match: ['mail.protection.outlook.com', 'office365.com', 'outlook.com'], provider: 'microsoft365' },
];
async function detectProvider(email) {
  const domain = String(email || '').split('@').pop().trim().toLowerCase();
  if (!domain || !domain.includes('.')) return { ok: false, message: 'Enter a valid email address or domain.' };
  let hosts = [];
  try { hosts = (await dns.resolveMx(domain)).map((r) => (r.exchange || '').toLowerCase()); } catch { hosts = []; }
  for (const hint of MX_HINTS) {
    if (hosts.some((h) => hint.match.some((m) => h.includes(m)))) {
      const p = PROVIDERS[hint.provider];
      const out = { ok: true, domain, provider: p.id, label: p.label, type: p.type, defaults: p.defaults, mx: hosts, confidence: 'high' };
      // Outlook MX could be GoDaddy-hosted M365 — surface the alternative.
      if (p.id === 'microsoft365') out.alt = { provider: 'godaddy_m365', label: PROVIDERS.godaddy_m365.label };
      return out;
    }
  }
  return {
    ok: true, domain, provider: null, mx: hosts, confidence: 'unknown',
    message: hosts.length ? 'Could not match a known provider from MX — pick one manually.' : 'No MX records found — pick a provider manually.',
  };
}

// ── EmailProvider abstraction ──────────────────────────────────────────────
// Every provider exposes the same surface; the CRM depends on the interface,
// never the implementation. Phase 1 implements verifyConnection + sendEmail
// for SMTP providers and verifyConnection for OAuth. receiveEmails, syncMailbox,
// reply, and forward are declared here and implemented in Phase 2 (inbox sync).
function notImplemented(name) {
  const e = new Error(`${name} is not implemented yet (Phase 2: inbox receive & sync).`);
  e.code = 'not_implemented';
  return e;
}

class BaseEmailProvider {
  constructor({ descriptor, orgConfig, account, secret }) {
    this.descriptor = descriptor;
    this.org = orgConfig || {};
    this.account = account || {};
    this.secret = secret || '';
  }
  async verifyConnection() { throw notImplemented('verifyConnection'); }
  async sendEmail() { throw notImplemented('sendEmail'); }
  async receiveEmails() { throw notImplemented('receiveEmails'); }
  async syncMailbox() { throw notImplemented('syncMailbox'); }
  async reply() { throw notImplemented('reply'); }
  async forward() { throw notImplemented('forward'); }
}

// Shared server, per-user login — the common shape for GoDaddy, NetEase, custom.
class SmtpImapProvider extends BaseEmailProvider {
  _smtpCfg() {
    return {
      host: this.org.smtp_host, port: this.org.smtp_port, encryption: this.org.smtp_encryption,
      user: this.account.mailbox_username || this.account.sender_email, pass: this.secret,
    };
  }
  async verifyConnection() {
    if (!this.org.smtp_host) return { ok: false, message: 'Organization SMTP is not configured yet.' };
    if (!this.account.sender_email || !this.secret) return { ok: false, message: 'Enter your email + authorization code / app password and Save first.' };
    return emailSvc.verifySmtpAuth(this._smtpCfg());
  }
  // Staged verification: network → TLS → authentication → mailbox access →
  // send capability. Every step is logged (never the password). Only THIS
  // provider's SMTP/IMAP endpoints are touched — no other provider's flow runs.
  async verifyConnectionStaged(log = () => {}) {
    const org = this.org, acct = this.account;
    const stages = [];
    const add = (stage, ok, message) => { stages.push({ stage, ok: Boolean(ok), message }); log(`  [${ok ? 'PASS' : 'FAIL'}] ${stage} — ${message}`); return ok; };
    const user = acct.mailbox_username || acct.sender_email || '';
    const smtpSecure = org.smtp_encryption === 'ssl' || org.smtp_encryption === 'tls' || Number(org.smtp_port) === 465;

    log(`provider=${this.descriptor.id} authMethod=SMTP+password`);
    log(`  smtp=${org.smtp_host || '(none)'}:${org.smtp_port || '?'} encryption=${org.smtp_encryption || '?'}`);
    log(`  imap=${org.imap_host || '(none)'}:${org.imap_port || '?'} encryption=${org.imap_encryption || '?'}`);
    log(`  username=${user || '(none)'} credentialSource=email_user_account.secret (per-user) hasSecret=${Boolean(this.secret)}`);

    if (!org.smtp_host) { add('config', false, 'Organization SMTP is not configured.'); return { ok: false, stages }; }
    if (!acct.sender_email || !this.secret) { add('config', false, 'Enter your email + authorization code / app password and Save first.'); return { ok: false, stages }; }

    // 1. Network
    const netRes = await emailSvc.tcpConnect(org.smtp_host, org.smtp_port);
    if (!add('network', netRes.ok, netRes.message)) return { ok: false, stages };
    // 2. TLS
    if (smtpSecure) {
      const t = await emailSvc.tlsHandshake(org.smtp_host, org.smtp_port);
      if (!add('tls', t.ok, t.message)) return { ok: false, stages };
    } else {
      add('tls', true, 'STARTTLS — secure channel is negotiated during authentication');
    }
    // 3. Authentication
    const auth = await emailSvc.verifySmtpAuth(this._smtpCfg());
    if (!add('authentication', auth.ok, auth.message)) { add('send_capability', false, 'Blocked — authentication must succeed first'); return { ok: false, stages }; }
    // 4. Mailbox access (IMAP reachability; full IMAP login lands in Phase 2)
    if (org.imap_host) {
      const imapSecure = org.imap_encryption === 'ssl' || org.imap_encryption === 'tls' || Number(org.imap_port) === 993;
      const mb = await emailSvc.probeHost(org.imap_host, org.imap_port, imapSecure);
      add('mailbox_access', mb.ok, mb.ok ? `IMAP reachable at ${org.imap_host}:${org.imap_port} (full mailbox login in Phase 2)` : mb.message);
    } else {
      add('mailbox_access', false, 'No IMAP host configured');
    }
    // 5. Send capability (authenticated SMTP ⇒ can send)
    add('send_capability', true, 'SMTP authentication succeeded — outbound sending is ready');
    return { ok: true, stages };
  }
  async sendEmail({ to, subject, text, html, cc, bcc, replyTo, attachments } = {}) {
    if (!to) return { ok: false, message: 'A recipient (to) is required.' };
    const from = this.account.sender_name ? `${this.account.sender_name} <${this.account.sender_email}>` : this.account.sender_email;
    return emailSvc.sendMail(this._smtpCfg(), {
      from, to, subject, text, html,
      cc: cc || undefined, bcc: bcc || undefined,
      replyTo: replyTo || this.account.reply_to || undefined,
      attachments: attachments || undefined,
    });
  }
}

// OAuth providers (Microsoft 365 / Google) — org-level sign-in; API send lands
// in Phase 2 (Graph / Gmail API). Connection is verified from the stored grant.
class OAuthProvider extends BaseEmailProvider {
  async verifyConnection() {
    return this.org.oauth_connected
      ? { ok: true, message: `Connected as ${this.org.oauth_email || 'the organization account'}` }
      : { ok: false, message: 'Organization account is not connected yet. Use Connect & sign in.' };
  }
  // OAuth providers never touch SMTP/IMAP — only the stored OAuth grant is checked.
  async verifyConnectionStaged(log = () => {}) {
    const connected = Boolean(this.org.oauth_connected);
    log(`provider=${this.descriptor.id} authMethod=OAuth`);
    log(`  account=${this.org.oauth_email || '(none)'} credentialSource=email_org_config.oauth_token (org-level) connected=${connected}`);
    const stages = [
      { stage: 'oauth', ok: connected, message: connected ? `Signed in as ${this.org.oauth_email}` : 'Organization account is not connected — use Connect & sign in' },
      { stage: 'send_capability', ok: connected, message: connected ? 'Connected (Graph/Gmail API send lands in Phase 2)' : 'Blocked — connect the account first' },
    ];
    stages.forEach((s) => log(`  [${s.ok ? 'PASS' : 'FAIL'}] ${s.stage} — ${s.message}`));
    return { ok: connected, stages };
  }
  async sendEmail() { throw notImplemented('OAuth API send (Graph/Gmail)'); }
}

// Factory: hand back the right engine for the active provider. The caller uses
// only the EmailProvider interface, so nothing downstream changes per provider.
function createEngine({ providerId, orgConfig, account, secret }) {
  const id = providerId || (orgConfig && orgConfig.provider_type) || '';
  const descriptor = PROVIDERS[id];
  if (!descriptor) { const e = new Error('Unknown or unconfigured email provider.'); e.code = 'no_provider'; throw e; }
  const Impl = descriptor.type === 'oauth' ? OAuthProvider : SmtpImapProvider;
  return new Impl({ descriptor, orgConfig, account, secret });
}

module.exports = {
  PROVIDERS, PROVIDER_ORDER, listProviders, getProvider, detectProvider, createEngine,
  BaseEmailProvider, SmtpImapProvider, OAuthProvider,
};
