// Heuristic parsing of raw OCR text from a business card into structured fields.
// This is intentionally simple/regex-based (no external API) and is meant to
// give a good first guess -- the UI always lets the user correct it before saving.

const TITLE_WORDS = [
  'ceo', 'cto', 'cfo', 'coo', 'president', 'vice president', 'vp', 'director',
  'manager', 'engineer', 'founder', 'co-founder', 'owner', 'partner', 'consultant',
  'sales', 'marketing', 'designer', 'developer', 'architect', 'analyst',
  'representative', 'specialist', 'coordinator', 'executive', 'officer',
  'head of', 'lead', 'principal', 'supervisor', 'account manager'
];

const COMPANY_HINTS = [
  'inc', 'llc', 'ltd', 'corp', 'corporation', 'company', 'co.', 'group',
  'solutions', 'technologies', 'systems', 'partners', 'associates', 'studio', 'agency'
];

function cleanLines(text) {
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);
}

function extractEmail(text) {
  const m = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return m ? m[0] : '';
}

function extractPhone(text) {
  // Matches common phone formats: (123) 456-7890, 123-456-7890, +1 123.456.7890 etc.
  const m = text.match(/(\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
  return m ? m[0].trim() : '';
}

function extractWebsite(text, email) {
  // Strip the email out first so we don't pick up "jane.doe" from "jane.doe@x.com"
  const withoutEmail = email ? text.split(email).join(' ') : text;
  const m = withoutEmail.match(/\b((https?:\/\/)?(www\.)?[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(\.[a-zA-Z]{2,})?(\/[^\s]*)?)\b/g);
  if (!m) return '';
  const candidate = m.find(x => !x.includes('@'));
  return candidate || '';
}

function extractAddress(lines) {
  // A line with a number followed by words, or containing common address abbreviations
  const addrRegex = /\d{1,6}\s+\w+.*(street|st\.|avenue|ave\.|road|rd\.|blvd|suite|ste|drive|dr\.|lane|ln\.|floor|fl\.)/i;
  const zipRegex = /\b\d{5}(-\d{4})?\b/;
  const found = lines.filter(l => addrRegex.test(l) || zipRegex.test(l));
  return found.join(', ');
}

function looksLikeName(line) {
  const words = line.split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;
  if (/\d/.test(line)) return false;
  if (line.includes('@')) return false;
  // Most words start with a capital letter
  const capitalized = words.filter(w => /^[A-Z][a-zA-Z.'-]*$/.test(w));
  return capitalized.length >= Math.ceil(words.length * 0.6);
}

function looksLikeTitle(line) {
  const lower = line.toLowerCase();
  return TITLE_WORDS.some(t => lower.includes(t));
}

function looksLikeCompany(line) {
  const lower = line.toLowerCase();
  return COMPANY_HINTS.some(h => lower.includes(h));
}

function parseCardText(rawText) {
  const lines = cleanLines(rawText);
  const email = extractEmail(rawText);
  const phone = extractPhone(rawText);
  const website = extractWebsite(rawText, email);
  const address = extractAddress(lines);

  // Remove lines that are clearly just contact details before guessing name/title/company
  const remaining = lines.filter(l =>
    l !== email &&
    (!phone || !l.includes(phone)) &&
    (!website || l !== website) &&
    (!address || !address.includes(l)) &&
    !/^\d[\d\s()+.-]{6,}$/.test(l)
  );

  let full_name = '';
  let job_title = '';
  let company = '';
  const usedLines = new Set();

  for (const line of remaining) {
    if (!job_title && looksLikeTitle(line)) {
      job_title = line;
      usedLines.add(line);
      continue;
    }
    if (!company && looksLikeCompany(line)) {
      company = line;
      usedLines.add(line);
      continue;
    }
    if (!full_name && looksLikeName(line)) {
      full_name = line;
      usedLines.add(line);
      continue;
    }
  }

  // Fallbacks: if nothing matched heuristics, assume the first unused line is
  // the name and the next unused line is the company (a common card layout).
  // Must skip lines already consumed above (e.g. as job_title) and must never
  // fall back to a line that looks like a title -- otherwise a card laid out
  // as Name/Title/Company ends up with the title line written into both
  // job_title and company (e.g. "CEO" becoming the "company").
  if (!full_name) full_name = remaining.find(l => !usedLines.has(l)) || '';
  if (!company) company = remaining.find(l => !usedLines.has(l) && l !== full_name && !looksLikeTitle(l)) || '';

  return {
    full_name,
    job_title,
    company,
    phone,
    email,
    website,
    address,
    raw_text: rawText
  };
}

module.exports = { parseCardText };
