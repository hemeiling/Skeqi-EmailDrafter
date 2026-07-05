const ExcelJS = require('exceljs');
const { CRM_FIELDS } = require('./leads');

function csvEscape(value) {
  const s = value === undefined || value === null ? '' : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function contactsToCsv(contacts, fields) {
  const lines = [fields.join(',')];
  for (const c of contacts) {
    lines.push(fields.map((f) => csvEscape(c[f])).join(','));
  }
  return lines.join('\n');
}

function xmlEscape(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function contactsToXml(contacts) {
  const fields = [...CRM_FIELDS, 'company'];
  const rows = contacts.map((c) => {
    const inner = fields.map((f) => `    <${f}>${xmlEscape(c[f])}</${f}>`).join('\n');
    return `  <contact>\n${inner}\n  </contact>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<contacts>\n${rows}\n</contacts>`;
}

// Builds a styled Excel workbook (returns a Buffer). If any contact has a
// draft_subject set, four extra "Draft ..." columns are appended.
async function contactsToXlsx(contacts) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Contacts');

  let headers = ['Name', 'Title', 'Department', 'Company', 'Email', 'LinkedIn', 'Confidence', 'Relevance', 'Location'];
  let fields = ['name', 'title', 'department', 'company', 'email', 'linkedin', 'confidence', 'relevance', 'location'];
  let widths = [28, 34, 22, 28, 38, 42, 13, 22, 22];

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
    const rowValues = fields.map((f) => contact[f] ?? '');
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
