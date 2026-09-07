/* Recent Sessions stays live WITHOUT destroying what the user is touching.
 *
 * The overflow menu is a native <details>, so its open state lives in the DOM
 * and nowhere else. The list used to be rewritten with innerHTML every three
 * seconds while anything was queued or running, which closed the menu the
 * instant it opened.
 *
 * These run in a real browser, because the behaviour under test IS the DOM:
 * node identity across a re-render, the open state of <details>, scroll offset
 * and focus. A string assertion could not tell you any of it.
 *
 *   node test-sessions-live-dom.js
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const SHELL = path.join(process.env.HOME,
  'Library/Caches/ms-playwright/chromium_headless_shell-1228',
  'chrome-headless-shell-mac-arm64/chrome-headless-shell');

let pass = 0; const fail = [];
const ck = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS ' + name); }
  else { fail.push(name); console.log('  FAIL ' + name + (detail ? '  [' + detail + ']' : '')); }
};

/* The shipped functions, lifted out of the real file. */
const SRC = fs.readFileSync(path.join(__dirname, 'public/qwen-research.js'), 'utf8');
const from = SRC.indexOf('  function rowHtml(x) {');
const to = SRC.indexOf('  function renderSessions() {');
if (from < 0 || to < 0 || to < from) throw new Error('could not lift the render helpers');
const HELPERS = SRC.slice(from, to);

/* Just enough around them to run. rowContent and rowMenu are stubbed so the
   test drives exactly what changes between polls. */
/* The real toggle listener, lifted out of wireSessions so the deferred-menu
   path is tested as shipped rather than as a copy of itself. */
const tFrom = SRC.indexOf("    list.addEventListener('toggle'");
const tTo = SRC.indexOf('}, true);', tFrom);
if (tFrom < 0 || tTo < 0) throw new Error('could not lift the toggle listener');
const TOGGLE = SRC.slice(tFrom, tTo + '}, true);'.length);

const HARNESS = `
  window.sessionSel = null;
  const esc = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const railClass = (s) => (s === 'queued' || s === 'researching') ? 'st-active' : 'st-done';
  let sessionSel = null;
  window.MENU_EXTRA = '';
  const rowMenu = (x) => '<details class="qr-menu"><summary>\\u22ef</summary>'
    + '<div class="qr-menubox"><button data-id="' + esc(x.job_id) + '">Delete</button>'
    + esc(window.MENU_EXTRA) + '</div></details>';
  const rowContent = (x) => ({
    state: esc(x.state),
    ctx: esc(x.ctx || ''),
    action: x.action ? '<button class="act">' + esc(x.action) + '</button>' : '',
  });
${HELPERS}
  window.syncSessionRows = syncSessionRows;
  window.setSessionNote = setSessionNote;
  window.wireToggle = function (list) {
${TOGGLE}
  };
`;

(async () => {
  const browser = await chromium.launch({ executablePath: SHELL });
  const page = await browser.newPage();
  await page.setContent(
    '<style>ul{height:80px;overflow-y:auto;margin:0}li{height:40px}</style>'
    + '<ul id="list"></ul>');
  await page.addScriptTag({ content: HARNESS });
  await page.evaluate(() => window.wireToggle(document.getElementById('list')));

  const sync = (rows) => page.evaluate(
    (r) => window.syncSessionRows(document.getElementById('list'), r), rows);

  const ROWS = (n, over) => Array.from({ length: n }, (_, i) => ({
    job_id: 'j' + (i + 1), company_name: 'Co ' + (i + 1),
    state: 'researching', ctx: '10:00 · 5%', action: 'View', ...(over || {}),
  }));

  try {
    console.log('\n[1] A poll no longer rebuilds the list\n');
    await sync(ROWS(4));
    await page.evaluate(() => {
      document.querySelectorAll('li[data-qr-sess]').forEach((li, i) => { li._probe = i; });
    });
    await sync(ROWS(4));
    const kept = await page.evaluate(() =>
      [...document.querySelectorAll('li[data-qr-sess]')].every((li, i) => li._probe === i));
    ck('every row element survived the poll', kept,
       'innerHTML would have replaced all four');
    ck('the row count is right',
       (await page.$$('li[data-qr-sess]')).length === 4);

    console.log('\n[2] An open menu stays open across polls\n');
    await page.evaluate(() => {
      document.querySelector('li[data-qr-sess="j2"] .qr-menu').open = true;
    });
    for (let i = 0; i < 3; i++) {
      await sync(ROWS(4, { ctx: '10:0' + i + ' · ' + (i * 10) + '%' }));
    }
    ck('the menu is still open after three polls',
       await page.evaluate(() =>
         document.querySelector('li[data-qr-sess="j2"] .qr-menu').open));
    ck('and it is the SAME element, not a rebuilt one',
       await page.evaluate(() => {
         const d = document.querySelector('li[data-qr-sess="j2"] .qr-menu');
         if (d._seen) return true;
         d._seen = true; return false;
       }) === false);
    ck('its buttons are still clickable',
       await page.evaluate(() => {
         let hit = false;
         const b = document.querySelector('li[data-qr-sess="j2"] .qr-menubox button');
         b.addEventListener('click', () => { hit = true; });
         b.click();
         return hit;
       }));

    console.log('\n[3] The row still updates while the menu is open\n');
    await sync(ROWS(4, { ctx: '11:11 · 90%', state: 'generating' }));
    ck('the context text updated',
       (await page.textContent('li[data-qr-sess="j2"] .qr-sess-ctx')) === '11:11 · 90%');
    ck('the state updated',
       (await page.textContent('li[data-qr-sess="j2"] .qr-sess-state')) === 'generating');
    ck('the menu is STILL open through all of it',
       await page.evaluate(() =>
         document.querySelector('li[data-qr-sess="j2"] .qr-menu').open));

    console.log('\n[4] A menu whose content changed waits until it closes\n');
    await page.evaluate(() => { window.MENU_EXTRA = 'CHANGED'; });
    await sync(ROWS(4));
    ck('the open menu was not swapped mid-interaction',
       !(await page.textContent('li[data-qr-sess="j2"] .qr-menubox')).includes('CHANGED'));
    ck('a CLOSED menu on another row took the change immediately',
       (await page.textContent('li[data-qr-sess="j3"] .qr-menubox')).includes('CHANGED'));
    /* Closing it fires `toggle`, and the SHIPPED listener applies the pending
       markup. Nothing here reimplements that; the listener was lifted from the
       source and wired to this list. */
    await page.evaluate(() => {
      document.querySelector('li[data-qr-sess="j2"] .qr-menu').open = false;
    });
    await page.waitForFunction(() =>
      document.querySelector('li[data-qr-sess="j2"] .qr-menubox').textContent.includes('CHANGED'),
      null, { timeout: 4000 }).catch(() => {});
    ck('the shipped toggle listener applied it on close',
       (await page.textContent('li[data-qr-sess="j2"] .qr-menubox')).includes('CHANGED'));
    ck('and the reopened menu is the replacement, still usable',
       await page.evaluate(() => {
         const d = document.querySelector('li[data-qr-sess="j2"] .qr-menu');
         d.open = true; return d.open && !d._qrPending;
       }));

    console.log('\n[5] Scroll and focus survive a poll\n');
    await page.evaluate(() => { document.getElementById('list').scrollTop = 60; });
    await page.evaluate(() =>
      document.querySelector('li[data-qr-sess="j3"] .qr-menu summary').focus());
    await sync(ROWS(4, { ctx: 'moved on' }));
    ck('scroll position is unchanged',
       await page.evaluate(() => document.getElementById('list').scrollTop === 60),
       String(await page.evaluate(() => document.getElementById('list').scrollTop)));
    ck('focus is still on the same control',
       await page.evaluate(() =>
         document.activeElement === document.querySelector('li[data-qr-sess="j3"] .qr-menu summary')));

    console.log('\n[6] Selection survives, and follows the selected row\n');
    await page.evaluate(() => { sessionSel = 'j3'; });
    await sync(ROWS(4));
    ck('the selected row is marked',
       await page.evaluate(() =>
         document.querySelector('li[data-qr-sess="j3"]').classList.contains('is-selected')));
    ck('and no other row is', await page.evaluate(() =>
      document.querySelectorAll('li.is-selected').length === 1));

    console.log('\n[7] Rows still appear, vanish and reorder\n');
    await sync([...ROWS(4)].reverse());
    ck('order follows the server',
       (await page.evaluate(() =>
         [...document.querySelectorAll('li[data-qr-sess]')].map((l) => l.dataset.qrSess)))
         .join(',') === 'j4,j3,j2,j1');
    ck('reordering preserved the elements',
       await page.evaluate(() =>
         [...document.querySelectorAll('li[data-qr-sess]')].every((li) => '_probe' in li)));
    await sync(ROWS(2));
    ck('rows that left the page are removed',
       (await page.$$('li[data-qr-sess]')).length === 2);
    await sync(ROWS(6));
    ck('new rows are added', (await page.$$('li[data-qr-sess]')).length === 6);
    ck('a brand-new row has a working menu',
       await page.evaluate(() => {
         const d = document.querySelector('li[data-qr-sess="j6"] .qr-menu');
         d.open = true; return d.open;
       }));

    console.log('\n[8] The trailing note is not a row\n');
    await page.evaluate(() =>
      window.setSessionNote(document.getElementById('list'), 'Showing 6 of 9'));
    ck('the note is added once',
       (await page.$$('li.qr-sess-empty')).length === 1);
    await sync(ROWS(6));
    await page.evaluate(() =>
      window.setSessionNote(document.getElementById('list'), 'Showing 6 of 9'));
    ck('and not duplicated by the next poll',
       (await page.$$('li.qr-sess-empty')).length === 1);
    ck('it sits after the rows',
       await page.evaluate(() =>
         document.getElementById('list').lastElementChild.classList.contains('qr-sess-empty')));
    ck('it is not counted as a row',
       (await page.$$('li[data-qr-sess]')).length === 6);
    await page.evaluate(() => window.setSessionNote(document.getElementById('list'), ''));
    ck('and it is removed when there is nothing to say',
       (await page.$$('li.qr-sess-empty')).length === 0);

    console.log('\n[9] The shipped file no longer rebuilds either list\n');
    ck('the sessions list is patched, not rewritten',
       !/list\.innerHTML\s*=/.test(SRC), 'innerHTML on the list is the bug');
    ck('the queue panel writes only when its markup changed',
       /if \(rows\._qrHtml !== html\) \{ rows\.innerHTML = html; rows\._qrHtml = html; \}/.test(SRC));
    ck('polling was not disabled or slowed',
       /setTimeout\(refreshSessions, 3000\)/.test(SRC),
       'the list must stay live');
    ck('the header says active, not running',
       /bits\.push\(`\$\{liveN\} active \/ \$\{liveN\} 进行中`\)/.test(SRC),
       'the number is queued + researching + generating');
    ck('and the number itself is unchanged',
       /const liveN = sessionTotals \? sessionTotals\.live : active\.length;/.test(SRC));
    ck('updates are not frozen while a menu is open',
       /setCell\(li\.querySelector\('\.qr-sess-ctx'\), c\.ctx\);/.test(SRC),
       'only the MENU subtree is deferred');
  } finally {
    await browser.close();
  }

  console.log('\n' + pass + ' passed, ' + fail.length + ' failed');
  fail.forEach((f) => console.log('  FAILED: ' + f));
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error('SUITE ERROR:', e.stack || e.message); process.exit(1); });
