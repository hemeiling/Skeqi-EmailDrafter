// Drafts a personalized outreach email with Claude, given a contact and
// (optionally) the sender's own identity. Ported from EmailDrafter's
// call_claude(), simplified (no CSV-upload company context).

const CLAUDE_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-sonnet-4-6';
const { recordClaudeUsage } = require('./usage');

const { isClaudeConfigured, CLAUDE_API_KEY } = require('./config');

function isConfigured() {
  return isClaudeConfigured();
}

// Confirmed customer profile (from saved company/contact tags) — appended to
// every prompt when present. Empty string when there are no tags, so the
// original prompts are byte-for-byte unchanged for un-tagged contacts.
function customerProfileBlock(context = {}) {
  if (!context || (!context.customerProfile && !context.skqCapabilities)) return '';
  let s = '\n\n';
  if (context.customerProfile) s += `${context.customerProfile}\n`;
  if (context.skqCapabilities) s += `\n${context.skqCapabilities}\n`;
  s += (
    `\nTailor this email to the customer profile above: emphasize ONLY the SKQ capabilities that fit ` +
    `this customer, connect them to the contact's role and the customer's priorities, and do NOT mention ` +
    `unrelated products or cell formats. If relevant SKQ materials would help, you may offer to share them, ` +
    `but do not invent specifics or attach anything.\n`
  );
  return s;
}

function buildPrompt(contact, sender, context = {}) {
  const name = contact.name || 'there';
  const title = contact.title || 'leader';
  const company = contact.company || 'your company';
  const dept = contact.department || 'their team';
  const linkedin = contact.linkedin || '';

  const senderName = (sender && sender.name) || '';
  const senderTitle = (sender && sender.title) || '';
  const senderCompany = (sender && sender.company) || '';
  const hasSender = Boolean(senderName);
  const signOff = senderName || '[Your Name]';
  const fromLine = (senderName && senderCompany) ? `${senderName}, ${senderTitle} at ${senderCompany}` : signOff;

  let emailNote = '';
  const emailValue = contact.email || '';
  if (emailValue && !emailValue.includes('not returned')) emailNote = `Email: ${emailValue}\n`;
  else if (emailValue) emailNote = `Apollo email note: ${emailValue}\n`;

  const senderLines = [];
  if (senderName) senderLines.push(`- Name: ${senderName}`);
  if (senderTitle) senderLines.push(`- Title: ${senderTitle}`);
  if (senderCompany) senderLines.push(`- Company: ${senderCompany}`);
  const senderBlock = senderLines.length ? `\n\nSender (the person writing this email):\n${senderLines.join('\n')}` : '';
  const signOffLine = senderName ? `Sign off as: ${fromLine}` : 'Sign off as: [Your Name] (placeholder)';

  const senderReasoning = hasSender ? (
    `\nStep 1 — Sender analysis (do this silently, do not include in the email):\n` +
    `Based on the sender's title (${senderTitle || 'unknown'}) and company (${senderCompany || 'unknown'}), infer:\n` +
    `  a) What product, service, or expertise the sender most likely offers\n` +
    `  b) Which specific pain points or priorities the recipient (${title} at ${company}, ${dept} dept) would care about\n` +
    `  c) The most credible angle to connect the two\n` +
    `Use this reasoning to shape every sentence of the email — do not use generic business-development language. ` +
    `The email should feel like it was written by someone who deeply understands both sides.\n`
  ) : '';

  return (
    `You are drafting a cold outreach email on behalf of a specific person.\n` +
    `${senderReasoning}` +
    `\nRecipient:\n` +
    `- Name: ${name}\n` +
    `- Title: ${title}\n` +
    `- Company: ${company}\n` +
    `- Department: ${dept}\n` +
    `${emailNote}` +
    `${linkedin ? `- LinkedIn: ${linkedin}\n` : ''}` +
    `${senderBlock}${customerProfileBlock(context)}\n\n` +
    `Now write the outreach email. Requirements:\n` +
    `1. First person, from the sender's voice\n` +
    `2. Open with a specific, relevant observation about the recipient's role or company (not a generic compliment)\n` +
    `3. In one sentence, connect what the sender offers to a real challenge or goal the recipient likely faces in their ${dept} role\n` +
    `4. 4-6 sentences total — conversational, not salesy\n` +
    `5. Close with a low-pressure CTA: suggest a 20-30 min call\n` +
    `6. ${signOffLine}\n` +
    `\nAlso provide:\n` +
    `- subject: a compelling subject line (under 10 words, no clickbait)\n` +
    `- followup: one sentence friendly reminder (same voice, 3-5 days later)\n` +
    `- rationale: one sentence explaining why this specific contact was worth targeting given the sender's background\n` +
    `\nReturn ONLY a raw JSON object with exactly these keys:\n` +
    `  subject (string), body (string), followup (string), rationale (string)\n` +
    `No markdown. No code fences. Just the JSON object.`
  );
}

// =========================================================================
// Drafting modes -- ADDED ON TOP of the original function above, which is
// untouched. mode='cold_outreach' (or no mode at all) always routes to the
// exact original buildPrompt(), so existing behavior is preserved exactly.
// Every other mode is a new prompt variant that reuses the same recipient/
// sender framing but changes the angle and requirements, and can pull in
// company notes, event context, and free-text instructions from the CRM.
// =========================================================================

const DRAFT_MODES = {
  cold_outreach: { label: 'Standard cold outreach (original)' },
  procurement_outreach: { label: 'Procurement outreach' },
  engineering_outreach: { label: 'Engineering outreach' },
  conference_outreach: { label: 'Conference outreach (e.g. The Battery Show)' },
  general_follow_up: { label: 'General follow-up' },
  company_innovations: { label: "Sharing company innovations" },
  partnership_intro: { label: 'Partnership introduction' },
  sales_outreach: { label: 'Sales outreach' },
  post_meeting_follow_up: { label: 'Post-meeting follow-up' }
};

function listDraftModes() {
  return Object.entries(DRAFT_MODES).map(([value, m]) => ({ value, label: m.label }));
}

const MODE_REQUIREMENTS = {
  procurement_outreach: () => [
    "First person, from the sender's voice",
    "Open with a specific, relevant observation about the recipient's role or company",
    "Speak directly to procurement/sourcing priorities: total cost of ownership, supply reliability, quality consistency, or scalability -- using any company notes provided",
    "4-6 sentences total -- confident and direct, but not pushy",
    "Close with a low-pressure CTA: propose a short call to discuss sourcing fit"
  ],
  engineering_outreach: () => [
    "First person, from the sender's voice",
    "Open with a specific, relevant observation about the recipient's role or company",
    "Speak to engineering/technical priorities: performance, integration, technical specifications, or process improvement -- using any company notes provided",
    "4-6 sentences total -- technical and credible, not salesy",
    "Close with a low-pressure CTA: offer a technical deep-dive or spec sheet"
  ],
  conference_outreach: (ctx) => [
    "First person, from the sender's voice",
    `Open by referencing the event${ctx.eventName ? ` ("${ctx.eventName}")` : ''} -- either that you'll both be there, or that you connected there`,
    "In one sentence, connect what the sender offers to a challenge the recipient's team likely faces, using any company notes provided",
    "4-6 sentences total -- conversational, not salesy",
    "Close with a low-pressure CTA: suggest meeting at the event, or a short call around it"
  ],
  general_follow_up: () => [
    "First person, from the sender's voice",
    "Open with a brief, warm reference to prior contact or shared context (don't invent specifics you weren't given)",
    "Keep it short -- this is a check-in, not a new pitch",
    "3-5 sentences total -- casual, low-pressure tone",
    "Close by asking if now's a good time to reconnect, or proposing a specific next step"
  ],
  company_innovations: () => [
    "First person, from the sender's voice",
    "Open with a specific, relevant observation about the recipient's role or company",
    "Share one concrete update, product, or innovation from the sender's company, framed around why it's relevant to the recipient specifically",
    "4-6 sentences total -- informative, not salesy",
    "Close with a low-pressure CTA: offer to share more detail or a demo if there's interest"
  ],
  partnership_intro: () => [
    "First person, from the sender's voice",
    "Open by identifying a specific area of potential overlap or complementary strength between the two companies",
    "Propose, in one sentence, a concrete way a partnership or collaboration could work",
    "4-6 sentences total -- collaborative in tone, not transactional",
    "Close with a low-pressure CTA: suggest a short exploratory call"
  ],
  sales_outreach: () => [
    "First person, from the sender's voice",
    "Open with a specific, relevant observation about the recipient's role or company",
    "Be direct about what the sender is selling and the concrete value/ROI angle for this recipient's role",
    "4-6 sentences total -- confident and direct, but not pushy",
    "Close with a clear CTA: propose a specific call or demo"
  ],
  post_meeting_follow_up: () => [
    "First person, from the sender's voice",
    "Open by referencing the recent meeting/conversation (use any notes provided; don't invent details you weren't given)",
    "Recap, in one sentence, the key point or interest expressed during that meeting",
    "3-5 sentences total -- warm and specific, referencing the actual conversation",
    "Close with a clear next step based on what was discussed"
  ]
};

// Builds the shared recipient/sender/context blocks used by every
// non-default mode. Mirrors the original buildPrompt()'s framing so the
// output format and tone stay consistent, without modifying buildPrompt itself.
function buildContextBlocks(contact, sender, context) {
  const name = contact.name || 'there';
  const title = contact.title || 'leader';
  const company = contact.company || 'your company';
  const dept = contact.department || 'their team';
  const linkedin = contact.linkedin || '';

  const senderName = (sender && sender.name) || '';
  const senderTitle = (sender && sender.title) || '';
  const senderCompany = (sender && sender.company) || '';
  const fromLine = (senderName && senderCompany) ? `${senderName}, ${senderTitle} at ${senderCompany}` : (senderName || '[Your Name]');
  const signOffLine = senderName ? `Sign off as: ${fromLine}` : 'Sign off as: [Your Name] (placeholder)';

  let emailNote = '';
  const emailValue = contact.email || '';
  if (emailValue && !emailValue.includes('not returned')) emailNote = `Email: ${emailValue}\n`;

  const senderLines = [];
  if (senderName) senderLines.push(`- Name: ${senderName}`);
  if (senderTitle) senderLines.push(`- Title: ${senderTitle}`);
  if (senderCompany) senderLines.push(`- Company: ${senderCompany}`);
  const senderBlock = senderLines.length ? `\n\nSender (the person writing this email):\n${senderLines.join('\n')}` : '';

  const contextLines = [];
  if (context.eventName) contextLines.push(`- Event: ${context.eventName}`);
  if (context.companyNotes) contextLines.push(`- Company notes: ${context.companyNotes}`);
  if (context.extraInstructions) contextLines.push(`- Sender's specific instructions for this email: ${context.extraInstructions}`);
  const contextBlock = contextLines.length ? `\n\nAdditional context (use this to personalize the email; don't invent beyond it):\n${contextLines.join('\n')}` : '';

  return {
    name, title, company, dept, linkedin, emailNote, senderBlock, contextBlock, signOffLine
  };
}

// mode: one of DRAFT_MODES keys. context: { eventName?, companyNotes?, extraInstructions? }
function buildPromptForMode(mode, contact, sender, context = {}) {
  // Default / unset / unrecognized mode -> exact original behavior, untouched.
  if (!mode || mode === 'cold_outreach' || !MODE_REQUIREMENTS[mode]) {
    return buildPrompt(contact, sender, context);
  }

  const { name, title, company, dept, linkedin, emailNote, senderBlock, contextBlock, signOffLine } = buildContextBlocks(contact, sender, context);
  const requirements = MODE_REQUIREMENTS[mode](context);
  const reqList = requirements.map((r, i) => `${i + 1}. ${r}`).join('\n');

  return (
    `You are drafting a "${DRAFT_MODES[mode].label}" email on behalf of a specific person.\n` +
    `\nRecipient:\n` +
    `- Name: ${name}\n` +
    `- Title: ${title}\n` +
    `- Company: ${company}\n` +
    `- Department: ${dept}\n` +
    `${emailNote}` +
    `${linkedin ? `- LinkedIn: ${linkedin}\n` : ''}` +
    `${senderBlock}` +
    `${contextBlock}${customerProfileBlock(context)}\n\n` +
    `Now write the email. Requirements:\n${reqList}\n` +
    `${requirements.length + 1}. ${signOffLine}\n` +
    `\nAlso provide:\n` +
    `- subject: a compelling subject line (under 10 words, no clickbait)\n` +
    `- followup: one sentence friendly reminder (same voice, 3-5 days later)\n` +
    `- rationale: one sentence explaining why this contact/context is worth this outreach\n` +
    `\nReturn ONLY a raw JSON object with exactly these keys:\n` +
    `  subject (string), body (string), followup (string), rationale (string)\n` +
    `No markdown. No code fences. Just the JSON object.`
  );
}

function parseDraftResponse(rawText) {
  try {
    return JSON.parse(rawText);
  } catch {
    const match = rawText.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { /* fall through */ }
    }
    return { subject: '', body: rawText, followup: '', rationale: '' };
  }
}

function offlineStub(contact, sender, mode, context = {}) {
  const name = contact.name || 'there';
  const title = contact.title || 'leader';
  const company = contact.company || 'your company';
  const dept = contact.department || 'their team';
  const senderName = (sender && sender.name) || '';
  const senderTitle = (sender && sender.title) || '';
  const senderCompany = (sender && sender.company) || '';
  const fromLine = (senderName && senderCompany) ? `${senderName}, ${senderTitle} at ${senderCompany}` : (senderName || '[Your Name]');

  if (mode && mode !== 'cold_outreach' && DRAFT_MODES[mode]) {
    const modeLabel = DRAFT_MODES[mode].label;
    const eventLine = context.eventName ? ` — following up from ${context.eventName}` : '';
    return {
      subject: `${modeLabel}${eventLine ? ':' : ':'} ${company}`,
      body:
        `Hi ${name},\n\n` +
        `[Template stub for "${modeLabel}"${eventLine}] This would be a personalized email to ${name} ` +
        `(${title} at ${company}) reflecting that context. Add a Claude API key to generate the real draft.\n\n` +
        `Best,\n${fromLine}`,
      followup: `Hi ${name}, following up on the above.`,
      rationale: `${name} at ${company} is a relevant contact for a "${modeLabel}" email.`,
      _note: 'Claude API key not configured — this is a template stub.'
    };
  }

  return {
    subject: `Intro: improving ${dept} efficiency at ${company}`,
    body:
      `Hi ${name},\n\n` +
      `I came across your profile and noticed your work as ${title} at ${company}. ` +
      `We help ${dept} leaders reduce costs and streamline operations, and I think there's a strong fit with what you're working on. ` +
      `Would you be open to a 20-minute intro call this week to explore?\n\n` +
      `Best,\n${fromLine}`,
    followup: `Hi ${name}, just circling back — happy to keep it brief, even 15 minutes would be great.`,
    rationale: `${name} is a senior ${dept} contact at ${company}, making them a high-priority contact for outreach.`,
    _note: 'Claude API key not configured — this is a template stub.'
  };
}

// contact: { name, title, company, department, email, linkedin }
// sender:  { name, title, company } -- the person the email is written on behalf of
// mode:    optional -- one of DRAFT_MODES; omitted or 'cold_outreach' = original behavior, unchanged
// context: optional -- { eventName, companyNotes, extraInstructions }
async function draftEmail(contact, sender, mode, context) {
  const apiKey = CLAUDE_API_KEY;
  if (!apiKey) {
    return { ...offlineStub(contact, sender, mode, context), claude_configured: false };
  }

  const prompt = buildPromptForMode(mode, contact, sender, context);

  try {
    const res = await fetch(CLAUDE_MESSAGES_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!res.ok) {
      const text = await res.text();
      return {
        subject: '', body: `Claude API error ${res.status}: ${text.slice(0, 300)}`,
        followup: '', rationale: '', claude_configured: true
      };
    }

    const data = await res.json();
    const rawText = (data.content && data.content[0] && data.content[0].text) || '';
    const apiUsage = data.usage || {};
    const draft = parseDraftResponse(rawText);
    // Usage is recorded by the server route (which has feature/company/contact context).
    return { ...draft, claude_configured: true, _usage: { ...apiUsage, model: CLAUDE_MODEL } };
  } catch (err) {
    return {
      subject: '', body: `Network error calling Claude: ${err.message}`,
      followup: '', rationale: '', claude_configured: true
    };
  }
}

const EMAIL_CATEGORIES = [
  'cold_outreach', 'follow_up', 'conference_outreach',
  'partnership_discussion', 'sales_discussion',
  'innovation_update', 'meeting_recap', 'other'
];

// Keyword-based fallback for when Claude isn't configured
function classifyByKeywords(subject, body) {
  const text = `${subject} ${body}`.toLowerCase();
  if (/follow.?up|following up|circling back|checking in/.test(text)) return 'follow_up';
  if (/conference|event|booth|trade show|meeting at|saw you at/.test(text)) return 'conference_outreach';
  if (/partner|partnership|collaboration|collaborate|joint/.test(text)) return 'partnership_discussion';
  if (/demo|pricing|quote|proposal|purchase|buy|sale|offer/.test(text)) return 'sales_discussion';
  if (/launch|new product|innovation|update|announcement|release/.test(text)) return 'innovation_update';
  if (/recap|summary|as discussed|as we discussed|meeting notes|action items/.test(text)) return 'meeting_recap';
  if (/introduction|intro|reaching out|came across your|connect/.test(text)) return 'cold_outreach';
  return 'other';
}

async function categorizeEmail(subject, body, fromName, fromEmail) {
  const apiKey = CLAUDE_API_KEY;
  const bodyExcerpt = (body || '').slice(0, 600);

  if (!apiKey) {
    const category = classifyByKeywords(subject, body);
    return { category, rationale: 'Classified by keyword matching (Claude not configured).', claude_configured: false };
  }

  const prompt =
    `Classify this email into exactly ONE of these categories:\n` +
    `cold_outreach, follow_up, conference_outreach, partnership_discussion,\n` +
    `sales_discussion, innovation_update, meeting_recap, other\n\n` +
    `From: ${fromName || ''} <${fromEmail || ''}>\n` +
    `Subject: ${subject || '(no subject)'}\n` +
    `Body excerpt:\n${bodyExcerpt}\n\n` +
    `Return ONLY a raw JSON object: { "category": "...", "rationale": "one sentence" }\n` +
    `No markdown. No code fences. Just the JSON.`;

  try {
    const res = await fetch(CLAUDE_MESSAGES_URL, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 200, messages: [{ role: 'user', content: prompt }] })
    });
    if (!res.ok) {
      const category = classifyByKeywords(subject, body);
      return { category, rationale: 'Keyword fallback (Claude API error).', claude_configured: true };
    }
    const data = await res.json();
    recordClaudeUsage(data.usage || {}, { feature: 'email_classify', model: CLAUDE_MODEL });
    const raw = (data.content && data.content[0] && data.content[0].text) || '';
    try {
      const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
      const category = EMAIL_CATEGORIES.includes(parsed.category) ? parsed.category : 'other';
      return { category, rationale: parsed.rationale || '', claude_configured: true };
    } catch {
      const category = classifyByKeywords(subject, body);
      return { category, rationale: 'Keyword fallback (parse error).', claude_configured: true };
    }
  } catch (err) {
    const category = classifyByKeywords(subject, body);
    return { category, rationale: `Keyword fallback (network error: ${err.message}).`, claude_configured: true };
  }
}

module.exports = { draftEmail, listDraftModes, categorizeEmail, EMAIL_CATEGORIES, buildPromptForMode, CLAUDE_MODEL };
