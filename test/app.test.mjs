import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";
import { openStore } from "../server/store.mjs";
const setupKey = "test-owner-setup-key-with-32-characters",
  runnerKey = "test-runner-key-with-at-least-32-characters";
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "convos-test-"));
  const store = await openStore({ file: join(dir, "test.sqlite") });
  const app = createApp({ store, setupKey, runnerKey, secureCookies: false });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const call = async (path, data, cookie = "", runner = false) => {
    const response = await fetch(base + "/api" + path, {
      method: data === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Codex-Client": "web",
        Cookie: cookie,
        ...(runner ? { Authorization: "Bearer " + runnerKey } : {}),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return {
      status: response.status,
      body: await response.json(),
      cookie: response.headers.get("set-cookie")?.split(";")[0],
    };
  };
  return { store, call, base };
}
async function owner(call) {
  const result = await call("/setup", {
    setupKey,
    email: "owner@example.com",
    name: "Owner",
    password: "owner-test-password",
  });
  assert.equal(result.status, 200);
  return result.cookie;
}
test("owner bootstrap is single-use, sign-in is private and invitations are email-bound and one-use", async (t) => {
  const { call } = await fixture(t);
  assert.equal((await call("/workspace")).status, 401);
  const cookie = await owner(call);
  assert.equal(
    (
      await call("/setup", {
        setupKey,
        email: "other@example.com",
        name: "Other",
        password: "different-password",
      })
    ).status,
    409,
  );
  const invite = await call(
    "/invitations",
    { email: "friend@example.com" },
    cookie,
  );
  const key = new URL(invite.body.invitePath, "http://local").searchParams.get(
    "invite",
  );
  assert.equal(
    (
      await call("/join", {
        invite: key,
        email: "wrong@example.com",
        name: "Wrong",
        password: "test-password-123",
      })
    ).status,
    403,
  );
  const joined = await call("/join", {
    invite: key,
    email: "friend@example.com",
    name: "Friend",
    password: "test-password-123",
  });
  assert.equal(joined.status, 200);
  assert.equal(joined.body.user.role, "collaborator");
  assert.equal(
    (
      await call("/join", {
        invite: key,
        email: "friend@example.com",
        name: "Friend",
        password: "test-password-123",
      })
    ).status,
    403,
  );
  assert.equal(
    (await call("/invitations", { email: "more@example.com" }, joined.cookie))
      .status,
    403,
  );
  const members = await call("/members", undefined, cookie);
  const friend = members.body.members.find((m) => m.role === "collaborator");
  assert.equal(
    (await call("/members/" + friend.id + "/revoke", {}, cookie)).status,
    200,
  );
  assert.equal(
    (await call("/workspace", undefined, joined.cookie)).status,
    401,
  );
  await call("/logout", {}, cookie);
  assert.equal((await call("/workspace", undefined, cookie)).status, 401);
});
test("queue claims are atomic, events are idempotent, approvals require owner, and history survives reopening storage", async (t) => {
  const { call, store } = await fixture(t);
  const cookie = await owner(call);
  const created = await call(
    "/conversations",
    { text: "Implement the task" },
    cookie,
  );
  const cid = created.body.conversation.id;
  await call(
    "/runner/heartbeat",
    { id: "runner-one", accountReady: true, accountType: "chatgpt" },
    "",
    true,
  );
  const claims = await Promise.all([
    call("/runner/claim", { id: "runner-one" }, "", true),
    call("/runner/claim", { id: "runner-one" }, "", true),
  ]);
  assert.equal(claims.filter((c) => c.body.run).length, 1);
  const run = claims.find((c) => c.body.run).body.run;
  const emit = (type, data, eventId = type) =>
    call(
      `/runner/runs/${run.id}/events`,
      { runnerId: "runner-one", eventId, type, data },
      "",
      true,
    );
  await emit("message.assistant", { text: "A real reply" });
  await emit("message.assistant", { text: "A real reply" });
  await emit("approval.requested", {
    id: "approve-one",
    requestId: 1,
    method: "item/commandExecution/requestApproval",
    description: "Network request",
  });
  const before = await call("/conversations/" + cid, undefined, cookie);
  assert.equal(
    before.body.events.filter((e) => e.type === "message.assistant").length,
    1,
  );
  assert.equal(
    (
      await call(
        `/runs/${run.id}/approvals/approve-one`,
        { decision: "accept" },
        cookie,
      )
    ).status,
    200,
  );
  const control = await call(
    "/runner/heartbeat",
    { id: "runner-one", runId: run.id, accountReady: true },
    "",
    true,
  );
  assert.equal(control.body.approvals[0].decision, "accept");
  await emit("run.completed", { message: "Done" });
  assert.equal(
    (await call("/runner/claim", { id: "runner-one" }, "", true)).body.run,
    null,
  );
  const state = await store.read();
  assert.equal(state.runs[0].status, "completed");
  assert.ok(state.events.some((e) => e.type === "message.user"));
  assert.equal(
    (
      await call(
        `/runner/runs/${run.id}/events`,
        { runnerId: "runner-one", eventId: "late", type: "activity", data: {} },
        "",
        true,
      )
    ).status,
    409,
  );
});
test("expired leases interrupt tasks without automatic execution retries and queued tasks can be stopped", async (t) => {
  const { call, store } = await fixture(t);
  const cookie = await owner(call);
  const first = await call("/conversations", { text: "Task one" }, cookie);
  await call("/runner/heartbeat", { id: "r", accountReady: true }, "", true);
  await call("/runner/claim", { id: "r" }, "", true);
  await store.change((s) => {
    s.runs[0].leaseUntil = 0;
  });
  const workspace = await call("/workspace", undefined, cookie);
  assert.equal(workspace.body.conversations[0].run.status, "interrupted");
  assert.equal(
    (await call("/runner/claim", { id: "r" }, "", true)).body.run,
    null,
  );
  const second = await call("/conversations", { text: "Task two" }, cookie);
  await call("/runs/" + second.body.run.id + "/stop", {}, cookie);
  assert.equal(
    (await call("/runner/claim", { id: "r" }, "", true)).body.run,
    null,
  );
});
test("production refuses ephemeral history and workspace CAS does not lose concurrent updates", async () => {
  await assert.rejects(
    openStore({ production: true, url: null }),
    /DATABASE_URL/,
  );
  const dir = await mkdtemp(join(tmpdir(), "convos-store-"));
  const file = join(dir, "state.sqlite");
  let store = await openStore({ file });
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      store.change((s) => s.conversations.push({ id: String(i) })),
    ),
  );
  await store.close();
  store = await openStore({ file });
  assert.equal((await store.read()).conversations.length, 8);
  await store.close();
  await rm(dir, { recursive: true, force: true });
});
