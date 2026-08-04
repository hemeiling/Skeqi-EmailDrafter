const ExcelJS = require('exceljs');
const { CRM_FIELDS } = require('./leads');

/* Email cells in an export must say something a salesperson can act on.

   Apollo's own value for "we have one but won't hand it over" is
   "(email available via Apollo, not returned in payload)", which in a
   spreadsheet reads as an instruction to go back to Apollo and click
   Reveal on every row. Exports now resolve addresses first; anything still
   unresolved is stated plainly as unavailable rather than as a placeholder
   that looks like a to-do. */
const EMAIL_UNAVAILABLE = 'Email not available 邮箱不可用';

function exportEmail(value) {
  const v = String(value === undefined || value === null ? '' : value).trim();
  if (!v) return EMAIL_UNAVAILABLE;
  if (v.startsWith('(') || v.includes('N/A') || v.toLowerCase().includes('available via apollo')) {
    return EMAIL_UNAVAILABLE;
  }
  return v;
}

/* Provenance, spelled out rather than exported as a raw key. A column
   reading "apollo_enrichment" is a database value; "Apollo enrichment" is
   an answer to "did this address cost us anything". */
const { CONTACT_SOURCES, EMAIL_SOURCES, COMPANY_SOURCES } = require('./contact-query');
const label = (list) => Object.fromEntries(list.map((o) => [o.key, `${o.label} ${o.label_cn}`]));
const SOURCE_LABEL = label(CONTACT_SOURCES);
const EMAIL_SOURCE_LABEL = label(EMAIL_SOURCES);
const COMPANY_SOURCE_LABEL = label(COMPANY_SOURCES);

function sourceLabel(v) { return SOURCE_LABEL[v] || v || 'Not recorded 未记录'; }
function companySourceLabel(v) { return COMPANY_SOURCE_LABEL[v] || v || 'Not recorded 未记录'; }
function emailSourceLabel(contact) {
  const key = contact.email_source || (contact.email ? 'legacy' : 'none');
  return EMAIL_SOURCE_LABEL[key] || key;
}

// Field-aware cell value, so every export format agrees on what an email is.
function exportValue(contact, field) {
  const raw = contact[field];
  if (field === 'email') return exportEmail(raw);
  if (field === 'source') return sourceLabel(raw);
  if (field === 'company_source') return companySourceLabel(raw);
  if (field === 'email_source') return emailSourceLabel(contact);
  return raw;
}

function csvEscape(value) {
  const s = value === undefined || value === null ? '' : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function contactsToCsv(contacts, fields) {
  const lines = [fields.join(',')];
  for (const c of contacts) {
    lines.push(fields.map((f) => csvEscape(exportValue(c, f))).join(','));
  }
  return lines.join('\n');
}

function xmlEscape(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function contactsToXml(contacts) {
  const fields = [...CRM_FIELDS, 'company', 'company_source', 'source', 'email_source'];
  const rows = contacts.map((c) => {
    const inner = fields.map((f) => `    <${f}>${xmlEscape(exportValue(c, f))}</${f}>`).join('\n');
    return `  <contact>\n${inner}\n  </contact>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<contacts>\n${rows}\n</contacts>`;
}

// Builds a styled Excel workbook (returns a Buffer). If any contact has a
// draft_subject set, four extra "Draft ..." columns are appended.
async function contactsToXlsx(contacts) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Contacts');

  // The provenance chain sits together, in the order it happened, rather
  // than being scattered across the sheet.
  let headers = ['Name', 'Title', 'Department', 'Company', 'Email',
                 'Company Source 公司来源', 'Contact Source 联系人来源', 'Email Source 邮箱来源',
                 'LinkedIn', 'Confidence', 'Relevance', 'Location'];
  let fields = ['name', 'title', 'department', 'company', 'email',
                'company_source', 'source', 'email_source',
                'linkedin', 'confidence', 'relevance', 'location'];
  let widths = [28, 34, 22, 28, 38, 24, 22, 26, 42, 13, 22, 22];

  const hasDrafts = contacts.some((c) => c.draft_subject);
  if (hasDrafts) {
    headers = [...headers, 'Draft Subject', 'Draft Body', 'Draft Follow-up', 'Draft Rationale'];
    fields = [...fields, 'draft_subject', 'draft_body', 'draft_followup', 'draft_rationale'];
    widths = [...widths, 32, 70, 45, 45];
  }

  ws.columns = fields.map((f, i) => ({ key: f, width: widths[i] }));

  const headerRow = ws.addRow(headers);
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A2E4A' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  const draftFieldSet = new Set(['draft_subject', 'draft_body', 'draft_followup', 'draft_rationale']);

  contacts.forEach((contact, idx) => {
    const rowValues = fields.map((f) => exportValue(contact, f) ?? '');
    const row = ws.addRow(rowValues);
    const isEvenRow = (idx + 2) % 2 === 0;

    fields.forEach((f, colIdx) => {
      const cell = row.getCell(colIdx + 1);
      const isDraftCol = draftFieldSet.has(f);
      cell.alignment = { wrapText: isDraftCol, vertical: isDraftCol ? 'top' : 'middle' };

      if (isDraftCol && contact[f]) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0FDF4' } };
      } else if (isEvenRow) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
      }

      if (f === 'linkedin' && contact.linkedin) {
        cell.value = { text: contact.linkedin, hyperlink: contact.linkedin };
        cell.font = { color: { argb: 'FF0A66C2' }, underline: true };
      }
    });

    if (hasDrafts && contact.draft_subject) row.height = 60;
  });

  return wb.xlsx.writeBuffer();
}

function safeFilename(name) {
  return String(name || 'contacts').replace(/[^\w-]/g, '_');
}

module.exports = { contactsToCsv, contactsToXml, contactsToXlsx, safeFilename };
