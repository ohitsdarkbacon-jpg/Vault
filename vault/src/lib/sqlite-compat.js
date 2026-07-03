/**
 * SQLite driver shim.
 *
 * Primary driver is better-sqlite3 (fast, battle-tested — this is what runs
 * on Railway). If its native binding isn't available (e.g. an environment
 * where the prebuilt binary can't be downloaded or compiled), we fall back
 * to Node's built-in `node:sqlite` (Node >= 22) wrapped in a
 * better-sqlite3-compatible interface, so the rest of the app doesn't care
 * which driver is underneath.
 */

function openDatabase(path) {
  try {
    const Database = require('better-sqlite3');
    return new Database(path);
  } catch (err) {
    console.warn('[db] better-sqlite3 unavailable (' + err.code + '), falling back to node:sqlite');
  }

  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(path);

  const wrapStmt = (stmt) => ({
    get: (...args) => stmt.get(...args),
    all: (...args) => stmt.all(...args),
    run: (...args) => {
      const r = stmt.run(...args);
      return { lastInsertRowid: Number(r.lastInsertRowid), changes: Number(r.changes) };
    },
  });

  return {
    prepare: (sql) => wrapStmt(raw.prepare(sql)),
    exec: (sql) => raw.exec(sql),
    pragma: (p) => raw.exec(`PRAGMA ${p}`),
    transaction(fn) {
      return (...args) => {
        raw.exec('BEGIN');
        try {
          const out = fn(...args);
          raw.exec('COMMIT');
          return out;
        } catch (e) {
          try { raw.exec('ROLLBACK'); } catch (_) {}
          throw e;
        }
      };
    },
  };
}

module.exports = { openDatabase };
