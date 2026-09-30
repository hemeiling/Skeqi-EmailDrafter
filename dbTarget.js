/* ═══════════════════════════════════════════════════════════════════════════
   Which database a process is allowed to open.

   `.env` has pointed at a remote database (Neon, now the rollback copy of
   production) for as long as this project has existed, so a plain
   `node server.js` on a laptop connected to it and ran initDb() — schema
   statements and backfills included — against real data. Nothing about that
   is visible until something goes wrong.

   The rule:

     • A local database (localhost, 127.0.0.1, ::1, or a Unix socket) is
       always allowed.
     • A remote database is allowed when the process is a deployed service —
       NODE_ENV=production (render.yaml sets it) or RENDER=true (Render sets
       it on every service, so a dashboard edit to NODE_ENV cannot stop
       production from booting).
     • Anywhere else, a remote database is allowed only when ALLOW_REMOTE_DB
       names that exact host. A bare "1"/"true" is refused on purpose: the
       person running an operator script should have to say which database
       they mean, because "the one in .env" is exactly the assumption that
       causes accidents.

   Only the hostname is ever printed — never the URL, which carries the
   password.
   ═══════════════════════════════════════════════════════════════════════════ */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function targetHost(url) {
  if (!url) return { host: '', local: true };
  try {
    const u = new URL(url);
    const host = (u.hostname || '').toLowerCase();
    // postgres:///db?host=/tmp — a Unix socket is local by definition.
    const socket = !host || (u.searchParams.get('host') || '').startsWith('/');
    return { host, local: socket || LOCAL_HOSTS.has(host) };
  } catch {
    return { host: null, local: false };
  }
}

/** Returns { ok, host, reason }. Pure: reads nothing but its arguments. */
function checkDatabaseTarget(url, env = process.env) {
  const { host, local } = targetHost(url);
  if (host === null) return { ok: false, host: null, reason: 'DATABASE_URL is not a parseable URL.' };
  if (local) return { ok: true, host, reason: 'local' };
  if (env.NODE_ENV === 'production' || env.RENDER === 'true') return { ok: true, host, reason: 'deployed' };
  const allowed = String(env.ALLOW_REMOTE_DB || '').trim().toLowerCase();
  if (allowed && allowed === host) return { ok: true, host, reason: 'explicit' };
  return {
    ok: false, host,
    reason: `DATABASE_URL points at the remote host ${host}, and this is not a deployed service. `
      + 'Use a local database for development, or — if you really mean to work on that database — '
      + `rerun with ALLOW_REMOTE_DB=${host}.`,
  };
}

function assertSafeDatabaseTarget(url, env = process.env) {
  const r = checkDatabaseTarget(url, env);
  if (!r.ok) throw new Error(`Refusing to connect: ${r.reason}`);
  return r;
}

module.exports = { checkDatabaseTarget, assertSafeDatabaseTarget, targetHost };
