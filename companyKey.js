// Deterministic, punctuation/whitespace/case-only normalization used to
// de-duplicate company rows that are really the same legal entity spelled
// slightly differently (e.g. "EVE Energy Co.,Ltd." vs "EVE Energy Co., Ltd.").
//
// This intentionally does NOT try to guess corporate relationships (e.g.
// "Ford Energy" -> "Ford") -- that grouping is handled explicitly via the
// Account hierarchy (see getOrCreateAccount / upsertCompany's account_name).
// Keeping this list suffix-only keeps it safe to expand without risking
// merging two genuinely unrelated companies.
const LEGAL_SUFFIXES = [
  'co\\.,?\\s*ltd\\.?', 'ltd\\.?', 'llc\\.?', 'l\\.l\\.c\\.?', 'inc\\.?',
  'incorporated', 'corp\\.?', 'corporation', 'company', 'co\\.?',
  'gmbh', 'plc', 'pte\\.?\\s*ltd\\.?', 's\\.a\\.?', 's\\.p\\.a\\.?',
  'ag', 'bv', 'nv', 'kk', 'k\\.k\\.?'
];
const SUFFIX_RE = new RegExp(`\\s*[,.]?\\s*(${LEGAL_SUFFIXES.join('|')})\\s*$`, 'i');

function normalizeNameKey(name) {
  if (!name) return '';
  let key = String(name).trim().toLowerCase();
  // Strip one or more trailing legal-entity suffixes (handles "X Co., Ltd." -> "X").
  let prev;
  do {
    prev = key;
    key = key.replace(SUFFIX_RE, '').trim();
  } while (key !== prev && key);
  key = key
    .replace(/[.,]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  return key;
}

// Values that must never become a company/account name -- job titles,
// department/persona words, and generic placeholders. This is a WHOLE-STRING
// match (the entire trimmed name must equal one of these), never a substring
// match, so real company names are never at risk (e.g. "CATL" is nowhere
// near this list; a substring check would be the wrong tool here).
const NON_COMPANY_VALUES = new Set([
  // titles / roles
  'ceo', 'cfo', 'coo', 'cto', 'cmo', 'cio', 'vp', 'vice president', 'president',
  'director', 'manager', 'engineer', 'founder', 'co-founder', 'owner', 'partner',
  'consultant', 'sales', 'marketing', 'designer', 'developer', 'architect',
  'analyst', 'representative', 'specialist', 'coordinator', 'executive', 'officer',
  'supervisor', 'account manager', 'head of',
  // department/persona words (see contactClassify.js taxonomy)
  'procurement', 'strategic sourcing', 'supply chain', 'operations', 'manufacturing',
  'engineering', 'quality', 'digital manufacturing', 'automation', 'it',
  'information technology', 'finance', 'executive leadership', 'maintenance',
  'ehs', 'plant management', 'human resources', 'hr',
  // generic placeholders
  'n/a', 'na', 'unknown', 'none', 'tbd', 'test', '-', '--', 'n\\a'
]);

function isInvalidCompanyName(name) {
  const key = String(name || '').trim().toLowerCase().replace(/[.]+$/, '');
  return !key || NON_COMPANY_VALUES.has(key);
}

module.exports = { normalizeNameKey, isInvalidCompanyName };
