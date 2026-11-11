import { getProject } from "./project.mjs";
import { projectFloor } from "./floor.mjs";
import express from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  token,
  digest,
  equal,
  passwordHash,
  passwordMatches,
  publicUser,
} from "./auth.mjs";
const credentials = z.object({
  email: z.email().transform((s) => s.toLowerCase()),
  password: z.string().min(12).max(200),
  name: z.string().min(1).max(60),
});
const loginSchema = z.object({
  email: z.email().transform((s) => s.toLowerCase()),
  password: z.string().min(1).max(200),
});
const textSchema = z.object({ text: z.string().trim().min(1).max(20000) });
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
const now = () => Date.now();
const active = (s) =>
  s.runs.filter((r) => ["queued", "running", "waiting"].includes(r.status));
function event(s, conversationId, type, data) {
  const id = (s.events.at(-1)?.id || 0) + 1;
  s.events.push({ id, conversationId, type, data, at: now() });
  return id;
}
function expireRuns(s) {
  for (const r of s.runs)
    if (["running", "waiting"].includes(r.status) && r.leaseUntil < now()) {
      r.status = "interrupted";
      r.finishedAt = now();
      event(s, r.conversationId, "run.interrupted", {
        runId: r.id,
        message:
          "Runner disconnected. Retry explicitly to avoid duplicate execution.",
      });
    }
}
export function createApp({
  store,
  setupKey,
  runnerKey,
  publicUrl = "",
  secureCookies = process.env.NODE_ENV === "production",
}) {
  if (!setupKey || setupKey.length < 32 || !runnerKey || runnerKey.length < 32)
    throw new Error(
      "OWNER_SETUP_KEY and RUNNER_KEY must each contain at least 32 characters",
    );
  let runtimeRunner = null;
  let runnerCommand = null;
  let queuedHint = true;
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(express.json({ limit: "128kb" }));
  app.use((req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "SAMEORIGIN",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'",
    });
    next();
  });
  const attempts = new Map();
  app.use("/api", (req, res, next) => {
    const key = req.ip;
    const value = attempts.get(key);
    if (!value || value.until < now())
      attempts.set(key, { n: 1, until: now() + 60000 });
    else if (++value.n > 240)
      return res
        .status(429)
        .json({ error: "Too many requests; wait a minute" });
    if (attempts.size > 10000) attempts.clear();
    next();
  });
  app.use("/api", (req, res, next) => {
    if (
      ["POST", "PUT", "DELETE", "PATCH"].includes(req.method) &&
      !req.path.startsWith("/runner/")
    ) {
      if (!req.is("application/json") || req.get("x-codex-client") !== "web")
        return res.status(403).json({ error: "Invalid request" });
      const origin = req.get("origin");
      const expected = publicUrl || `${req.protocol}://${req.get("host")}`;
      if (origin && origin !== expected)
        return res.status(403).json({ error: "Invalid origin" });
    }
    next();
  });
  const browserUser = async (req) => {
    const raw = (req.headers.cookie || "")
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("cc_session="))
      ?.slice(11);
    const s = await store.read();
    const session = s.sessions.find(
      (x) => x.hash === digest(raw) && x.expires > now(),
    );
    return session ? s.users.find((u) => u.id === session.userId) : null;
  };
  const auth = async (req, res, next) => {
    req.user = await browserUser(req);
    if (!req.user) return res.status(401).json({ error: "Sign in required" });
    next();
  };
  const owner = (req, res, next) =>
    req.user.role === "owner"
      ? next()
      : res.status(403).json({ error: "Owner permission required" });
  const runner = (req, res, next) =>
    equal(req.get("authorization"), `Bearer ${runnerKey}`)
      ? next()
      : res.status(401).json({ error: "Invalid runner credential" });
  async function session(res, user) {
    const key = token();
    await store.change((s) => {
      s.sessions = s.sessions.filter((x) => x.expires > now());
      s.sessions.push({
        hash: digest(key),
        userId: user.id,
        expires: now() + 7 * 86400000,
      });
    });
    res.cookie("cc_session", key, {
      httpOnly: true,
      secure: secureCookies,
      sameSite: "strict",
      maxAge: 7 * 86400000,
      path: "/",
    });
    return publicUser(user);
  }
  app.get("/health", async (req, res) => {
    await store.read();
    res.json({ ok: true });
  });
  app.get("/api/session", async (req, res) => {
    const s = await store.read();
    res.json({
      user: (await browserUser(req))
        ? publicUser(await browserUser(req))
        : null,
      setupRequired: !s.users.length,
    });
  });
  const authAttempts = new Map();
  app.use(["/api/login", "/api/setup", "/api/join"], (req, res, next) => {
    const value = authAttempts.get(req.ip) || { n: 0, until: now() + 60000 };
    if (value.until < now()) {
      value.n = 0;
      value.until = now() + 60000;
    }
    value.n++;
    authAttempts.set(req.ip, value);
    if (value.n > 10)
      return res
        .status(429)
        .json({ error: "Too many sign-in attempts; wait a minute" });
    next();
  });
  app.post("/api/setup", async (req, res) => {
    if (!equal(req.body.setupKey, setupKey)) fail(403, "Invalid setup key");
    const c = credentials.parse(req.body);
    const u = {
      ...c,
      id: randomUUID(),
      role: "owner",
      password: passwordHash(c.password),
    };
    await store.change((s) => {
      if (s.users.length) fail(409, "Owner already configured");
      s.users.push(u);
    });
    res.json({ user: await session(res, u) });
  });
  app.post("/api/login", async (req, res) => {
    const c = loginSchema.parse(req.body);
    const u = (await store.read()).users.find((u) => u.email === c.email);
    if (!u || !passwordMatches(c.password, u.password))
      fail(401, "Email or password incorrect");
    res.json({ user: await session(res, u) });
  });
  app.post("/api/logout", auth, async (req, res) => {
    const raw = (req.headers.cookie || "")
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("cc_session="))
      ?.slice(11);
    await store.change((s) => {
      s.sessions = s.sessions.filter((x) => x.hash !== digest(raw));
    });
    res.clearCookie("cc_session");
    res.json({ ok: true });
  });
  app.post("/api/invitations", auth, owner, async (req, res) => {
    const email = z.email().parse(req.body.email).toLowerCase();
    const key = token();
    await store.change((s) => {
      s.invites = s.invites.filter(
        (i) => i.expires > now() && i.email !== email,
      );
      s.invites.push({
        hash: digest(key),
        email,
        expires: now() + 2 * 86400000,
      });
    });
    res.json({ invitePath: `/?invite=${key}`, expiresInHours: 48 });
  });
  app.post("/api/join", async (req, res) => {
    const c = credentials.parse(req.body),
      key = z.string().parse(req.body.invite);
    const u = {
      ...c,
      id: randomUUID(),
      role: "collaborator",
      password: passwordHash(c.password),
    };
    await store.change((s) => {
      const invite = s.invites.find(
        (i) =>
          i.hash === digest(key) && i.expires > now() && i.email === c.email,
      );
      if (!invite) fail(403, "Invitation invalid or expired");
      if (s.users.some((u) => u.email === c.email))
        fail(409, "Account already exists");
      s.invites = s.invites.filter((i) => i !== invite);
      s.users.push(u);
    });
    res.json({ user: await session(res, u) });
  });
  app.get("/api/project", auth, async (req, res) =>
    res.json(await getProject()),
  );
  app.get("/api/members", auth, owner, async (req, res) =>
    res.json({ members: (await store.read()).users.map(publicUser) }),
  );
  app.post("/api/members/:id/revoke", auth, owner, async (req, res) => {
    await store.change((s) => {
      const u = s.users.find((u) => u.id === req.params.id);
      if (!u || u.role === "owner")
        fail(409, "Only collaborators can be removed");
      s.users = s.users.filter((u) => u.id !== req.params.id);
      s.sessions = s.sessions.filter((x) => x.userId !== req.params.id);
    });
    res.json({ ok: true });
  });
  app.get("/api/export", auth, owner, async (req, res) => {
    const s = await store.read();
    res.set(
      "Content-Disposition",
      'attachment; filename="codex-convos-history.json"',
    );
    res.json({
      exportedAt: now(),
      conversations: s.conversations,
      runs: s.runs,
      events: s.events,
    });
  });
  app.post("/api/runner-login", auth, owner, async (req, res) => {
    const state = await store.read();
    if (active(state).some((r) => r.status !== "queued"))
      fail(409, "Stop the active task before changing sign-in");
    runnerCommand = { id: randomUUID(), type: "login" };
    res.json({ ok: true });
  });
  app.get("/api/workspace", auth, async (req, res) => {
    let s = await store.read();
    if (
      s.runs.some(
        (r) =>
          ["running", "waiting"].includes(r.status) && r.leaseUntil < now(),
      )
    ) {
      await store.change(expireRuns);
      s = await store.read();
    }
    const runner =
      runtimeRunner && runtimeRunner.lastSeen > now() - 45000
        ? { ...runtimeRunner, online: true }
        : { online: false, accountReady: false };
    if (req.user.role !== "owner") delete runner.login;
    res.json({
      user: publicUser(req.user),
      project: {
        name: "CODEX CONVOS",
        repo: "https://github.com/temcwilliams/codex-convos",
      },
      conversations: s.conversations
        .map((c) => ({
          ...c,
          run: s.runs.filter((r) => r.conversationId === c.id).at(-1) || null,
        }))
        .reverse(),
      runner,
    });
  });
  app.post("/api/conversations", auth, async (req, res) => {
    const { text } = textSchema.parse(req.body);
    const c = {
      id: randomUUID(),
      title: text.slice(0, 80),
      createdBy: req.user.id,
      createdAt: now(),
    };
    const run = {
      id: randomUUID(),
      conversationId: c.id,
      text,
      status: "queued",
      createdAt: now(),
      createdBy: req.user.id,
      threadId: null,
      leaseUntil: 0,
      approvals: [],
    };
    await store.change((s) => {
      if (s.conversations.length >= 500)
        fail(409, "Workspace conversation limit reached");
      s.conversations.push(c);
      s.runs.push(run);
      event(s, c.id, "message.user", { text, user: req.user.name });
      event(s, c.id, "run.queued", { runId: run.id });
    });
    queuedHint = true;
    res.json({ conversation: c, run });
  });
  app.get("/api/conversations/:id", auth, async (req, res) => {
    const s = await store.read();
    const c = s.conversations.find((x) => x.id === req.params.id);
    if (!c) fail(404, "Conversation not found");
    const cursor = Number(req.query.after) || 0;
    res.json({
      conversation: c,
      events: s.events.filter(
        (e) => e.conversationId === c.id && e.id > cursor,
      ),
      runs: s.runs.filter((r) => r.conversationId === c.id),
    });
  });
  app.post("/api/conversations/:id/messages", auth, async (req, res) => {
    const { text } = textSchema.parse(req.body);
    const run = {
      id: randomUUID(),
      conversationId: req.params.id,
      text,
      status: "queued",
      createdAt: now(),
      createdBy: req.user.id,
      leaseUntil: 0,
      approvals: [],
    };
    await store.change((s) => {
      expireRuns(s);
      if (!s.conversations.some((c) => c.id === req.params.id))
        fail(404, "Conversation not found");
      if (active(s).some((r) => r.conversationId === req.params.id))
        fail(409, "Wait for the current task or stop it first");
      run.threadId =
        s.runs
          .filter((r) => r.conversationId === req.params.id && r.threadId)
          .at(-1)?.threadId || null;
      s.runs.push(run);
      event(s, run.conversationId, "message.user", {
        text,
        user: req.user.name,
      });
      event(s, run.conversationId, "run.queued", { runId: run.id });
    });
    queuedHint = true;
    res.json({ run });
  });
  app.post("/api/runs/:id/stop", auth, async (req, res) => {
    await store.change((s) => {
      const r = s.runs.find((r) => r.id === req.params.id);
      if (!r) fail(404, "Task not found");
      r.cancelRequested = true;
      if (r.status === "queued") r.status = "cancelled";
      event(s, r.conversationId, "run.stop_requested", { runId: r.id });
    });
    res.json({ ok: true });
  });
  app.post(
    "/api/runs/:id/approvals/:approvalId",
    auth,
    owner,
    async (req, res) => {
      const decision = z
        .enum(["accept", "decline", "cancel"])
        .parse(req.body.decision);
      await store.change((s) => {
        const r = s.runs.find((r) => r.id === req.params.id);
        const a = r?.approvals.find((a) => a.id === req.params.approvalId);
        if (!a || a.decision || r.status !== "waiting")
          fail(409, "Approval is no longer pending");
        a.decision = decision;
        r.status = r.approvals.some((a) => !a.decision) ? "waiting" : "running";
        event(s, r.conversationId, "approval.decided", {
          approvalId: a.id,
          decision,
          user: req.user.name,
        });
      });
      res.json({ ok: true });
    },
  );
  app.post("/api/runner/heartbeat", runner, async (req, res) => {
    const body = z
      .object({
        id: z.string().min(1).max(100),
        accountReady: z.boolean(),
        accountType: z.string().max(30).optional(),
        runId: z.string().optional(),
        login: z
          .object({
            status: z.string().max(30),
            userCode: z.string().max(100).optional(),
            verificationUrl: z
              .url()
              .refine((u) => {
                const x = new URL(u);
                return (
                  x.protocol === "https:" &&
                  [
                    "auth.openai.com",
                    "chatgpt.com",
                    "auth0.openai.com",
                  ].includes(x.hostname)
                );
              })
              .optional(),
          })
          .nullable()
          .optional(),
      })
      .parse(req.body);
    if (
      runtimeRunner &&
      runtimeRunner.id !== body.id &&
      runtimeRunner.lastSeen > now() - 45000
    )
      fail(409, "Another runner is connected");
    runtimeRunner = {
      id: body.id,
      lastSeen: now(),
      accountReady: body.accountReady,
      accountType: body.accountType || "unknown",
      login: body.login || null,
    };
    if (body.accountReady) runnerCommand = null;
    let control = {
      cancelRequested: false,
      approvals: [],
      leaseActive: false,
      command: runnerCommand,
    };
    if (body.runId)
      control = await store.change((s) => {
        expireRuns(s);
        const r = s.runs.find((r) => r.id === body.runId);
        if (
          r &&
          r.runnerId === body.id &&
          ["running", "waiting"].includes(r.status)
        )
          r.leaseUntil = now() + 45000;
        return {
          cancelRequested: !!r?.cancelRequested,
          approvals: r?.approvals || [],
          leaseActive: !!r && ["running", "waiting"].includes(r.status),
          command: runnerCommand,
        };
      });
    res.json(control);
  });
  app.post("/api/runner/claim", runner, async (req, res) => {
    const id = z.string().parse(req.body.id);
    if (
      !runtimeRunner ||
      runtimeRunner.id !== id ||
      !runtimeRunner.accountReady ||
      runtimeRunner.lastSeen < now() - 45000 ||
      !queuedHint
    ) {
      res.json({ run: null });
      return;
    }
    const outcome = await store.change((s) => {
      expireRuns(s);
      if (active(s).some((r) => r.status !== "queued"))
        return { run: null, hasQueued: true };
      const r = s.runs.find((r) => r.status === "queued");
      if (!r) return { run: null, hasQueued: false };
      r.status = "running";
      r.runnerId = id;
      r.leaseUntil = now() + 45000;
      event(s, r.conversationId, "run.started", { runId: r.id });
      return { run: r, hasQueued: s.runs.some((x) => x.status === "queued") };
    });
    queuedHint = outcome.hasQueued;
    res.json({ run: outcome.run });
  });
  app.post("/api/runner/runs/:id/events", runner, async (req, res) => {
    const body = z
      .object({
        runnerId: z.string(),
        eventId: z.string().max(120),
        type: z.enum([
          "message.assistant",
          "activity",
          "approval.requested",
          "thread.started",
          "run.completed",
          "run.failed",
          "run.cancelled",
        ]),
        data: z.record(z.string(), z.unknown()),
      })
      .parse(req.body);
    if (JSON.stringify(body.data).length > 64000) fail(413, "Event too large");
    await store.change((s) => {
      const r = s.runs.find((r) => r.id === req.params.id);
      if (
        !r ||
        r.runnerId !== body.runnerId ||
        r.leaseUntil < now() ||
        !["running", "waiting"].includes(r.status)
      )
        fail(409, "Task lease is no longer active");
      if (s.events.some((e) => e.data?.eventId === body.eventId)) return;
      r.leaseUntil = now() + 45000;
      if (body.type === "thread.started")
        r.threadId = z.string().parse(body.data.threadId);
      if (body.type === "approval.requested") {
        const a = {
          id: z.string().parse(body.data.id),
          requestId: body.data.requestId,
          method: body.data.method,
          description: String(
            body.data.description || "Permission required",
          ).slice(0, 5000),
        };
        r.approvals.push(a);
        r.status = "waiting";
      }
      if (body.type.startsWith("run.")) {
        r.status = {
          "run.completed": "completed",
          "run.failed": "failed",
          "run.cancelled": "cancelled",
        }[body.type];
        r.finishedAt = now();
      }
      event(s, r.conversationId, body.type, {
        ...body.data,
        eventId: body.eventId,
        runId: r.id,
      });
    });
    res.json({ ok: true });
  });
  app.get("/state", auth, async (req, res) =>
    res.json(projectFloor(await store.read())),
  );
  app.use(
    express.static(new URL("../public", import.meta.url).pathname, {
      etag: true,
    }),
  );
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    res.status(err instanceof z.ZodError ? 400 : err.status || 500).json({
      error:
        err instanceof z.ZodError
          ? "Invalid input"
          : err.status
            ? err.message
            : "Request failed; please retry",
    });
  });
  return app;
}
