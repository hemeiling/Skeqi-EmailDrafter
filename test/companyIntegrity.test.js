// Pure unit tests -- no database needed. Covers the root-cause fixes for the
// "CEO appearing as a company" and "Ford search returns unrelated dealerships"
// bugs: parse.js's OCR fallback, the shared invalid-company-name blocklist,
// and the Apollo name-prefix relevance filter.
const test = require('node:test');
const assert = require('node:assert/strict');
const { isInvalidCompanyName } = require('../companyKey');
const { isPlausiblyRelatedCompany } = require('../leads');
const { parseCardText } = require('../parse');

test('isInvalidCompanyName rejects job titles, department words, and generic placeholders', () => {
  ['CEO', 'ceo', 'CFO', 'VP', 'Director', 'Engineering', 'Procurement', 'Operations', 'N/A', 'Unknown', ''].forEach((v) => {
    assert.equal(isInvalidCompanyName(v), true, `"${v}" should be invalid`);
  });
});

test('isInvalidCompanyName accepts real company names (whole-string match, not substring)', () => {
  ['CATL', 'Ford', 'Ford Motor Company', 'EVE Energy Co.,Ltd.', 'Directorate Solutions Inc.'].forEach((v) => {
    assert.equal(isInvalidCompanyName(v), false, `"${v}" should be a valid company name`);
  });
});

test('parse.js regression: a Name/Title/Company card layout no longer duplicates the title into the company field (reproduces contact id=1\'s exact bug)', () => {
  const result = parseCardText('Vishnu Reddy\nCEO\nCATL\nvishnu@catl.com\n+1 555 123 4567');
  assert.equal(result.job_title, 'CEO');
  assert.equal(result.company, 'CATL');
  assert.notEqual(result.company, result.job_title);
});

test('parse.js: a title-only card with no clear company line does not fall back to the title itself', () => {
  const result = parseCardText('Jane Doe\nDirector\njane@example.com');
  assert.equal(result.job_title, 'Director');
  assert.notEqual(result.company, 'Director');
});

test('isPlausiblyRelatedCompany accepts genuine Ford-family entities returned for a "Ford" search', () => {
  ['Ford Motor Company', 'Ford Credit', 'Ford Energy', 'Ford'].forEach((name) => {
    assert.equal(isPlausiblyRelatedCompany(name, 'Ford'), true, `"${name}" should be accepted`);
  });
});

test('isPlausiblyRelatedCompany rejects unrelated businesses that merely contain "Ford" (the reported dealership-noise bug)', () => {
  ['Rich Ford', 'Chalmers Ford', 'Rodman Ford', 'University Ford', 'Village Ford', 'Midway Ford', 'CC Ford Healthcare'].forEach((name) => {
    assert.equal(isPlausiblyRelatedCompany(name, 'Ford'), false, `"${name}" should be rejected`);
  });
});

test('isPlausiblyRelatedCompany does not over-filter when no organization name was returned', () => {
  assert.equal(isPlausiblyRelatedCompany('', 'Ford'), true);
  assert.equal(isPlausiblyRelatedCompany('N/A', 'Ford'), true);
});
