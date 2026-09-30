/* The local-development guard (dbTarget.js). Pure: nothing here connects. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkDatabaseTarget } = require('../dbTarget');

const NEON = 'postgres://u:secret@ep-x-pooler.c-9.us-east-1.aws.neon.tech/neondb?sslmode=require';
const RENDER_DB = 'postgres://u:secret@dpg-abc.oregon-postgres.render.com/skq';

test('local databases are always allowed', () => {
  for (const url of ['postgres://me@localhost:5432/dev', 'postgres://127.0.0.1/dev', 'postgres://[::1]/dev',
    'postgres:///dev?host=/tmp', '']) {
    assert.equal(checkDatabaseTarget(url, {}).ok, true, url);
  }
});

test('a remote database is refused on a developer machine', () => {
  for (const url of [NEON, RENDER_DB]) {
    const r = checkDatabaseTarget(url, { NODE_ENV: 'development' });
    assert.equal(r.ok, false);
    assert.doesNotMatch(r.reason, /secret/, 'the password never appears in the message');
  }
  assert.equal(checkDatabaseTarget(NEON, {}).ok, false, 'unset NODE_ENV is not production');
  assert.equal(checkDatabaseTarget(NEON, { NODE_ENV: 'test' }).ok, false);
});

test('deployed services connect as before', () => {
  assert.equal(checkDatabaseTarget(RENDER_DB, { NODE_ENV: 'production' }).ok, true);
  assert.equal(checkDatabaseTarget(RENDER_DB, { RENDER: 'true' }).ok, true, 'Render marks every service');
});

test('an explicit opt-in must name the host', () => {
  assert.equal(checkDatabaseTarget(NEON, { ALLOW_REMOTE_DB: '1' }).ok, false);
  assert.equal(checkDatabaseTarget(NEON, { ALLOW_REMOTE_DB: 'true' }).ok, false);
  assert.equal(checkDatabaseTarget(NEON, { ALLOW_REMOTE_DB: 'dpg-abc.oregon-postgres.render.com' }).ok, false,
    'naming a different host does not unlock this one');
  const r = checkDatabaseTarget(NEON, { ALLOW_REMOTE_DB: 'ep-x-pooler.c-9.us-east-1.aws.neon.tech' });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'explicit');
});

test('garbage is refused rather than guessed at', () => {
  assert.equal(checkDatabaseTarget('not a url', {}).ok, false);
});
