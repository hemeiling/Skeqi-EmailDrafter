/* ═══════════════════════════════════════════════════════════════════════════
   The database a test is allowed to touch.

   Every DB-backed suite in this repo used to run against the real
   DATABASE_URL from .env — the files said so at the top, as though it were a
   design choice rather than a hazard. Between them they issue roughly 190
   inserts, updates and deletes, and `npm test` is the one command every
   contributor runs without thinking. It also calls initDb(), so a schema
   change in an unrelated commit reaches production the first time anyone runs
   the suite. That is how three tables arrived in production unannounced.

   The rule now: tests read TEST_DATABASE_URL and nothing else.

   No fallback to DATABASE_URL, deliberately. A fallback is what turns "I
   forgot to set the test variable" into "the suite quietly wrote to
   production" — which is the exact failure this exists to prevent, and it
   fails in the direction where nobody notices.

   Require this BEFORE ../db, because db.js reads process.env.DATABASE_URL at
   module load. The swap has to happen first or the pool is already pointed at
   the wrong database.

       const dbGuard = require('./dbGuard');
       const db = dbGuard.available ? require('../db') : null;
   ═══════════════════════════════════════════════════════════════════════════ */

/** Host + database, ignoring credentials, port and query string. */
function identity(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Whether two connection strings name the same database.
 *
 * Compared on host and database name rather than the whole string, because
 * the pooled and direct Neon endpoints, and the same database with a
 * different sslmode, are the same data with different spellings.
 */
function sameDatabase(a, b) {
  const x = identity(a);
  const y = identity(b);
  return Boolean(x && y && x === y);
}

const PROD_URL = process.env.DATABASE_URL || '';
const TEST_URL = process.env.TEST_DATABASE_URL || '';

let available = false;
let reason = '';

if (!TEST_URL) {
  reason = 'TEST_DATABASE_URL is not set — database-backed tests are skipped. '
    + 'Set it to a scratch database; it will never fall back to DATABASE_URL.';
  /* Removed from the environment, not merely unused. Requiring ../db is
     harmless afterwards, and — more to the point — nothing later in the
     process can reach production by reading the variable, however it was
     loaded. .env has already been read by the time this runs. */
  delete process.env.DATABASE_URL;
} else if (PROD_URL && sameDatabase(TEST_URL, PROD_URL)) {
  /* Loudly, and as a thrown error rather than a skip: this is not a missing
     configuration, it is a configuration that would destroy production data.
     Skipping would let the suite report green while pointed at the wrong
     database. */
  throw new Error(
    'TEST_DATABASE_URL and DATABASE_URL name the same database '
    + `(${identity(TEST_URL)}). Refusing to run tests against it.`,
  );
} else {
  available = true;
  /* db.js reads DATABASE_URL directly at load. Redirecting the variable is
     what makes every existing suite safe without rewriting how any of them
     connect — and it means a suite added tomorrow is safe by default too,
     provided it requires this first. */
  process.env.DATABASE_URL = TEST_URL;
}

if (!available && reason) {
  // Printed once per suite. Skipped database tests must never be silent —
  // a green run that tested nothing is worse than a red one.
  console.log(`  [dbGuard] ${reason}`);
}

/* The invariant this module exists to establish, stated as code so a test can
   assert it: once required, DATABASE_URL is either the test database or gone. */
function pointsAtProduction() {
  const current = process.env.DATABASE_URL || '';
  return Boolean(current && PROD_URL && sameDatabase(current, PROD_URL));
}

module.exports = { available, reason, sameDatabase, identity, pointsAtProduction, TEST_URL, PROD_URL };
