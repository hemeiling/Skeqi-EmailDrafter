// Pure unit tests for the AI-research helpers (research.js) and the tag-guard
// invariant (db.js). No database or network — these always run.
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildResearchPrompt, parseResearchResponse, validateSuggestions,
  extractSources, textFromContent, companyCategories
} = require('../research');
const db = require('../db');

// Minimal taxonomy fixture mirroring the real seed shape.
const TAXONOMY = [
  { key: 'segment', name_en: 'Segment', applies_to: 'company', parent_category_key: null,
    tags: [{ value: 'Energy Storage' }, { value: 'Power Battery' }] },
  { key: 'cell_format', name_en: 'Cell Format', applies_to: 'company', parent_category_key: null,
    tags: [{ value: 'Prismatic' }, { value: 'Cylindrical' }, { value: 'Pouch' }] },
  { key: 'contact_role', name_en: 'Contact Role', applies_to: 'contact', parent_category_key: null,
    tags: [{ value: 'R&D' }, { value: 'Engineering' }] },
];

test('companyCategories excludes contact-scoped categories', () => {
  const keys = companyCategories(TAXONOMY).map((c) => c.key);
  assert.deepEqual(keys, ['segment', 'cell_format']);
});

test('buildResearchPrompt lists only company vocab and the company name', () => {
  const prompt = buildResearchPrompt({ name: 'CATL', website: 'catl.com' }, TAXONOMY);
  assert.match(prompt, /CATL/);
  assert.match(prompt, /catl\.com/);
  assert.match(prompt, /\[segment\]: Energy Storage \| Power Battery/);
  assert.match(prompt, /\[cell_format\]: Prismatic \| Cylindrical \| Pouch/);
  // contact_role must NOT appear — it's not a company category
  assert.doesNotMatch(prompt, /\[contact_role\]/);
});

test('validateSuggestions keeps valid tags, drops hallucinated ones, clamps confidence', () => {
  const { valid, dropped } = validateSuggestions([
    { category_key: 'segment', value: 'Energy Storage', confidence: 0.9 },
    { category_key: 'cell_format', value: 'Prismatic', confidence: 1.7 }, // clamp to 1
    { category_key: 'segment', value: 'Nuclear' },                        // invalid value
    { category_key: 'made_up', value: 'X' },                              // invalid category
  ], TAXONOMY);
  assert.equal(valid.length, 2);
  assert.equal(valid[0].value, 'Energy Storage');
  assert.equal(valid[1].confidence, 1); // clamped
  assert.equal(dropped.length, 2);
});

test('parseResearchResponse handles raw JSON, fenced JSON, and garbage', () => {
  const raw = parseResearchResponse('{"summary":"s","company_tags":[{"category_key":"segment","value":"Power Battery"}],"missing_info":[]}');
  assert.equal(raw.summary, 's');
  assert.equal(raw.company_tags.length, 1);

  const fenced = parseResearchResponse('Here you go:\n```json\n{"summary":"x","company_tags":[],"missing_info":["a"]}\n```');
  assert.equal(fenced.summary, 'x');
  assert.deepEqual(fenced.missing_info, ['a']);

  const garbage = parseResearchResponse('not json at all');
  assert.deepEqual(garbage, { summary: '', company_tags: [], missing_info: [] });
});

test('extractSources / textFromContent read Claude content blocks', () => {
  const content = [
    { type: 'text', text: 'Based on research, ' },
    { type: 'web_search_tool_result', content: [
      { type: 'web_search_result', url: 'https://a.com', title: 'A' },
      { type: 'web_search_result', url: 'https://b.com' },
    ] },
    { type: 'text', text: 'the answer.' },
  ];
  assert.equal(textFromContent(content), 'Based on research, the answer.');
  const sources = extractSources(content);
  assert.deepEqual(sources, [
    { url: 'https://a.com', title: 'A' },
    { url: 'https://b.com', title: 'https://b.com' },
  ]);
});

test('shouldReplaceWithSuggestion protects human-reviewed tags only', () => {
  // AI may fill/refresh these:
  assert.equal(db.shouldReplaceWithSuggestion(null), true);
  assert.equal(db.shouldReplaceWithSuggestion('ai_suggested'), true);
  assert.equal(db.shouldReplaceWithSuggestion('needs_review'), true);
  // AI must never overwrite these:
  assert.equal(db.shouldReplaceWithSuggestion('user_confirmed'), false);
  assert.equal(db.shouldReplaceWithSuggestion('manual'), false);
  assert.equal(db.shouldReplaceWithSuggestion('rejected'), false);
  assert.deepEqual(db.PROTECTED_TAG_SOURCES, ['user_confirmed', 'manual', 'rejected']);
});
