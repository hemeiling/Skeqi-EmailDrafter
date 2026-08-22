// Runs against the real DATABASE_URL configured in .env (no separate test DB
// is set up for this project). Every fixture row created here is tagged with
// a random ZZTEST_ prefix and removed in the top-level `after` hook, so
// running this suite repeatedly never leaves stray data behind.
require('dotenv').config(); // db.js reads process.env.DATABASE_URL directly
const test = require('node:test');
const assert = require('node:assert/strict');
const dbGuard = require('./dbGuard');

/* Every test below needs a database. Without TEST_DATABASE_URL there is
   nowhere safe to run them, and the one place they must never run is the
   database .env points at — so the whole suite skips rather than falling back.
   `return` at module scope is legal in CommonJS and is the least invasive way
   to skip a file wholesale. */
if (!dbGuard.available) {
  require('node:test')('database suite skipped — TEST_DATABASE_URL not set', { skip: true }, () => {});
  return;
}

const db = require('../db');

const RUN_ID = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const tag = (label) => `ZZTEST_${label}_${RUN_ID}`;

const createdContactIds = [];
const createdAttachmentIds = [];
const createdCommunicationIds = [];

async function makeContact(fields) {
  const id = await db.insertContact(fields);
  createdContactIds.push(id);
  return id;
}

test.before(async () => {
  await db.initDb();
});

test.after(async () => {
  if (createdCommunicationIds.length) {
    await db.pool.query(`DELETE FROM communication_attachments WHERE communication_id = ANY($1::int[])`, [createdCommunicationIds]);
    await db.pool.query(`DELETE FROM communications WHERE id = ANY($1::int[])`, [createdCommunicationIds]);
  }
  if (createdAttachmentIds.length) {
    await db.pool.query(`DELETE FROM communication_attachments WHERE attachment_id = ANY($1::int[])`, [createdAttachmentIds]);
    await db.pool.query(`DELETE FROM attachments WHERE id = ANY($1::int[])`, [createdAttachmentIds]);
  }
  if (createdContactIds.length) {
    await db.deleteContacts(createdContactIds);
  }
  await db.pool.end();
});

test('insertManualEmail creates a comm_type=imported_email row scoped by draft_mode, and listImportedEmailsForContact filters per category', async () => {
  const id = await makeContact({ full_name: tag('Manual Email Contact'), email: `${tag('manualemail')}@example.com` });

  const cold = await db.insertManualEmail({ contactId: id, mode: 'cold_outreach', subject: 'Cold subj', body: 'Cold body', toEmail: 'x@example.com' });
  createdCommunicationIds.push(cold.id);
  const proc = await db.insertManualEmail({ contactId: id, mode: 'procurement_outreach', subject: 'Proc subj', body: 'Proc body', toEmail: 'y@example.com' });
  createdCommunicationIds.push(proc.id);

  assert.equal(cold.comm_type, 'imported_email');
  assert.equal(cold.source, 'manual_entry');
  assert.equal(cold.draft_mode, 'cold_outreach');

  const coldList = await db.listImportedEmailsForContact(id, 'cold_outreach');
  const procList = await db.listImportedEmailsForContact(id, 'procurement_outreach');
  assert.equal(coldList.length, 1);
  assert.equal(coldList[0].id, cold.id);
  assert.equal(procList.length, 1);
  assert.equal(procList[0].id, proc.id);
});

test('attachment upload -> getAttachment round-trip preserves bytes/mime/filename exactly', async () => {
  const id = await makeContact({ full_name: tag('Attach Contact'), email: `${tag('attach')}@example.com` });
  const email = await db.insertManualEmail({ contactId: id, mode: 'cold_outreach', subject: 'Has attachment', body: 'body', toEmail: 'z@example.com' });
  createdCommunicationIds.push(email.id);

  const buffer = Buffer.from('%PDF-1.4 fake pdf bytes for round-trip test', 'utf8');
  const att = await db.uploadOneOffAttachment({ buffer, mimetype: 'application/pdf', originalname: 'brochure.pdf' });
  createdAttachmentIds.push(att.id);
  await db.linkAttachmentToCommunication(email.id, att.id);

  const fetched = await db.getAttachment(att.id);
  assert.ok(Buffer.isBuffer(fetched.file_data));
  assert.equal(fetched.file_data.toString('utf8'), buffer.toString('utf8'));
  assert.equal(fetched.mime_type, 'application/pdf');
  assert.equal(fetched.original_filename, 'brochure.pdf');

  const linked = await db.listAttachmentsForCommunication(email.id);
  assert.equal(linked.length, 1);
  assert.equal(linked[0].id, att.id);
  assert.equal(linked[0].original_filename, 'brochure.pdf');
});

test('createLibraryAttachment -> replaceLibraryAttachment bumps version; old version still fetchable; listAttachmentLibrary shows only the current version', async () => {
  const name = tag('Brochure');
  const v1 = await db.createLibraryAttachment({
    name, category: 'brochure',
    buffer: Buffer.from('v1 bytes'), mimetype: 'application/pdf', originalname: 'brochure-v1.pdf',
  });
  createdAttachmentIds.push(v1.id);
  assert.equal(v1.version, 1);

  const v2 = await db.replaceLibraryAttachment(v1.library_key, {
    buffer: Buffer.from('v2 bytes'), mimetype: 'application/pdf', originalname: 'brochure-v2.pdf',
  });
  createdAttachmentIds.push(v2.id);
  assert.equal(v2.version, 2);
  assert.equal(v2.library_key, v1.library_key);

  const versions = await db.listLibraryVersions(v1.library_key);
  assert.equal(versions.length, 2);
  assert.deepEqual(versions.map((v) => v.version).sort(), [1, 2]);

  const oldFetched = await db.getAttachment(v1.id);
  assert.equal(oldFetched.file_data.toString('utf8'), 'v1 bytes');

  const list = await db.listAttachmentLibrary({ search: name });
  assert.equal(list.length, 1);
  assert.equal(list[0].version, 2);
  assert.equal(list[0].id, v2.id);
});

test('duplicateCommunication on an imported_email row produces a new comm_type=draft row and carries over attachment links (Use as Template)', async () => {
  const id = await makeContact({ full_name: tag('Template Contact'), email: `${tag('template')}@example.com` });
  const email = await db.insertManualEmail({ contactId: id, mode: 'cold_outreach', subject: 'Reusable', body: 'reuse me', toEmail: 'a@example.com' });
  createdCommunicationIds.push(email.id);

  const att = await db.uploadOneOffAttachment({ buffer: Buffer.from('deck'), mimetype: 'application/pdf', originalname: 'deck.pdf' });
  createdAttachmentIds.push(att.id);
  await db.linkAttachmentToCommunication(email.id, att.id);

  const dup = await db.duplicateCommunication(email.id);
  createdCommunicationIds.push(dup.id);

  assert.equal(dup.comm_type, 'draft');
  assert.equal(dup.subject, 'Reusable');
  assert.equal(dup.draft_mode, 'cold_outreach');

  const dupAttachments = await db.listAttachmentsForCommunication(dup.id);
  assert.equal(dupAttachments.length, 1);
  assert.equal(dupAttachments[0].id, att.id);
});

test('unlinkAttachment deletes the underlying one-off attachments row when it was the last link, but leaves a library item intact', async () => {
  const id = await makeContact({ full_name: tag('Unlink Contact'), email: `${tag('unlink')}@example.com` });
  const email = await db.insertManualEmail({ contactId: id, mode: 'cold_outreach', subject: 'sub', body: 'body', toEmail: 'b@example.com' });
  createdCommunicationIds.push(email.id);

  const oneOff = await db.uploadOneOffAttachment({ buffer: Buffer.from('temp'), mimetype: 'text/plain', originalname: 'temp.txt' });
  await db.linkAttachmentToCommunication(email.id, oneOff.id);
  await db.unlinkAttachment(email.id, oneOff.id);
  assert.equal(await db.getAttachment(oneOff.id), null);

  const lib = await db.createLibraryAttachment({
    name: tag('Kept Library Item'), category: 'other',
    buffer: Buffer.from('kept'), mimetype: 'text/plain', originalname: 'kept.txt',
  });
  createdAttachmentIds.push(lib.id);
  await db.linkAttachmentToCommunication(email.id, lib.id);
  await db.unlinkAttachment(email.id, lib.id);
  const stillThere = await db.getAttachment(lib.id);
  assert.ok(stillThere, 'library item must survive being unlinked from an email');
});

test('deleteContacts succeeds for a contact with an imported email + attachment (contact_id is nulled, not FK-violated)', async () => {
  const id = await db.insertContact({ full_name: tag('Delete With Attachment'), email: `${tag('delwattach')}@example.com` });
  const email = await db.insertManualEmail({ contactId: id, mode: 'cold_outreach', subject: 'sub', body: 'body', toEmail: 'c@example.com' });
  createdCommunicationIds.push(email.id);
  const att = await db.uploadOneOffAttachment({ buffer: Buffer.from('file'), mimetype: 'text/plain', originalname: 'file.txt' });
  createdAttachmentIds.push(att.id);
  await db.linkAttachmentToCommunication(email.id, att.id);

  await db.deleteContacts([id]);

  const stillThere = await db.getCommunication(email.id);
  assert.ok(stillThere, 'communications row is not deleted, only detached (contact_id ON DELETE SET NULL)');
  assert.equal(stillThere.contact_id, null);
  const attachmentsStillLinked = await db.listAttachmentsForCommunication(email.id);
  assert.equal(attachmentsStillLinked.length, 1, 'attachment link is untouched since the communication itself was not deleted');
});

test('listAttachmentLibrary filters by category and favoritesOnly', async () => {
  const name = tag('Category Filter Item');
  const item = await db.createLibraryAttachment({
    name, category: 'datasheet',
    buffer: Buffer.from('ds'), mimetype: 'application/pdf', originalname: 'ds.pdf',
  });
  createdAttachmentIds.push(item.id);

  const wrongCategory = await db.listAttachmentLibrary({ search: name, category: 'brochure' });
  assert.equal(wrongCategory.length, 0);

  const rightCategory = await db.listAttachmentLibrary({ search: name, category: 'datasheet' });
  assert.equal(rightCategory.length, 1);

  const notFavorite = await db.listAttachmentLibrary({ search: name, favoritesOnly: true });
  assert.equal(notFavorite.length, 0);

  await db.toggleLibraryFavorite(item.id);
  const favorite = await db.listAttachmentLibrary({ search: name, favoritesOnly: true });
  assert.equal(favorite.length, 1);
});

test('deleteLibraryItem soft-deletes every version, removing it from listAttachmentLibrary', async () => {
  const name = tag('Delete Me Library Item');
  const item = await db.createLibraryAttachment({
    name, category: 'other',
    buffer: Buffer.from('bye'), mimetype: 'text/plain', originalname: 'bye.txt',
  });
  createdAttachmentIds.push(item.id);

  await db.deleteLibraryItem(item.library_key);
  const list = await db.listAttachmentLibrary({ search: name });
  assert.equal(list.length, 0);
});
