/**
 * 把展位图上的战略分类同步到 CRM 的 companies 表，让 CRM 能按同一套分类筛选。
 *
 * 做两件事：
 *   1. companies.booth_category ← 展位图的 c 值（customer / batmat / competitor …）
 *   2. companies.event_id       ← Battery Show 2026
 *      （人工整理的那批公司当初没有 event_id，但它们同样是本届展商）
 *
 * 只写这两个字段，其它一律不碰。可重复执行。
 *
 * 用法:
 *   node scripts/backfill_booth_categories.js            干跑
 *   node scripts/backfill_booth_categories.js --apply    写库
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../db');

const SHOW = 'The Battery Show North America 2026';
const MAP = path.join(__dirname, '..', 'public', 'booth-map', 'index.html');

// 与 update_show_data.py 的 key() 保持一致：剥掉法律后缀，
// 否则 "EVE ENERGY" 与 "EVE ENERGY Co. Ltd" 会被当成两家公司。
const SUFFIX = /(coltd|co|ltd|llc|inc|gmbh|corp|corporation|limited|ag|sa|bv|nv|srl|spa|plc|kg|as|oy|ab|pte|pty)+$/;
function key(name) {
  let n = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  let prev;
  do { prev = n; n = n.replace(SUFFIX, ''); } while (n !== prev);
  return n;
}

function loadBooths() {
  const html = fs.readFileSync(MAP, 'utf8');
  const i = html.indexOf('const ALL_BOOTHS_DATA=[');
  const j = html.indexOf('];', i);
  if (i < 0 || j < 0) throw new Error('展位图里找不到 ALL_BOOTHS_DATA');
  return JSON.parse(html.slice(i + 'const ALL_BOOTHS_DATA='.length, j + 1));
}

(async () => {
  const apply = process.argv.includes('--apply');
  const booths = loadBooths().filter((b) => b.nm && b.nm !== 'Available');

  // 一家公司可能占多个展位；分类取第一个非 other 的，避免被 other 覆盖掉
  const byKey = new Map();
  for (const b of booths) {
    const k = key(b.nm);
    if (!k) continue;
    const cur = byKey.get(k);
    if (!cur || (cur.c === 'other' && b.c !== 'other')) byKey.set(k, b);
  }
  console.log(`展位图: ${booths.length} 个有展商的展位 → ${byKey.size} 家公司`);

  const companies = (await db.pool.query(
    'SELECT id, name, name_key, booth_category, event_id FROM companies')).rows;
  const ev = await db.getOrCreateEvent(SHOW);
  console.log(`CRM: ${companies.length} 家 | 展会 "${SHOW}" id=${ev.id}\n`);

  const catUpd = [], evUpd = [];
  for (const c of companies) {
    const b = byKey.get(key(c.name));
    if (b && c.booth_category !== b.c) catUpd.push({ id: c.id, name: c.name, from: c.booth_category, to: b.c });
    if (b && c.event_id !== ev.id) evUpd.push({ id: c.id, name: c.name });
  }

  const dist = {};
  for (const u of catUpd) dist[u.to] = (dist[u.to] || 0) + 1;
  console.log(`将设置 booth_category: ${catUpd.length} 家`);
  Object.entries(dist).sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(`   ${k.padEnd(12)} ${v}`));
  console.log(`\n将补 event_id: ${evUpd.length} 家`);
  console.log(`  样例: ${evUpd.slice(0, 3).map((u) => u.name).join(', ') || '(无)'}`);
  console.log(`\n展位图上有、CRM 里没有的公司: ${
    [...byKey.keys()].filter((k) => !companies.some((c) => key(c.name) === k)).length}`);

  if (!apply) { console.log('\n[干跑] 未写库。加 --apply 执行。'); await db.pool.end(); return; }

  for (const u of catUpd) {
    await db.pool.query('UPDATE companies SET booth_category=$1, updated_at=NOW() WHERE id=$2', [u.to, u.id]);
  }
  for (const u of evUpd) {
    await db.pool.query('UPDATE companies SET event_id=$1, updated_at=NOW() WHERE id=$2', [ev.id, u.id]);
  }
  console.log(`\n完成: booth_category ${catUpd.length} 家 | event_id ${evUpd.length} 家`);

  const after = await db.pool.query(`
    SELECT COALESCE(NULLIF(booth_category,''),'(未分类)') cat, COUNT(*) n
    FROM companies GROUP BY 1 ORDER BY n DESC`);
  console.log('\n库中分类分布:');
  after.rows.forEach((r) => console.log(`   ${String(r.n).padStart(5)}  ${r.cat}`));
  await db.pool.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
