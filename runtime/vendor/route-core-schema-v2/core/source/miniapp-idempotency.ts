import type Database from "better-sqlite3";

// Commit a receipt in the same transaction as its row. A lost HTTP response
// can then be retried without creating another workout, set, or cardio block.
export function insertMiniappOnce(
  db: Database.Database,
  owner: { identitySource: string; externalUserId: string },
  operation: string,
  key: unknown,
  insert: () => Database.RunResult,
): Database.RunResult {
  if (typeof key !== "string" || !key || key.length > 160) return insert();
  db.exec(`CREATE TABLE IF NOT EXISTS miniapp_write_receipts (
    identity_source TEXT NOT NULL, external_user_id TEXT NOT NULL,
    operation TEXT NOT NULL, client_key TEXT NOT NULL, row_id INTEGER NOT NULL,
    PRIMARY KEY(identity_source, external_user_id, operation, client_key)
  )`);
  return db.transaction(() => {
    const args = [owner.identitySource, owner.externalUserId, operation, key];
    const prior = db.prepare(`SELECT row_id FROM miniapp_write_receipts WHERE identity_source=? AND external_user_id=? AND operation=? AND client_key=?`).get(...args) as { row_id: number } | undefined;
    if (prior) return { changes: 0, lastInsertRowid: prior.row_id };
    const result = insert();
    db.prepare(`INSERT INTO miniapp_write_receipts VALUES (?, ?, ?, ?, ?)`).run(...args, Number(result.lastInsertRowid));
    return result;
  })();
}

export function miniappEventTime(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const time = Date.parse(value);
  return Number.isFinite(time) && time >= Date.UTC(2000, 0, 1) && time <= Date.now() + 300000
    ? new Date(time).toISOString() : fallback;
}
