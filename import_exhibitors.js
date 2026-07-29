/**
 * 将 The Battery Show North America 2026 的展商名录导入 CRM。
 *
 * 数据来源（两个官方接口，见 probe_booth_fields.py 的探测过程）：
 *   1. /8_0/ajax/remote-proxy.cfm?action=search&searchtype=exhibitoralpha  → 名称 + 展位号
 *   2. /8_0/exhview/02/exh-remote-proxy.cfm?action=getExhibitorInfo        → 网站/邮箱/电话/地址
 *
 * 已人工整理的公司（category / priority / chinese_name / background 等）不会被覆盖：
 * upsertCompany 的 pick(new, old) 在新值为空时保留旧值，所以对已存在且已有内容的
 * 字段一律传空字符串。
 *
 * 用法:
 *   node import_exhibitors.js <mys_full.json>            干跑，只报告将要发生什么
 *   node import_exhibitors.js <mys_full.json> --apply    实际写库
 */

require('dotenv').config();
const fs = require('fs');
const db = require('./db');
const { normalizeNameKey, isInvalidCompanyName } = require('./companyKey');

const EVENT = 'The Battery Show North America 2026';

function countryToLocation(r) {
  return [r.city, r.state, r.country].filter(Boolean).join(', ');
}

(async () => {
  const file = process.argv[2];
  const apply = process.argv.includes('--apply');
  if (!file || !fs.existsSync(file)) {
    console.error('用法: node import_exhibitors.js <mys_full.json> [--apply]');
    process.exit(1);
  }
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));

  // 现有公司快照，用来判断哪些字段已经有人工内容
  const existing = await db.pool.query(
    'SELECT id, name, name_key, booth, website, background, category, chinese_name FROM companies'
  );
  // The table can contain duplicate rows sharing a name_key (see
  // /api/companies/duplicates). A plain Map would keep whichever came last —
  // if that one is the empty stub, the "only fill blanks" check passes, but
  // upsertCompany then resolves by name to the *other* row and clobbers its
  // curated content. So collapse duplicates to the richest row per key.
  const byKey = new Map();
  const weight = (r) => ['background', 'chinese_name', 'category', 'website', 'booth']
    .reduce((n, f) => n + String(r[f] ?? '').length, 0);
  for (const r of existing.rows) {
    const prev = byKey.get(r.name_key);
    if (!prev || weight(r) > weight(prev)) byKey.set(r.name_key, r);
  }
  const dupKeys = existing.rows.length - new Set(existing.rows.map((r) => r.name_key)).size;
  if (dupKeys) console.log(`⚠ 库中有 ${dupKeys} 行与他行共用 name_key，已按内容最全的那行判定\n`);
  console.log(`来源 ${rows.length} 家 | 库中现有 ${existing.rows.length} 家\n`);

  const plan = { create: [], fillOnly: [], skipInvalid: [], noop: [] };

  for (const r of rows) {
    const name = (r.name || '').trim();
    if (!name || isInvalidCompanyName(name)) { plan.skipInvalid.push(name); continue; }
    const key = normalizeNameKey(name);
    const cur = byKey.get(key);
    const booth = (r.booths && r.booths[0]) || '';

    if (!cur) {
      plan.create.push({
        name,
        booth,
        website: r.url || '',
        background: (r.desc || '').slice(0, 2000),
        mfg_location: countryToLocation(r),
        notes: [r.email && `邮箱: ${r.email}`, r.phone && `电话: ${r.phone}`,
                r.linkedin && `LinkedIn: ${r.linkedin}`].filter(Boolean).join(' · '),
        event_name: EVENT,
      });
      continue;
    }

    // 已存在：只补空字段，绝不覆盖已有内容
    const fill = { name };
    if (!cur.booth && booth) fill.booth = booth;
    if (!cur.website && r.url) fill.website = r.url;
    if (!cur.background && r.desc) fill.background = r.desc.slice(0, 2000);
    if (Object.keys(fill).length > 1) plan.fillOnly.push({ id: cur.id, ...fill });
    else plan.noop.push(name);
  }

  console.log('计划:');
  console.log(`  新建           ${plan.create.length}`);
  console.log(`  补空字段       ${plan.fillOnly.length}`);
  console.log(`  无需变更       ${plan.noop.length}`);
  console.log(`  跳过(无效名)   ${plan.skipInvalid.length}`);

  const f = plan.fillOnly;
  console.log(`\n补空字段明细: 展位号 ${f.filter((x) => x.booth).length}`
            + ` | 网站 ${f.filter((x) => x.website).length}`
            + ` | 简介 ${f.filter((x) => x.background).length}`);
  console.log('  样例:', f.slice(0, 3).map((x) => `${x.name}(${Object.keys(x).filter((k) => k !== 'name' && k !== 'id').join('+')})`).join(', ') || '(无)');
  console.log('\n新建样例:');
  plan.create.slice(0, 3).forEach((c) =>
    console.log(`  ${c.name} | 展位 ${c.booth} | ${c.website || '(无网站)'} | ${c.mfg_location || '(无地区)'}`));

  if (!apply) {
    console.log('\n[干跑] 未写库。加 --apply 执行。');
    await db.pool.end();
    return;
  }

  console.log('\n开始写入…');
  let created = 0, updated = 0, failed = 0;
  for (const c of plan.create) {
    try { await db.upsertCompany(c); created++; } catch (e) { failed++; if (failed < 4) console.error('  ✗', c.name, e.message); }
    if (created % 100 === 0 && created) console.log(`  新建 ${created}/${plan.create.length}`);
  }
  for (const u of plan.fillOnly) {
    try { await db.upsertCompany(u); updated++; } catch (e) { failed++; if (failed < 4) console.error('  ✗', u.name, e.message); }
  }
  console.log(`\n完成: 新建 ${created} | 补字段 ${updated} | 失败 ${failed}`);

  const after = await db.pool.query(
    'SELECT COUNT(*) n, COUNT(booth) NULLIF_booth, COUNT(website) w, COUNT(background) b FROM companies'
  );
  console.log('库中现有:', after.rows[0]);
  await db.pool.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
