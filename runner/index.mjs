import { mkdir, chmod, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CodexRpc } from "./rpc.mjs";
const exec = promisify(execFile);
const url = process.env.CONVOS_URL;
const key = process.env.RUNNER_KEY;
if (!url || !key) throw new Error("CONVOS_URL and RUNNER_KEY are required");
if (
  !url.startsWith("https://") &&
  !/^http:\/\/(localhost|127\.0\.0\.1):/.test(url)
)
  throw new Error("Use HTTPS for remote runners");
const root = resolve(
  process.env.RUNNER_HOME || join(homedir(), ".codex-convos-runner"),
);
await mkdir(root, { recursive: true, mode: 0o700 });
await chmod(root, 0o700);
let id;
try {
  id = (await readFile(join(root, "id"), "utf8")).trim();
} catch {
  id = randomUUID();
  await writeFile(join(root, "id"), id, { mode: 0o600 });
}
const codexHome = join(root, "codex");
await mkdir(codexHome, { recursive: true, mode: 0o700 });
const repo = join(root, "repository"),
  worktrees = join(root, "worktrees");
await mkdir(worktrees, { recursive: true });
async function api(path, data) {
  const response = await fetch(new URL("/api/runner/" + path, url), {
    method: "POST",
    headers: {
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok)
    throw new Error("Control server returned " + response.status);
  return response.json();
}
let rpc,
  active = null,
  accountReady = false,
  login = null,
  lastCommand = null,
  stopping = false,
  serial = Promise.resolve();
const replied = new Set();
async function emit(type, data, eventId = randomUUID()) {
  if (!active) return;
  const run = active;
  for (let retry = 0; retry < 4; retry++) {
    try {
      await api(`runs/${run.id}/events`, { runnerId: id, eventId, type, data });
      return;
    } catch (e) {
      if (retry === 3) throw e;
      await new Promise((r) => setTimeout(r, 1000 * (retry + 1)));
    }
  }
}
const enqueue = (fn) => {
  serial = serial.then(fn).catch(() => {
    if (active) active.failed = true;
    console.error("Event delivery failed; task will not be silently retried");
  });
  return serial;
};
async function boot() {
  rpc = new CodexRpc({ home: codexHome });
  rpc.on("closed", () => {
    accountReady = false;
    if (active) {
      active.failed = true;
      active = null;
    }
    rpc = null;
  });
  rpc.on("request", (message) => {
    if (!active) {
      rpc?.reject(message.id);
      return;
    }
    if (
      [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
      ].includes(message.method)
    ) {
      const approvalId = randomUUID();
      active.pending.set(approvalId, message.id);
      enqueue(() =>
        emit("approval.requested", {
          id: approvalId,
          requestId: message.id,
          method: message.method,
          description: String(
            message.params?.command ||
              message.params?.reason ||
              JSON.stringify(message.params),
          ).slice(0, 5000),
        }),
      );
    } else rpc.reject(message.id);
  });
  rpc.on("notification", (message) => {
    if (message.method === "account/login/completed") {
      login = { status: message.params?.success ? "signed-in" : "failed" };
      return;
    }
    if (!active) return;
    const p = message.params || {};
    if (p.threadId && active.threadId && p.threadId !== active.threadId) return;
    if (message.method === "item/started")
      enqueue(() =>
        emit("activity", {
          kind: p.item?.type || "working",
          text: p.item?.command || "Codex is working",
        }),
      );
    if (message.method === "item/completed" && p.item?.type === "agentMessage")
      enqueue(() =>
        emit("message.assistant", {
          text: String(p.item.text || "").slice(0, 50000),
          itemId: p.item.id,
        }),
      );
    if (
      message.method === "item/completed" &&
      p.item?.type === "commandExecution"
    )
      enqueue(() =>
        emit("activity", {
          kind: "command",
          text: String(p.item.command || "Command completed").slice(0, 2000),
          output: String(p.item.aggregatedOutput || "").slice(-24000),
          exitCode: p.item.exitCode,
        }),
      );
    if (message.method === "item/completed" && p.item?.type === "fileChange")
      enqueue(() =>
        emit("activity", {
          kind: "files",
          text: "Files updated",
          changes: p.item.changes,
        }),
      );
    if (message.method === "turn/diff/updated")
      enqueue(() =>
        emit("activity", {
          kind: "diff",
          text: String(p.diff || "").slice(0, 50000),
        }),
      );
    if (message.method === "turn/completed")
      enqueue(async () => {
        if (!active) return;
        const status = p.turn?.status;
        await emit(
          status === "completed"
            ? "run.completed"
            : status === "interrupted"
              ? "run.cancelled"
              : "run.failed",
          { message: p.turn?.error?.message || status || "Turn ended" },
        );
        active = null;
      });
  });
  await rpc.initialize();
}
async function checkout(conversationId) {
  const path = join(worktrees, conversationId);
  try {
    await readFile(join(repo, "HEAD"));
  } catch {
    await exec("git", [
      "clone",
      "--bare",
      process.env.PROJECT_REPO ||
        "https://github.com/temcwilliams/codex-convos.git",
      repo,
    ]);
  }
  try {
    await exec("git", ["-C", path, "rev-parse", "--is-inside-work-tree"]);
    return path;
  } catch {
    await exec("git", [
      "--git-dir",
      repo,
      "fetch",
      "origin",
      process.env.PROJECT_REF || "main",
    ]);
    await exec("git", [
      "--git-dir",
      repo,
      "worktree",
      "add",
      "-b",
      "convos/" + conversationId,
      path,
      "FETCH_HEAD",
    ]);
    await exec("git", ["-C", path, "config", "credential.helper", ""]);
    return path;
  }
}
async function start(run) {
  const renew = setInterval(
    () =>
      api("heartbeat", {
        id,
        accountReady: true,
        accountType: "chatgpt",
        runId: run.id,
      }).catch(() => {}),
    10000,
  );
  active = {
    ...run,
    pending: new Map(),
    threadId: run.threadId,
    turnId: null,
    failed: false,
  };
  try {
    const cwd = await checkout(run.conversationId);
    const params = {
      cwd,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      developerInstructions:
        "Work only on the requested project. Edit files and run tests as needed. Do not push commits, open or merge pull requests, deploy, or publish changes. Never bypass the sandbox. Ask the owner when additional permissions are required.",
    };
    const response = run.threadId
      ? await rpc.request("thread/resume", {
          ...params,
          threadId: run.threadId,
        })
      : await rpc.request("thread/start", params);
    active.threadId = response.thread.id;
    await emit("thread.started", { threadId: active.threadId });
    const turn = await rpc.request("turn/start", {
      threadId: active.threadId,
      input: [{ type: "text", text: run.text, text_elements: [] }],
    });
    if (active) active.turnId = turn.turn.id;
  } catch {
    if (active) {
      await emit("run.failed", {
        message:
          "Runner could not start the task. Check runner sign-in, repository access and sandbox support.",
      }).catch(() => {});
      active = null;
    }
  } finally {
    clearInterval(renew);
  }
}
await boot();
process.on("SIGTERM", () => {
  stopping = true;
  rpc?.close();
});
while (!stopping) {
  try {
    if (!rpc) await boot();
    const account = await rpc.request("account/read", { refreshToken: false });
    accountReady = account.account?.type === "chatgpt";
    const control = await api("heartbeat", {
      id,
      accountReady,
      accountType: account.account?.type || "signed-out",
      runId: active?.id,
      login,
    });
    if (control.command && control.command.id !== lastCommand) {
      lastCommand = control.command.id;
      if (control.command.type === "login" && !active) {
        const result = await rpc.request("account/login/start", {
          type: "chatgptDeviceCode",
        });
        login = {
          status: "pending",
          userCode: result.userCode,
          verificationUrl: result.verificationUrl,
        };
      }
    }
    if (active?.failed) {
      if (active.turnId)
        await rpc
          .request("turn/interrupt", {
            threadId: active.threadId,
            turnId: active.turnId,
          })
          .catch(() => {});
      try {
        await emit("run.failed", {
          message:
            "Task event delivery failed; review the worktree before retrying.",
        });
      } finally {
        active = null;
      }
    }
    if (active && !control.leaseActive) {
      if (active.turnId)
        await rpc
          .request("turn/interrupt", {
            threadId: active.threadId,
            turnId: active.turnId,
          })
          .catch(() => {});
      active = null;
    }
    if (active) {
      if (control.cancelRequested && active.turnId) {
        await rpc.request("turn/interrupt", {
          threadId: active.threadId,
          turnId: active.turnId,
        });
      }
      for (const approval of control.approvals || []) {
        if (
          approval.decision &&
          !replied.has(approval.id) &&
          active.pending.has(approval.id)
        ) {
          rpc.reply(active.pending.get(approval.id), {
            decision: approval.decision,
          });
          replied.add(approval.id);
        }
      }
    } else if (accountReady) {
      const { run } = await api("claim", { id });
      if (run) await start(run);
    }
  } catch {
    console.error(
      "Runner waiting for connection or authentication; no task was retried",
    );
  }
  await new Promise((r) =>
    setTimeout(r, process.env.NODE_ENV === "test" ? 500 : 8000),
  );
}
