import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migrations = new URL("../workers/provider-registry/migrations/", import.meta.url);

test("provider rights migration installs provider and external-source INSERT/UPDATE guards", async () => {
  const sql = await readFile(new URL("0007_provider_registry_rights_guards.sql", migrations), "utf8");
  for (const trigger of [
    "trg_provider_registry_enable_guard_insert",
    "trg_provider_registry_enable_guard_update",
    "trg_external_source_playback_guard_insert",
    "trg_external_source_playback_guard_update"
  ]) assert.ok(sql.includes(trigger), `missing trigger: ${trigger}`);
  assert.equal((sql.match(/CREATE TRIGGER IF NOT EXISTS/g) || []).length, 4);
  assert.match(sql, /RAISE\(ABORT/);
  assert.match(sql, /julianday\(NEW\.license_expires_at\) <= julianday\('now'\)/);
  assert.match(sql, /NEW\.playback_enabled = 1/);
  assert.match(sql, /INSERT OR IGNORE INTO schema_migrations/);
});

test("provider enable guards require HTTPS evidence on insert and update", async (t) => {
  const sqlite = await import("node:sqlite").catch(error => {
    if (error.code !== "ERR_UNKNOWN_BUILTIN_MODULE") throw error;
    return null;
  });
  if (!sqlite) return t.skip("Requires Node.js with built-in SQLite (used by Preview CI).");
  const db = new sqlite.DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(await readFile(new URL("0001_init.sql", migrations), "utf8"));
  // Minimal fixtures for the other tables referenced by migration 0007.
  db.exec(`
    CREATE TABLE external_source_registry (playback_enabled INTEGER, status TEXT, rights_status TEXT);
    CREATE TABLE schema_migrations (name TEXT PRIMARY KEY);
  `);
  db.exec(await readFile(new URL("0007_provider_registry_rights_guards.sql", migrations), "utf8"));

  const insert = db.prepare(`
    INSERT INTO provider_registry (
      id, name, status, api_base_url, api_host, media_hosts_json, rights_holder,
      license_reference, rights_evidence_url, license_expires_at, created_at, updated_at, last_event_id
    ) VALUES (?, 'Fixture', ?, 'https://api.example.test', 'api.example.test', '[]', 'Rights holder',
      'LICENSE-1', ?, '2099-01-01T00:00:00Z', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'fixture-event')
  `);
  const enable = db.prepare("UPDATE provider_registry SET status = 'ENABLED', rights_evidence_url = ? WHERE id = 'pending'");
  const guardError = /provider cannot be enabled/;

  insert.run("pending", "PENDING", "");
  for (const evidence of [null, "", "http://rights.example.test/license", "https://"]) {
    assert.throws(() => insert.run("direct", "ENABLED", evidence), guardError);
    assert.throws(() => enable.run(evidence), guardError);
  }

  insert.run("direct", "ENABLED", "https://rights.example.test/license");
  assert.equal(enable.run("HTTPS://rights.example.test/license").changes, 1);
  assert.throws(() => db.prepare("UPDATE provider_registry SET rights_evidence_url = 'http://rights.example.test/license' WHERE id = 'pending'").run(), guardError);
});
