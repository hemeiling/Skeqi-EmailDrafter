// Shared department/seniority classification for contacts, used both when
// filtering Apollo search results (leads.js) and when persisting any contact
// regardless of source -- Apollo, CSV import, manual entry, business card
// scan (db.js). One taxonomy table instead of several parallel keyword
// arrays, so adding a new department later is a one-line addition here
// rather than a hunt across multiple lists.
//
// Title text is checked first and is authoritative: Apollo's own `department`
// field is a coarse, Apollo-assigned category that frequently doesn't
// textually match even for a contact whose title clearly signals the
// department (e.g. "Strategic Procurement Manager" tagged by Apollo under a
// generic "operations" department). Falling back to the raw department field
// only when the title doesn't match keeps classification useful even for
// titles that are themselves generic (e.g. "Manager").

const DEPARTMENT_TAXONOMY = [
  {
    key: 'procurement', label: 'Procurement 采购',
    titleTerms: ['procurement', 'purchasing', 'buyer', 'vendor management'],
    deptTerms: ['procurement', 'purchasing'],
  },
  {
    key: 'strategic_sourcing', label: 'Strategic Sourcing 战略寻源',
    titleTerms: ['strategic sourcing', 'sourcing manager', 'sourcing director', 'category manager', 'capital equipment'],
    deptTerms: ['sourcing'],
  },
  {
    key: 'supply_chain', label: 'Supply Chain 供应链',
    titleTerms: ['supply chain', 'logistics', 'materials management'],
    deptTerms: ['supply chain', 'logistics'],
  },
  {
    key: 'operations', label: 'Operations 运营',
    titleTerms: ['operations manager', 'operations director', 'vp operations', 'coo', 'chief operating officer'],
    deptTerms: ['operations'],
  },
  {
    key: 'manufacturing', label: 'Manufacturing 制造',
    titleTerms: ['manufacturing', 'production manager', 'production director', 'assembly'],
    deptTerms: ['manufacturing', 'production', 'assembly'],
  },
  {
    key: 'engineering', label: 'Engineering 工程',
    titleTerms: ['engineer', 'engineering manager', 'engineering director', 'process development'],
    deptTerms: ['engineering', 'r&d', 'research', 'development'],
  },
  {
    key: 'quality', label: 'Quality 质量',
    titleTerms: ['quality manager', 'quality engineer', 'quality director', 'quality assurance', 'quality control', 'inspection'],
    deptTerms: ['quality'],
  },
  {
    key: 'digital_manufacturing', label: 'Digital Manufacturing / Automation 数字化制造 / 自动化',
    titleTerms: ['automation', 'mes manager', 'digital manufacturing', 'smart factory', 'industry 4', 'ot manager', 'robotics'],
    deptTerms: ['automation', 'digital', 'mes', 'smart factory'],
  },
  {
    key: 'it', label: 'Information Technology 信息技术',
    titleTerms: ['information technology', 'it director', 'it manager', 'cio', 'chief information officer', 'systems administrator'],
    deptTerms: ['it', 'information technology', 'technology'],
  },
  {
    key: 'finance', label: 'Finance 财务',
    titleTerms: ['finance', 'cfo', 'chief financial officer', 'controller', 'accounting'],
    deptTerms: ['finance', 'accounting'],
  },
  {
    key: 'executive', label: 'Executive Leadership 高层管理',
    titleTerms: ['chief', 'president', 'ceo', 'cto', 'coo', 'cfo', 'cio', 'cmo', 'vp', 'vice president'],
    deptTerms: ['executive', 'c-suite', 'c_suite'],
  },
  {
    key: 'maintenance', label: 'Maintenance 设备维护',
    titleTerms: ['maintenance manager', 'maintenance director', 'reliability engineer', 'facilities manager'],
    deptTerms: ['maintenance', 'facilities'],
  },
  {
    key: 'ehs', label: 'EHS 环境健康安全',
    titleTerms: ['ehs', 'environmental health and safety', 'safety manager', 'safety director'],
    deptTerms: ['ehs', 'safety', 'environmental'],
  },
  {
    key: 'plant_management', label: 'Plant Management 工厂管理',
    titleTerms: ['plant manager', 'plant director', 'factory manager', 'factory director', 'site manager'],
    deptTerms: ['plant'],
  },
];

const SENIORITY_TAXONOMY = [
  { key: 'c_level', label: 'C-Level', titleTerms: ['chief', 'ceo', 'cto', 'cio', 'coo', 'cfo', 'cmo', 'president'], seniorityTerms: ['c_suite', 'c-suite', 'founder', 'owner'] },
  { key: 'vp', label: 'Vice President', titleTerms: ['vp', 'vice president'], seniorityTerms: ['vp'] },
  { key: 'director', label: 'Director', titleTerms: ['director', 'head of'], seniorityTerms: ['director'] },
  { key: 'manager', label: 'Manager', titleTerms: ['manager', 'lead engineer', 'principal engineer', 'senior engineer'], seniorityTerms: ['manager', 'senior'] },
  { key: 'individual_contributor', label: 'Individual Contributor', titleTerms: [], seniorityTerms: ['entry', 'individual_contributor'] },
];

const norm = (v) => (v || '').trim().toLowerCase();
// Whole-word/phrase matching, not naive substring -- short abbreviation terms
// like "cto"/"coo"/"it" are otherwise prone to false positives inside common
// words (e.g. "cto" inside "director", "it" inside "digital").
const termRegexCache = new Map();
function termRegex(term) {
  let re = termRegexCache.get(term);
  if (!re) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(`\\b${escaped}\\b`, 'i');
    termRegexCache.set(term, re);
  }
  return re;
}
const matchesAny = (text, terms) => terms.some((t) => termRegex(t).test(text));

// Returns { key, label } of the first matching department, or null if none match.
function classifyDepartment(title, rawDepartment) {
  const t = norm(title);
  for (const dept of DEPARTMENT_TAXONOMY) {
    if (matchesAny(t, dept.titleTerms)) return { key: dept.key, label: dept.label };
  }
  const d = norm(rawDepartment);
  if (d) {
    for (const dept of DEPARTMENT_TAXONOMY) {
      if (matchesAny(d, dept.deptTerms)) return { key: dept.key, label: dept.label };
    }
  }
  return null;
}

// Returns { key, label } seniority bucket, defaulting to individual_contributor.
function classifySeniority(title, rawSeniority) {
  const t = norm(title);
  const s = norm(rawSeniority);
  for (const level of SENIORITY_TAXONOMY) {
    if (matchesAny(t, level.titleTerms) || matchesAny(s, level.seniorityTerms)) {
      return { key: level.key, label: level.label };
    }
  }
  return { key: 'individual_contributor', label: 'Individual Contributor' };
}

// Every title term across every department -- used to build a dynamic
// Apollo `person_titles` query when the caller selects specific departments.
function titleTermsForDepartments(departmentKeys) {
  const keys = new Set(departmentKeys || []);
  const terms = new Set();
  for (const dept of DEPARTMENT_TAXONOMY) {
    if (keys.has(dept.key)) dept.titleTerms.forEach((t) => terms.add(t));
  }
  return [...terms];
}

module.exports = {
  DEPARTMENT_TAXONOMY, SENIORITY_TAXONOMY,
  classifyDepartment, classifySeniority, titleTermsForDepartments,
};
