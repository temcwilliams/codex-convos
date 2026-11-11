import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
const initial = () => ({
  users: [],
  sessions: [],
  invites: [],
  conversations: [],
  runs: [],
  events: [],
  runner: null,
});
export async function openStore({
  url = process.env.DATABASE_URL,
  file = process.env.SQLITE_PATH || "data/convos.sqlite",
  production = process.env.NODE_ENV === "production",
} = {}) {
  let query, close;
  if (url) {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: url, max: 3 });
    query = async (s, p = []) => (await pool.query(s, p)).rows;
    close = () => pool.end();
  } else {
    if (production)
      throw new Error(
        "DATABASE_URL is required in production; ephemeral history is disabled",
      );
    await mkdir(dirname(file), { recursive: true });
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    query = async (s, p = []) => {
      const values = [];
      s = s.replace(/\$(\d+)/g, (_, n) => {
        values.push(p[Number(n) - 1]);
        return "?";
      });
      return db.prepare(s).all(...values);
    };
    close = () => db.close();
  }
  await query(
    "CREATE TABLE IF NOT EXISTS workspace_state (id TEXT PRIMARY KEY, version INTEGER NOT NULL, data TEXT NOT NULL)",
  );
  await query(
    "INSERT INTO workspace_state (id,version,data) VALUES ($1,0,$2) ON CONFLICT(id) DO NOTHING",
    ["workspace", JSON.stringify(initial())],
  );
  return {
    async read() {
      return JSON.parse(
        (
          await query("SELECT data FROM workspace_state WHERE id=$1", [
            "workspace",
          ])
        )[0].data,
      );
    },
    async change(fn) {
      for (let attempt = 0; attempt < 15; attempt++) {
        const row = (
          await query("SELECT version,data FROM workspace_state WHERE id=$1", [
            "workspace",
          ])
        )[0];
        const state = JSON.parse(row.data);
        const result = fn(state);
        const changed = await query(
          "UPDATE workspace_state SET data=$1,version=version+1 WHERE id=$2 AND version=$3 RETURNING version",
          [JSON.stringify(state), "workspace", row.version],
        );
        if (changed.length) return result;
        await new Promise((r) => setTimeout(r, attempt * 5));
      }
      throw new Error("Workspace busy; retry the operation");
    },
    close,
  };
}
