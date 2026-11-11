import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { openStore } from "../server/store.mjs";
import { createApp } from "../server/app.mjs";
test(
  "runner uses Git worktrees, forwards owner approval, and completes tasks without passing control credentials to Codex",
  { timeout: 25000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "convos-runner-"));
    const repo = join(dir, "source");
    execFileSync("git", ["init", "-b", "main", repo]);
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "Fixture",
    ]);
    const store = await openStore({ file: join(dir, "db.sqlite") });
    const runnerKey = "runner-test-secret-not-for-agent-environment";
    const app = createApp({
      store,
      setupKey: "test-setup-secret-with-at-least-32-chars",
      runnerKey,
      secureCookies: false,
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${server.address().port}`;
    let child;
    t.after(async () => {
      if (child) {
        child.kill("SIGTERM");
        await new Promise((r) => child.once("exit", r));
      }
      await new Promise((r) => server.close(r));
      await store.close();
      await rm(dir, { recursive: true, force: true });
    });
    const c = await fetch(base + "/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Codex-Client": "web" },
      body: JSON.stringify({
        setupKey: "test-setup-secret-with-at-least-32-chars",
        name: "Owner",
        email: "test@example.com",
        password: "password-for-test-only",
      }),
    });
    const cookie = c.headers.get("set-cookie").split(";")[0];
    await fetch(base + "/api/conversations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Codex-Client": "web",
        Cookie: cookie,
      },
      body: JSON.stringify({ text: "Protocol fixture task" }),
    });
    child = spawn(process.execPath, ["runner/index.mjs"], {
      env: {
        ...process.env,
        NODE_ENV: "test",
        CONVOS_URL: base,
        RUNNER_KEY: runnerKey,
        RUNNER_HOME: join(dir, "runner"),
        PROJECT_REPO: repo,
        CODEX_BINARY: resolve("test/fixtures/codex-fixture.mjs"),
      },
      stdio: "pipe",
    });
    let approved = false,
      completed = false;
    for (let i = 0; i < 150; i++) {
      const s = await store.read();
      const r = s.runs[0];
      if (r.status === "waiting" && !approved) {
        const a = r.approvals[0];
        const response = await fetch(
          base + `/api/runs/${r.id}/approvals/${a.id}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Codex-Client": "web",
              Cookie: cookie,
            },
            body: JSON.stringify({ decision: "accept" }),
          },
        );
        assert.equal(response.status, 200);
        approved = true;
      }
      if (r.status === "completed") {
        completed = true;
        assert.match(
          s.events.find((e) => e.type === "message.assistant").data.text,
          /without web credentials/,
        );
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(approved, "owner approval was requested and forwarded");
    assert.ok(completed, "the task reached a durable completed state");
  },
);
