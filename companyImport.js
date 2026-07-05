// Parses an uploaded company-list file (CSV or XLSX) into a normalized array
// of company objects. Column mapping started as a 1:1 port of the original
// EmailDrafter app's Chinese headers, but real exports use slightly
// different variants (e.g. "展位号" vs the original's "屏位号", "切入机会"
// vs "参与机会") -- so each field accepts a list of known synonyms, tried
// in order, rather than a single hardcoded name.

const { parse: parseCsvSync } = require('csv-parse/sync');
const ExcelJS = require('exceljs');

const CSV_COLS = {
  booth: ['展位号', '屏位号', '摊位号'],
  english: ['英文名', '公司英文名', '英文名称'],
  chinese: ['中文名', '公司中文名', '中文名称'],
  category: ['类别'],
  priority: ['优先级'],
  industry: ['行业细分', '行业'],
  background: ['公司背景'],
  opportunity: ['切入机会', '参与机会', '合作机会'],
  location: ['制造地点', '生产地点'],
  contact_tip: ['联系建议']
};

// Finds the first header (from a row's keys) that matches any synonym for
// a field, tolerating surrounding whitespace. Returns the value, or ''.
function getField(row, synonyms) {
  for (const key of Object.keys(row)) {
    const trimmedKey = key.trim();
    if (synonyms.includes(trimmedKey)) {
      const val = row[key];
      return val === undefined || val === null ? '' : String(val).trim();
    }
  }
  return '';
}

function parsePriority(raw) {
  return (String(raw || '').match(/⭐/g) || []).length;
}

// rows: array of plain objects keyed by header name (already parsed from
// either CSV or XLSX). Returns the normalized company list, skipping rows
// with no English name.
function normalizeRows(rows) {
  const companies = [];
  for (const row of rows) {
    const english = getField(row, CSV_COLS.english);
    if (!english) continue;
    const priorityRaw = getField(row, CSV_COLS.priority);
    companies.push({
      booth: getField(row, CSV_COLS.booth),
      english_name: english,
      chinese_name: getField(row, CSV_COLS.chinese),
      category: getField(row, CSV_COLS.category),
      priority_raw: priorityRaw,
      priority: parsePriority(priorityRaw),
      industry: getField(row, CSV_COLS.industry),
      background: getField(row, CSV_COLS.background),
      opportunity: getField(row, CSV_COLS.opportunity),
      mfg_location: getField(row, CSV_COLS.location),
      contact_tip: getField(row, CSV_COLS.contact_tip)
    });
  }
  return companies;
}

// Returns the raw header row (first row's keys) from a parsed file, without
// filtering -- used to build a helpful error message when no English-name
// column is found, so the person can see exactly what headers were detected.
function detectHeaders(rows) {
  if (!rows || !rows.length) return [];
  return Object.keys(rows[0]).map((k) => k.trim());
}

function parseCsvCompanies(buffer) {
  // utf-8 with BOM stripped, matching the original's utf-8-sig handling
  let content = buffer.toString('utf8');
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);

  const records = parseCsvSync(content, { columns: true, skip_empty_lines: true, trim: true });
  return { companies: normalizeRows(records), headers: detectHeaders(records) };
}

async function parseXlsxCompanies(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) return { companies: [], headers: [] };

  const headerRow = ws.getRow(1).values; // 1-indexed, first element undefined
  const headers = {};
  headerRow.forEach((val, idx) => {
    if (val !== undefined && val !== null) headers[idx] = String(val).trim();
  });

  const rows = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const rowValues = ws.getRow(r).values;
    if (!rowValues || rowValues.length === 0) continue;
    const obj = {};
    rowValues.forEach((val, idx) => {
      const header = headers[idx];
      if (header) obj[header] = val === undefined || val === null ? '' : String(val);
    });
    if (Object.keys(obj).length) rows.push(obj);
  }
  return { companies: normalizeRows(rows), headers: Object.values(headers) };
}

// Dispatches by filename extension. Returns { companies, headers }.
async function parseCompanyFile(buffer, filename) {
  const lower = (filename || '').toLowerCase();
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    return parseXlsxCompanies(buffer);
  }
  return parseCsvCompanies(buffer);
}

module.exports = { parseCompanyFile };
