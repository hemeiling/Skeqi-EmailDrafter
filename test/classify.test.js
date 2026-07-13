// Pure unit tests -- no database needed. Covers the two root-cause bugs
// fixed in leads.js: the department-gate bug that dropped real
// procurement/ops contacts, and the classification taxonomy used both for
// that fix and for the CRM's Department/Seniority filters.
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyDepartment, classifySeniority } = require('../contactClassify');
const { isLeadershipContact } = require('../leads');

test('classifyDepartment: title-based classification wins even with a blank/unhelpful department (the reported bug)', () => {
  // The user's exact example: a title that clearly signals Procurement should
  // classify as such even when Apollo's own department field is empty.
  const result = classifyDepartment('Strategic Procurement Manager', '');
  assert.ok(result, 'should classify, not return null');
  assert.equal(result.key, 'procurement');
});

test('classifyDepartment: title-based classification wins over an unhelpful/generic raw department', () => {
  // Apollo often tags a real procurement person under a generic department
  // like "operations & logistics" -- title text should still win.
  const result = classifyDepartment('Supply Chain Manager', 'operations & logistics');
  assert.ok(result);
  assert.equal(result.key, 'supply_chain');
});

test('classifyDepartment: falls back to the raw department field when the title is generic', () => {
  const result = classifyDepartment('Manager', 'quality assurance');
  assert.ok(result);
  assert.equal(result.key, 'quality');
});

test('classifyDepartment: returns null when neither title nor department match anything', () => {
  const result = classifyDepartment('Barista', 'retail');
  assert.equal(result, null);
});

test('classifySeniority: buckets a VP/Director/Manager/IC title correctly', () => {
  assert.equal(classifySeniority('Chief Financial Officer', '').key, 'c_level');
  assert.equal(classifySeniority('VP of Operations', '').key, 'vp');
  assert.equal(classifySeniority('Director of Procurement', '').key, 'director');
  assert.equal(classifySeniority('Procurement Manager', '').key, 'manager');
  assert.equal(classifySeniority('Procurement Analyst', '').key, 'individual_contributor');
});

test('isLeadershipContact: no longer drops a procurement/ops contact solely because Apollo\'s raw department field is unhelpful (the reported bug)', () => {
  // Before the fix: qualifies (title matches PROCUREMENT_ROLES) but dept
  // ("operations & logistics") didn't textually match DEPARTMENT_KEYWORDS,
  // so `qualifies && deptOk` discarded the contact outright.
  const person = { title: 'Strategic Procurement Manager', department: 'operations & logistics', seniority: 'manager' };
  assert.equal(isLeadershipContact(person), true);
});

test('isLeadershipContact: still accepts contacts with no department field at all', () => {
  const person = { title: 'VP of Supply Chain', department: '', seniority: 'vp' };
  assert.equal(isLeadershipContact(person), true);
});

test('isLeadershipContact: still rejects a contact that qualifies on neither title, seniority, nor department', () => {
  const person = { title: 'Barista', department: 'retail', seniority: '' };
  assert.equal(isLeadershipContact(person), false);
});
