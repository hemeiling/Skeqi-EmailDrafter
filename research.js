// AI company research → suggested customer tags, powered by Claude's server-side
// web_search tool. Mirrors claude.js's raw-fetch + usage-recording conventions.
//
// The model researches a company from public info and proposes tags drawn ONLY
// from the curated taxonomy. Every suggestion carries a confidence score and is
// returned for human review — nothing here writes to the DB or confirms a tag.

const CLAUDE_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
// web_search_20260209 (dynamic filtering) is supported on claude-sonnet-4-6 —
// the model claude.js already uses, kept here for consistency. Swap this one
// constant to use a more capable model for research.
const RESEARCH_MODEL = 'claude-sonnet-4-6';
const WEB_SEARCH_TOOL = { type: 'web_search_20260209', name: 'web_search', max_uses: 5 };
const MAX_CONTINUATIONS = 4; // safety bound on pause_turn resumes

const { isClaudeConfigured, CLAUDE_API_KEY } = require('./config');

function isConfigured() {
  return isClaudeConfigured();
}

// Only company-scoped categories are researched; contact roles are per-person.
// onlyCategories (optional) restricts to a subset — used to fill ONLY the
// categories a company is currently missing, saving tokens on a refresh.
function companyCategories(taxonomy, onlyCategories) {
  let cats = (taxonomy || []).filter((c) => c.applies_to === 'company');
  if (onlyCategories && onlyCategories.length) {
    const set = new Set(onlyCategories);
    cats = cats.filter((c) => set.has(c.key));
  }
  return cats;
}

// Compact, unambiguous rendering of the allowed vocabulary for the prompt.
function buildResearchPrompt(company, taxonomy, onlyCategories) {
  const name = company.name || '(unknown company)';
  const facts = [];
  if (company.website) facts.push(`Website: ${company.website}`);
  if (company.industry) facts.push(`Industry: ${company.industry}`);
  if (company.chinese_name) facts.push(`Chinese name: ${company.chinese_name}`);
  if (company.mfg_location) facts.push(`Manufacturing location: ${company.mfg_location}`);
  if (company.notes) facts.push(`Notes: ${company.notes}`);
  const factBlock = facts.length ? `\nKnown facts:\n${facts.join('\n')}\n` : '';

  const vocab = companyCategories(taxonomy, onlyCategories)
    .map((c) => {
      const values = (c.tags || []).map((t) => t.value).join(' | ');
      return `- ${c.name_en} [${c.key}]: ${values}`;
    })
    .join('\n');

  return (
    `You are a B2B market analyst for SKQ, a battery-manufacturing equipment supplier ` +
    `(cell / module / PACK assembly lines, welding, testing, automation).\n\n` +
    `Research the company "${name}" using web search and classify it against SKQ's ` +
    `customer taxonomy, so SKQ can target outreach and recommend relevant equipment.\n` +
    factBlock +
    `\nAllowed tag categories and values (choose ONLY from these exact values):\n${vocab}\n\n` +
    `Rules:\n` +
    `1. Search the web for the company's actual business — battery segment, applications, ` +
    `cell formats, product scope, and manufacturing priorities.\n` +
    `2. Only assign a tag when public evidence supports it. Do NOT guess to fill every category.\n` +
    `3. Use the EXACT value strings and the bracketed category_key shown above.\n` +
    `4. confidence is 0.0–1.0 reflecting how strongly the evidence supports the tag.\n` +
    `5. List any category you could not determine under missing_info.\n\n` +
    `Return ONLY a raw JSON object (no markdown, no code fences) with exactly:\n` +
    `{\n` +
    `  "summary": "2-4 sentence plain-English summary of what the company does",\n` +
    `  "company_tags": [ { "category_key": "...", "value": "...", "confidence": 0.0, "evidence": "one phrase" } ],\n` +
    `  "missing_info": [ "short note on what could not be determined" ]\n` +
    `}`
  );
}

// Extract the concatenated final text from a Claude response's content blocks.
function textFromContent(content) {
  return (content || [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

// Pull {url, title} citations out of web_search_tool_result blocks.
function extractSources(content) {
  const sources = [];
  for (const block of content || []) {
    if (block.type !== 'web_search_tool_result') continue;
    const results = Array.isArray(block.content) ? block.content : [];
    for (const r of results) {
      if (r && r.type === 'web_search_result' && r.url) {
        sources.push({ url: r.url, title: r.title || r.url });
      }
    }
  }
  return sources;
}

function parseResearchResponse(rawText) {
  const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  let parsed = tryParse(rawText);
  if (!parsed) {
    const match = rawText.match(/\{[\s\S]*\}/);
    if (match) parsed = tryParse(match[0]);
  }
  if (!parsed || typeof parsed !== 'object') {
    return { summary: '', company_tags: [], missing_info: [] };
  }
  return {
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    company_tags: Array.isArray(parsed.company_tags) ? parsed.company_tags : [],
    missing_info: Array.isArray(parsed.missing_info) ? parsed.missing_info : []
  };
}

// Keep only suggestions whose (category_key, value) exist in the taxonomy, so a
// hallucinated tag never reaches the DB. Returns the validated tags plus any
// that were dropped (for surfacing/debugging).
function validateSuggestions(companyTags, taxonomy) {
  const allowed = new Map(); // category_key -> Set(values)
  for (const c of companyCategories(taxonomy)) {
    allowed.set(c.key, new Set((c.tags || []).map((t) => t.value)));
  }
  const valid = [];
  const dropped = [];
  for (const s of companyTags || []) {
    const key = s && s.category_key;
    const value = s && s.value;
    const conf = typeof s.confidence === 'number' ? Math.max(0, Math.min(1, s.confidence)) : null;
    if (allowed.has(key) && allowed.get(key).has(value)) {
      valid.push({ category_key: key, value, confidence: conf, evidence: s.evidence || '' });
    } else if (key || value) {
      dropped.push({ category_key: key, value });
    }
  }
  return { valid, dropped };
}

function offlineResearchStub(company) {
  return {
    summary: '',
    tags: [],
    missing_info: ['Claude API key not configured — AI research unavailable. Add tags manually.'],
    sources: [],
    claude_configured: false
  };
}

// Runs the web_search-backed research request, resuming across any pause_turn
// server-tool boundaries, then validates the result against the taxonomy.
// company: { name, website, industry, chinese_name, mfg_location, notes }
// taxonomy: output of db.getTaxonomy()
// opts.onlyCategories: restrict research to these company category keys (missing-only refresh)
async function researchCompanyTags(company, taxonomy, opts = {}) {
  const apiKey = CLAUDE_API_KEY;
  if (!apiKey) return offlineResearchStub(company);

  const onlyCategories = opts.onlyCategories || null;
  const prompt = buildResearchPrompt(company, taxonomy, onlyCategories);
  const messages = [{ role: 'user', content: prompt }];
  const sources = [];
  const usageAcc = { input_tokens: 0, output_tokens: 0 };

  try {
    let finalContent = [];
    for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
      const res = await fetch(CLAUDE_MESSAGES_URL, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: RESEARCH_MODEL,
          max_tokens: 3000,
          tools: [WEB_SEARCH_TOOL],
          messages
        })
      });

      if (!res.ok) {
        const text = await res.text();
        return {
          summary: '', tags: [], missing_info: [`Claude API error ${res.status}: ${text.slice(0, 200)}`],
          sources: [], claude_configured: true, error: true
        };
      }

      const data = await res.json();
      const u = data.usage || {};
      usageAcc.input_tokens += u.input_tokens || 0;
      usageAcc.output_tokens += u.output_tokens || 0;
      const content = data.content || [];
      sources.push(...extractSources(content));
      finalContent = content;

      if (data.stop_reason === 'pause_turn') {
        // Re-send with the assistant turn appended; server resumes the tool loop.
        messages.push({ role: 'assistant', content });
        continue;
      }
      break;
    }

    const parsed = parseResearchResponse(textFromContent(finalContent));
    const { valid } = validateSuggestions(parsed.company_tags, taxonomy);
    // De-dupe sources by URL, preserving first title seen.
    const seen = new Set();
    const uniqueSources = sources.filter((s) => (seen.has(s.url) ? false : seen.add(s.url)));
    return {
      summary: parsed.summary,
      tags: valid,
      missing_info: parsed.missing_info,
      sources: uniqueSources,
      claude_configured: true,
      usage: { input_tokens: usageAcc.input_tokens, output_tokens: usageAcc.output_tokens, model: RESEARCH_MODEL }
    };
  } catch (err) {
    return {
      summary: '', tags: [], missing_info: [`Network error calling Claude: ${err.message}`],
      sources: [], claude_configured: true, error: true
    };
  }
}

module.exports = {
  researchCompanyTags,
  isConfigured,
  // exported for unit testing (pure helpers)
  buildResearchPrompt,
  parseResearchResponse,
  validateSuggestions,
  extractSources,
  textFromContent,
  companyCategories
};
