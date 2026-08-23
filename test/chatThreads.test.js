/* ═══════════════════════════════════════════════════════════════════════════
   Threaded assistant chat: ownership, and the things that go wrong quietly.

   The scoping tests are the point of this file. Today the login gate
   validates one shared credential, so every session is the same identity and
   nothing here can fail for the reason it exists — which is exactly why it is
   worth pinning now. These assert that a second user_id CANNOT reach the
   first one's conversations, so the day real accounts arrive that property is
   already true and already tested, rather than something someone remembers to
   add afterwards.

   Every check is written against a second, non-owning identity, because a
   query that filters correctly for the owner and leaks to everyone else looks
   identical from the owner's seat.
   ═══════════════════════════════════════════════════════════════════════════ */
const test = require('node:test');
const assert = require('node:assert');

const dbGuard = require('./dbGuard');
const db = dbGuard.available ? require('../db') : null;
const chat = require('../chat');

if (!dbGuard.available) {
  test('threaded chat suite skipped — TEST_DATABASE_URL not set', { skip: true }, () => {});
}
const dbTest = dbGuard.available ? test : test.skip;

/* db.js exports its pool but no generic query helper, and adding one just for
   a test would widen the module's surface for no other caller. */
const sql = (text, params) => db.pool.query(text, params || []).then((r) => r.rows);

const OWNER = 'zztest_owner';
const OTHER = 'zztest_other';          // a different identity, never the owner

test.before(async () => { if (db) await db.initDb(); });

/* Cleanup is by user_id, and only ever for these two synthetic identities —
   nothing here can touch a real conversation. */
test.after(async () => {
  if (!db) return;
  for (const u of [OWNER, OTHER]) {
    await sql(`DELETE FROM chat_messages WHERE user_id = $1`, [u]);
    await sql(`DELETE FROM chat_threads WHERE user_id = $1`, [u]);
  }
});

const mkThread = (user, title) => db.createChatThread(user, title);

// ── ownership ──────────────────────────────────────────────────────────────

dbTest('a thread is readable by its owner and invisible to anyone else', async () => {
  const t = await mkThread(OWNER, 'CATL outreach history');
  assert.ok(await db.getChatThread(OWNER, t.id), 'the owner must see it');
  assert.equal(await db.getChatThread(OTHER, t.id), undefined,
    'another identity must get nothing back — not a permission error, nothing');
});

dbTest('guessing a thread id does not reveal that it exists', async () => {
  const t = await mkThread(OWNER, 'Battery Show competitors');
  await db.addChatMessage(OWNER, t.id, { role: 'user', content: 'who are they' });
  // Same shape of answer for a thread that is not yours and one that is not there.
  const notMine = await db.getChatThread(OTHER, t.id);
  const notReal = await db.getChatThread(OTHER, 999999999);
  assert.equal(notMine, notReal, 'the two cases must be indistinguishable');
  assert.deepEqual(await db.listChatMessages(OTHER, t.id, {}), [],
    'and the messages must not come back either');
});

dbTest('a non-owner cannot rename, archive or delete', async () => {
  const t = await mkThread(OWNER, 'Available booths near CATL');
  assert.equal(await db.setChatThreadTitle(OTHER, t.id, 'hijacked', 'user'), undefined);
  assert.equal(await db.setChatThreadArchived(OTHER, t.id, true), undefined);
  assert.equal(await db.deleteChatThread(OTHER, t.id), undefined);

  const after = await db.getChatThread(OWNER, t.id);
  assert.equal(after.title, 'Available booths near CATL', 'the title must be untouched');
  assert.equal(after.archived_at, null, 'and it must not be archived');
});

dbTest('a non-owner cannot append to someone else\'s conversation', async () => {
  const t = await mkThread(OWNER, 'TESVOLT account research');
  await db.addChatMessage(OTHER, t.id, { role: 'user', content: 'injected' });
  const mine = await db.listChatMessages(OWNER, t.id, {});
  assert.equal(mine.length, 0,
    'a message written under another identity must not appear in the owner\'s thread');
});

// ── deletion and archiving ─────────────────────────────────────────────────

dbTest('delete is soft, and hides the thread from every read path', async () => {
  const t = await mkThread(OWNER, 'To be deleted');
  await db.addChatMessage(OWNER, t.id, { role: 'user', content: 'hello' });
  assert.ok(await db.deleteChatThread(OWNER, t.id));

  assert.equal(await db.getChatThread(OWNER, t.id), undefined, 'gone from reads');
  const listed = await db.listChatThreads(OWNER, {});
  assert.equal(listed.some((x) => String(x.id) === String(t.id)), false, 'gone from the list');

  // But still on disk: a conversation deleted by accident is recoverable.
  const raw = await sql(`SELECT deleted_at FROM chat_threads WHERE id = $1`, [t.id]);
  assert.equal(raw.length, 1, 'the row must still exist');
  assert.notEqual(raw[0].deleted_at, null);
});

dbTest('deleting twice is not an error the second time, it is a no-op', async () => {
  const t = await mkThread(OWNER, 'Twice');
  assert.ok(await db.deleteChatThread(OWNER, t.id));
  assert.equal(await db.deleteChatThread(OWNER, t.id), undefined);
});

dbTest('archiving moves a thread between the two lists and back', async () => {
  const t = await mkThread(OWNER, 'Archive me');
  await db.setChatThreadArchived(OWNER, t.id, true);
  const active = await db.listChatThreads(OWNER, {});
  const archived = await db.listChatThreads(OWNER, { archived: true });
  assert.equal(active.some((x) => String(x.id) === String(t.id)), false);
  assert.equal(archived.some((x) => String(x.id) === String(t.id)), true);

  await db.setChatThreadArchived(OWNER, t.id, false);
  const back = await db.listChatThreads(OWNER, {});
  assert.equal(back.some((x) => String(x.id) === String(t.id)), true, 'archiving must be reversible');
});

// ── titles ─────────────────────────────────────────────────────────────────

dbTest('an auto title never overwrites one a person chose', async () => {
  const t = await mkThread(OWNER, 'Auto name');
  await db.setChatThreadTitle(OWNER, t.id, 'What I called it', 'user');
  await db.setChatThreadTitle(OWNER, t.id, 'Model had another idea', 'auto');
  assert.equal((await db.getChatThread(OWNER, t.id)).title, 'What I called it');
});

dbTest('a blank rename is refused rather than blanking the title', async () => {
  const t = await mkThread(OWNER, 'Keep me');
  assert.equal(await db.setChatThreadTitle(OWNER, t.id, '   ', 'user'), undefined);
  assert.equal((await db.getChatThread(OWNER, t.id)).title, 'Keep me');
});

// ── search ─────────────────────────────────────────────────────────────────

dbTest('search finds a thread by what was asked in it, not only by its title', async () => {
  const t = await mkThread(OWNER, 'Untitled-ish');
  await db.addChatMessage(OWNER, t.id, {
    role: 'user', content: 'Which competitors are near the Kautex Textron stand?' });
  const hits = await db.listChatThreads(OWNER, { q: 'Kautex' });
  assert.equal(hits.length, 1, 'the message body must be searchable');
  assert.match(hits[0].snippet || '', /Kautex/, 'and the match should be shown');
});

dbTest('search never reaches across identities', async () => {
  const t = await mkThread(OWNER, 'Secret pricing conversation');
  await db.addChatMessage(OWNER, t.id, { role: 'user', content: 'our margin on cell trays' });
  assert.deepEqual(await db.listChatThreads(OTHER, { q: 'margin' }), []);
  assert.deepEqual(await db.listChatThreads(OTHER, { q: 'Secret' }), []);
});

dbTest('a search string with SQL in it is a search string', async () => {
  const t = await mkThread(OWNER, "Robert'); DROP TABLE chat_threads;--");
  await db.addChatMessage(OWNER, t.id, { role: 'user', content: 'still here?' });
  const hits = await db.listChatThreads(OWNER, { q: "'); DROP TABLE" });
  assert.equal(hits.length, 1, 'it should match the title it is part of');
  // And the table is, of course, still there.
  assert.ok((await db.listChatThreads(OWNER, {})).length > 0);
});

// ── context bounds ─────────────────────────────────────────────────────────

dbTest('only the recent tail is offered to the model, not the whole thread', async () => {
  const t = await mkThread(OWNER, 'Long one');
  for (let i = 1; i <= 40; i++) {
    await db.addChatMessage(OWNER, t.id, { role: i % 2 ? 'user' : 'assistant', content: 'turn ' + i });
  }
  const tail = await db.recentChatMessages(OWNER, t.id, chat.MAX_HISTORY);
  assert.equal(tail.length, chat.MAX_HISTORY, 'the window is bounded');
  assert.equal(tail[tail.length - 1].content, 'turn 40', 'and it is the RECENT tail');
  assert.equal(tail[0].content, 'turn ' + (40 - chat.MAX_HISTORY + 1), 'in order, oldest first');
});

dbTest('the digest carries what was said and cannot invent anything else', async () => {
  const out = chat.digest([
    { role: 'user', content: 'Is CATL attending?' },
    { role: 'assistant', content: 'CATL is not in the latest official exhibitor list.' },
  ]);
  assert.match(out, /Asked: Is CATL attending\?/);
  assert.match(out, /Answered: CATL is not in the latest/);
  assert.ok(out.length < 900);
});

dbTest('the message count keeps up, so the list never has to count', async () => {
  const t = await mkThread(OWNER, 'Counting');
  for (let i = 0; i < 5; i++) {
    await db.addChatMessage(OWNER, t.id, { role: 'user', content: 'x' });
  }
  assert.equal((await db.getChatThread(OWNER, t.id)).message_count, 5);
});

// ── what is stored ─────────────────────────────────────────────────────────

dbTest('entities are kept as references, never as tool payloads', async () => {
  const found = [];
  chat.collectEntities({
    booth: '3626',
    current_occupant: [
      { name: 'Comau LLC', company_id: 41, crm_name: 'Comau LLC', intro: 'x'.repeat(5000) },
      { name: 'INTECELLS', company_id: null },
    ],
  }, found);
  assert.ok(found.some((e) => e.type === 'booth' && e.name === '3626'));
  assert.ok(found.some((e) => e.type === 'company' && e.id === 41));
  const asStored = JSON.stringify(found);
  assert.ok(asStored.length < 500, `kept ${asStored.length} bytes — references only, not the rows`);
  assert.equal(/xxxxx/.test(asStored), false, 'no tool payload may be carried along');
});

dbTest('entity capture is bounded, so a broad search cannot bloat a message', async () => {
  const found = [];
  chat.collectEntities(
    Array.from({ length: 500 }, (_, i) => ({ company_id: i, name: 'Co ' + i })), found);
  assert.ok(found.length <= 24, `bounded at 24, got ${found.length}`);
});

// ── usage association ──────────────────────────────────────────────────────

dbTest('per-thread usage reads the events, and only this user\'s', async () => {
  const t = await mkThread(OWNER, 'Costed');
  await db.recordAiUsage({
    feature: 'chat', outcome: 'success', status: 'success', model: 'qwen3.6-flash',
    provider: 'bailian', input_tokens: 100, output_tokens: 20, cost_usd: 0.0001,
    response_ms: 1200, thread_id: t.id, request_id: 'zztest-thread-' + t.id,
  });
  const mine = await db.chatThreadUsage(OWNER, t.id);
  assert.equal(Number(mine.turns), 1);
  assert.equal(Number(mine.input_tokens), 100);

  const theirs = await db.chatThreadUsage(OTHER, t.id);
  assert.equal(Number(theirs.turns), 0, 'another identity gets no cost detail for it');

  await sql(`DELETE FROM ai_usage_events WHERE request_id = $1`, ['zztest-thread-' + t.id]);
});
