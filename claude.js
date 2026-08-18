/* Drafts a personalized outreach email, given a contact and (optionally) the
   sender's own identity. Ported from EmailDrafter's call_claude(), simplified
   (no CSV-upload company context).

   This file owns the PROMPTS and the PARSING. It no longer owns the vendor:
   which model writes the email is emailModel.js's decision — Qwen 3.6 Flash
   by default, or whichever the user picked, falling back through the other
   configured providers — so the prompt work below is identical whoever
   serves it. Research keeps its own Claude calls elsewhere and does not come
   through here. */

const { recordClaudeUsage } = require('./usage');
const { runEmailModel } = require('./emailModel');

const { isClaudeConfigured, isEmailModelConfigured, CLAUDE_EMAIL_FALLBACK_MODEL } = require('./config');
// Kept as a named export: server.js reports it, and the Prompt Inspector
// shows which model a draft would use.
const CLAUDE_MODEL = CLAUDE_EMAIL_FALLBACK_MODEL;

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

/* What the user typed into "Additional instructions", given its own block.

   It used to be one bullet inside a general "Additional context" list, on
   equal footing with an event name — so a direct instruction ("mention our
   new automation line, offer a factory tour") competed with background
   detail and often lost. It is the most specific thing the user said about
   this one email, so it is stated last, labelled as an instruction, and
   given explicit precedence over the generic requirements above it.

   Returns '' when there are none, so prompts are unchanged without them. */
function senderInstructionBlock(context = {}) {
  const v = String(context.extraInstructions || '').trim();
  if (!v) return '';
  return (
    `\n\nSender's instructions for THIS email (highest priority — follow these even where they ` +
    `conflict with the numbered requirements above; if they ask for something specific, it must ` +
    `appear in the email):\n${v}\n`
  );
}

/* Event / company notes. Shared by every mode so the default cold-outreach
   prompt stops being the only one that silently discards them. */
function backgroundContextBlock(context = {}) {
  const lines = [];
  if (context.eventName) lines.push(`- Event: ${context.eventName}`);
  if (context.companyNotes) lines.push(`- Company notes: ${context.companyNotes}`);
  if (!lines.length) return '';
  return `\n\nAdditional context (use this to personalize the email; don't invent beyond it):\n${lines.join('\n')}\n`;
}

/* Greeting + signature: the two things generated drafts kept omitting.

   Emails were opening straight into the pitch ("Scaling cylindrical cell
   supply...") because the prompt only ever said "Sign off as: X" — it named
   an identity but never required a greeting, an introduction or a signature
   block. These make the whole envelope explicit.

   Nothing here is inferred. The greeting uses the recipient fields we
   actually hold, and the signature lists only the sender details that are
   configured — a plausible but invented phone number or address is worse
   than an absent one. */
function greetingRule(contact = {}) {
  const first = String(contact.first_name || '').trim();
  const full = String(contact.name || '').trim();
  const last = String(contact.last_name || '').trim();
  if (first) return `Greet them by first name: "Hi ${first},"`;
  if (full) {
    // Apollo obfuscates surnames ("Dory Tu***g"), so a masked name must never
    // be printed — fall back to the clean leading token when there is one.
    const lead = full.split(/\s+/)[0];
    if (lead && !lead.includes('*')) return `Greet them as "Hi ${lead}," using only their first name.`;
    return `Greet them as "Hi ${full}," using the full name exactly as written.`;
  }
  if (last) return `Greet them as "Dear Mr./Ms. ${last}," choosing the honorific only if the contact's gender is unambiguous from the information given; otherwise use "Dear ${last},".`;
  return `Open with a professional greeting such as "Hello," — do not invent a name.`;
}

function signatureBlock(sender = {}) {
  const lines = [];
  if (sender.name) lines.push(sender.name);
  if (sender.title) lines.push(sender.title);
  if (sender.company) lines.push(sender.company);
  if (sender.email) lines.push(sender.email);
  if (sender.phone) lines.push(sender.phone);
  if (sender.website) lines.push(sender.website);
  if (!lines.length) return 'Close with "Best regards," followed by [Your Name] as a placeholder.';
  return (
    `Close with "Best regards," (or the equivalent in the email's language) on its own line, ` +
    `then this signature block EXACTLY as given, one item per line, adding nothing and inventing ` +
    `no extra contact details:\n${lines.join('\n')}`
  );
}

/* The structural requirements every draft must satisfy. Appended to each
   mode so a mode can change the angle without dropping the envelope. */
function emailStructureBlock(contact = {}, sender = {}) {
  const intro = sender.name
    ? `Introduce the sender in the second sentence: their name${sender.title ? ', role' : ''}${sender.company ? ' and company' : ''} — e.g. "My name is ${sender.name}${sender.title ? ', ' + sender.title : ''}${sender.company ? ' at ' + sender.company : ''}." Do this once, briefly, and never repeat it later in the email.`
    : `Introduce the sender briefly in the second sentence.`;
  return (
    `\n\nEmail structure (required — a draft missing any of these is incomplete):\n` +
    `1. Greeting on its own line. ${greetingRule(contact)}\n` +
    `2. ${intro}\n` +
    `3. A personalized opening tied to this recipient or their company.\n` +
    `4. The value proposition — what is being offered and why it matters to them.\n` +
    `5. A clear call to action.\n` +
    `6. ${signatureBlock(sender)}\n` +
    `Separate these with blank lines so the result reads as a finished email, not a paragraph. ` +
    `Do NOT start the email with the pitch.\n`
  );
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
    `${senderBlock}${backgroundContextBlock(context)}${customerProfileBlock(context)}\n\n` +
    `Now write the outreach email. Requirements:\n` +
    `1. First person, from the sender's voice\n` +
    `2. Open with a specific, relevant observation about the recipient's role or company (not a generic compliment)\n` +
    `3. In one sentence, connect what the sender offers to a real challenge or goal the recipient likely faces in their ${dept} role\n` +
    `4. 4-6 sentences total — conversational, not salesy\n` +
    `5. Close with a low-pressure CTA: suggest a 20-30 min call\n` +
    `${emailStructureBlock(contact, sender)}` +
    `\nWrite it the way one person emails another, not the way a template fills slots: vary the\n` +
    `sentence lengths, use ordinary contractions, and cut any phrase that could appear in an email\n` +
    `to a different company. Avoid opening with "I hope this finds you well", "I came across", or\n` +
    `"I wanted to reach out".\n` +
    `${senderInstructionBlock(context)}` +
    `${draftOptionsBlock(context.options)}` +
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

// Labels are bilingual at the source: they are served to the client and
// rendered inside <option> elements, which cannot carry the markup the
// client-side pass uses. `label` stays the display string; `label_en` is
// kept for anything that needs the English alone (prompts, logs, exports).
const DRAFT_MODES = {
  cold_outreach:        { label_en: 'Standard cold outreach (original)', label: 'Standard cold outreach 标准陌生开发' },
  procurement_outreach: { label_en: 'Procurement outreach',             label: 'Procurement outreach 采购部门开发' },
  engineering_outreach: { label_en: 'Engineering outreach',             label: 'Engineering outreach 工程部门开发' },
  conference_outreach:  { label_en: 'Conference outreach',              label: 'Conference outreach 展会开发' },
  general_follow_up:    { label_en: 'General follow-up',                label: 'General follow-up 常规跟进' },
  company_innovations:  { label_en: 'Sharing company innovations',      label: 'Company innovations 公司创新分享' },
  partnership_intro:    { label_en: 'Partnership introduction',         label: 'Partnership introduction 合作介绍' },
  sales_outreach:       { label_en: 'Sales outreach',                   label: 'Sales outreach 销售开发' },
  post_meeting_follow_up:{ label_en: 'Post-meeting follow-up',          label: 'Post-meeting follow-up 会后跟进' }
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

/* =========================================================================
   Generation options — length, tone, language, call to action.

   Every mode above hardcodes a sentence count ("4-6 sentences total"). When
   the user asks for a specific length that instruction is not merely
   redundant, it actively contradicts the request, so the options block is
   emitted LAST and says so explicitly: a later, explicit instruction beats
   an earlier default. The mode requirement is left in place rather than
   rewritten so that the modes stay readable on their own.

   Word counts are ranges rather than exact targets because language models
   hit "roughly 120 words" far more reliably than "exactly 120", and a hard
   number invites padding to reach it.
   ========================================================================= */

const DRAFT_LENGTHS = {
  ultra_short: { label: 'Ultra short', words: [50, 80],   hint: '2-3 sentences' },
  short:       { label: 'Short',       words: [80, 150],  hint: '3-5 sentences' },
  medium:      { label: 'Medium',      words: [150, 250], hint: '5-8 sentences', default: true },
  long:        { label: 'Long',        words: [250, 400], hint: '2-3 short paragraphs' },
  custom:      { label: 'Custom',      words: null,       hint: 'your own word count' },
};

const DRAFT_TONES = {
  professional: { label: 'Professional', instruction: 'Professional and businesslike: clear, courteous, no slang, no exclamation marks.' },
  warm:         { label: 'Warm',         instruction: 'Warm and personable: friendly and human, while still businesslike.' },
  direct:       { label: 'Direct',       instruction: 'Direct and concise: lead with the point, cut hedging and pleasantries.' },
  consultative: { label: 'Consultative', instruction: 'Consultative and expert: lead with insight and a point of view, not a pitch.' },
  formal:       { label: 'Formal',       instruction: 'Formal and deferential: full sentences, honorifics where natural, no contractions.' },
};

/* Language applies to the WHOLE email, not just the body: subject, greeting,
   call to action and sign-off included. Saying so explicitly is what stops
   the model producing an English subject over a Chinese body. */
const DRAFT_LANGUAGES = {
  english: {
    label: 'English', unit: 'words',
    instruction: 'Write the ENTIRE email in English — subject line, greeting, body, call to action, sign-off and the follow-up line. Use English business conventions for the greeting and closing.',
  },
  chinese: {
    label: 'Chinese 中文', unit: 'chars',
    instruction: 'Write the ENTIRE email in Simplified Chinese (简体中文) — subject line, greeting, body, call to action, sign-off and the follow-up line. Use natural business Chinese and Chinese salutation/closing conventions (e.g. 您好 / 此致敬礼), not a literal translation of English phrasing.',
  },
  bilingual: {
    label: 'Bilingual 双语', unit: 'both',
    instruction: 'Write the email BILINGUALLY: first the complete English version, then a horizontal rule line "---", then the complete Simplified Chinese version. Both versions must carry the same message, greeting, call to action and sign-off — the Chinese half is a natural business-Chinese rendering, not a literal translation. The subject line must contain both, as "English subject / 中文主题".',
  },
  match: {
    label: 'Match recipient 匹配收件人', unit: 'words',
    instruction: "Infer the recipient's working language from their name, company and location, and write the ENTIRE email in that language — subject, greeting, body, call to action and sign-off. If it is genuinely unclear, use English.",
  },
};

const DRAFT_CTAS = {
  auto:     { label: 'Default for this type', instruction: null },
  call:     { label: 'Book a call',     instruction: 'Close by proposing a specific short call, and offer two concrete time options.' },
  meet:     { label: 'Meet in person',  instruction: 'Close by proposing an in-person meeting (at their site or the event being referenced).' },
  materials:{ label: 'Send materials',  instruction: 'Close by offering to send a specific document, spec sheet or case study — no meeting ask.' },
  reply:    { label: 'Just ask a reply',instruction: 'Close with a single low-friction question that can be answered in one line. Do not ask for a meeting.' },
  none:     { label: 'No ask',          instruction: 'Do not ask for anything. Close by leaving the door open, with no call to action.' },
};

function normalizeDraftOptions(raw = {}) {
  const o = raw || {};
  const length = DRAFT_LENGTHS[o.length] ? o.length : 'medium';
  let words = DRAFT_LENGTHS[length].words;
  if (length === 'custom') {
    // Clamp: below ~30 words there is no email left, above ~600 it stops
    // being outreach. A single number becomes a ±15% band for the reason above.
    const n = Math.max(30, Math.min(600, Number(o.customWords) || 150));
    words = [Math.round(n * 0.85), Math.round(n * 1.15)];
  }
  return {
    length,
    words,
    customWords: length === 'custom' ? Math.max(30, Math.min(600, Number(o.customWords) || 150)) : null,
    tone: DRAFT_TONES[o.tone] ? o.tone : 'professional',
    language: DRAFT_LANGUAGES[o.language] ? o.language : 'english',
    cta: DRAFT_CTAS[o.cta] ? o.cta : 'auto',
    // Which model writes it. Validated in emailModel.resolveEmailModelId, so
    // an unknown or no-longer-configured id degrades to the default.
    modelId: typeof o.modelId === 'string' ? o.modelId : null,
  };
}

// A stable string identifying one set of options, so a saved draft is only
// reused when it was generated under the same ones. Defaults produce the
// empty string, which keeps every pre-existing draft reusable as before.
/* The model is part of the signature. Two models given the same brief write
   genuinely different emails, so a draft produced by one must not be served
   as a cache hit when the user has since switched to another — switching the
   selector should produce a new draft, not silently replay the old one. The
   default model contributes nothing, so every draft written before the
   selector existed stays reusable exactly as before. */
function draftOptionsSignature(raw) {
  const o = normalizeDraftOptions(raw);
  const { DEFAULT_EMAIL_MODEL_ID } = require('./config');
  const modelPart = o.modelId && o.modelId !== DEFAULT_EMAIL_MODEL_ID ? o.modelId : '';
  if (o.length === 'medium' && o.tone === 'professional' && o.language === 'english' && o.cta === 'auto' && !modelPart) return '';
  return [o.length, o.length === 'custom' ? o.customWords : '', o.tone, o.language, o.cta, modelPart].join('|');
}

function draftOptionsBlock(raw) {
  const o = normalizeDraftOptions(raw);

  // Chinese is written in characters, not space-delimited words, so asking
  // for "60 words" of Chinese means nothing. One English word is roughly 1.8
  // Chinese characters. Bilingual states both, because each half is measured
  // in its own unit and the total is naturally about double.
  const unit = (DRAFT_LANGUAGES[o.language] || {}).unit || 'words';
  const zhLo = Math.round(o.words[0] * 1.8), zhHi = Math.round(o.words[1] * 1.8);
  const budget = unit === 'chars'
    ? `约 ${zhLo}-${zhHi} 个汉字 (about ${zhLo}-${zhHi} Chinese characters)`
    : unit === 'both'
      ? `about ${o.words[0]}-${o.words[1]} words for the English version AND 约 ${zhLo}-${zhHi} 个汉字 for the Chinese version (each half separately, not combined)`
      : `about ${o.words[0]}-${o.words[1]} words`;

  // A word budget alone loses to the numbered requirements above, which each
  // demand their own sentence: asking for 50-80 words while still requiring an
  // observation, a value connection, a CTA and a sign-off reliably produced
  // ~115 words. Under a tight budget the model has to be told it may drop
  // requirements, and which one to keep.
  const tight = o.words[1] <= 150;
  const lengthLine = tight
    ? `- Length: ${budget} for the email body — a hard budget. It takes priority over completeness: `
      + `cover only the single most important point, and omit or merge any requirement above that does not fit. `
      + `Do not pad to reach the range, and do not exceed it.`
    : `- Length: ${budget} for the email body. This OVERRIDES any sentence count given above; `
      + `expand or compress the requirements to fit rather than padding.`;

  const lines = [
    lengthLine,
    `- Tone: ${DRAFT_TONES[o.tone].instruction}`,
    `- Language: ${DRAFT_LANGUAGES[o.language].instruction}`,
  ];
  if (DRAFT_CTAS[o.cta].instruction) {
    lines.push(`- Call to action: ${DRAFT_CTAS[o.cta].instruction} This REPLACES the closing instruction given above.`);
  }
  return `\n\nOutput controls (these take priority over the numbered requirements above where they conflict):\n${lines.join('\n')}\n`;
}

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
    `You are drafting a "${DRAFT_MODES[mode].label_en || DRAFT_MODES[mode].label}" email on behalf of a specific person.\n` +
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
    `${emailStructureBlock(contact, sender)}` +
    `${senderInstructionBlock(context)}` +
    `${draftOptionsBlock(context.options)}` +
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
  // "Is drafting available at all", not "is Claude available" — an OpenAI-only
  // deployment must not fall through to the offline template stub. The
  // response field keeps its name because the browser reads it.
  if (!isEmailModelConfigured()) {
    return { ...offlineStub(contact, sender, mode, context), claude_configured: false };
  }

  /* An edited prompt from the Prompt Inspector wins over the assembled one.

     The Inspector splits the prompt into contiguous sections that concatenate
     back to it byte-for-byte, so an edit changes exactly what the user
     changed and nothing else. It is per-draft: nothing is persisted, so the
     next draft starts from the assembled prompt again. */
  const prompt = (context && typeof context.promptOverride === 'string' && context.promptOverride.trim())
    ? context.promptOverride
    : buildPromptForMode(mode, contact, sender, context);

  /* Provider choice lives in emailModel.js, so the prompt assembled above and
     the parsing below are identical whoever serves it. The prompt already
     specifies JSON output, so `json: true` only enforces what it asks for. */
  // The user's choice reaches the shared abstraction as a preference; the
  // chain, fallback and accounting all stay in emailModel.js.
  const r = await runEmailModel(prompt, { json: true, modelId: (context && context.options && context.options.modelId) || null });
  if (!r.ok) {
    return {
      subject: '', body: r.error, followup: '', rationale: '', claude_configured: true,
    };
  }

  const draft = parseDraftResponse(r.text);
  // Usage is recorded by the server route (which has feature/company/contact
  // context). It carries the provider that actually ran, so cost is priced
  // against the right table even when the request fell back.
  return { ...draft, claude_configured: true,
    _usage: { ...r.usage, requested_provider: r.requested_provider, fell_back: r.fell_back } };
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
  const bodyExcerpt = (body || '').slice(0, 600);

  if (!isEmailModelConfigured()) {
    const category = classifyByKeywords(subject, body);
    return { category, rationale: 'Classified by keyword matching (no email model configured).', claude_configured: false };
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

  /* 1000 rather than the old 200: on a reasoning model the cap covers thinking
     tokens too, and a cap that small can be spent entirely on reasoning and
     return nothing. A cap is not a reservation — unused budget costs nothing,
     and the keyword fallback below still catches an empty reply. */
  const r = await runEmailModel(prompt, { maxTokens: 1000, json: true });
  if (!r.ok) {
    const category = classifyByKeywords(subject, body);
    return { category, rationale: 'Keyword fallback (email model error).', claude_configured: true };
  }

  recordClaudeUsage(r.usage, { feature: 'email_classify', model: r.usage.model, provider: r.usage.provider });
  try {
    const parsed = JSON.parse((r.text || '').match(/\{[\s\S]*\}/)?.[0] || r.text);
    const category = EMAIL_CATEGORIES.includes(parsed.category) ? parsed.category : 'other';
    return { category, rationale: parsed.rationale || '', claude_configured: true };
  } catch {
    const category = classifyByKeywords(subject, body);
    return { category, rationale: 'Keyword fallback (parse error).', claude_configured: true };
  }
}

module.exports = {
  draftEmail, listDraftModes, categorizeEmail, EMAIL_CATEGORIES, buildPromptForMode, CLAUDE_MODEL,
  DRAFT_LENGTHS, DRAFT_TONES, DRAFT_LANGUAGES, DRAFT_CTAS,
  normalizeDraftOptions, draftOptionsSignature,
};
