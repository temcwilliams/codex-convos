# CODEX CONVOS

A private, mobile-first coding workspace for the owner and invited collaborators. Conversations started here are automatically tracked, including messages, tool activity, approvals, cancellation and completion. The office view is derived from those same records.

This does **not** discover existing ChatGPT or Codex app conversations. It runs new tasks through an official Codex app-server connected to this workspace.

## Components

- **Web control service:** Node 24, Express, authenticated API and mobile UI.
- **History store:** PostgreSQL in production; SQLite on disk for local development. Production refuses to start without `DATABASE_URL`.
- **Runner:** a separately connected process using official Codex app-server over stdio. It signs in through OpenAI's device-code flow and uses the owner's eligible subscription. Credentials remain in its dedicated Codex home, not the web database or repository.
- **Execution:** one active task at a time, per-conversation Git worktrees, workspace-write sandbox, owner approvals for extra permissions. The runner does not receive web-service credentials in the Codex child environment. Do not invite untrusted people: collaborators can request code execution on the owner's connected runner. This is a small trusted-team app, not a public code execution service.

## Free-tier deployment

Use a Render free web service and a dedicated Neon free PostgreSQL project, subject to their current limits. Do not create a paid resource as part of this deployment. Render can sleep while unused. The runner must stay connected on a trusted supported computer or development environment. Free hosting does not provide an always-on agent machine.

### Web service

The repository includes a Dockerfile. Set:

- `NODE_ENV=production`
- `DATABASE_URL`: the PostgreSQL connection string with verified TLS (for Neon, `sslmode=verify-full`). Set it in the hosting provider's secret environment settings.
- `OWNER_SETUP_KEY`: a random secret with at least 32 characters, used once to create the owner.
- `RUNNER_KEY`: a separate random secret with at least 32 characters, used only by the runner.
- `PUBLIC_URL`: the exact HTTPS origin of the deployed web service.

Health endpoint: `/health`. Do not expose the local SQLite database on an ephemeral production filesystem. Never commit real keys or put account tokens in prompts.

### First owner and collaborators

Open the deployed URL. Enter the owner setup key, email, name and a new password of at least 12 characters. The app permits only one owner bootstrap. After that, create email-bound, one-use invitations in **People & invitations**; invitations expire after 48 hours. Owner controls can remove collaborators and invalidate their sessions. Owner-only history export excludes password hashes, session credentials and invitations.

### Runner

1. Install an official Codex CLI that supports `codex app-server --stdio` and device-code sign-in. The protocol was checked against the installed CLI `0.167.0-alpha.4`; test compatibility when upgrading.
2. Install Node 24 and Git on the runner computer. Clone this repository and run `npm ci`.
3. Put `CONVOS_URL`, `RUNNER_KEY` and optionally `RUNNER_HOME` in a local ignored `.env`. Keep it readable only by the runner user. Do **not** copy `DATABASE_URL` or `OWNER_SETUP_KEY` to this computer.
4. Run `npm run runner` (use `NODE_USE_ENV_PROXY=1` when the environment requires an HTTP proxy).
5. In the owner web session, click **Connect Codex subscription**. Open the official OpenAI sign-in URL and enter the one-time device code. Never share passwords or access tokens in chat.
6. Once the UI says **Codex connected**, create a conversation. Tasks are queued while the runner is unavailable. The runner checks for work every eight seconds.

The runner clones `temcwilliams/codex-convos` and creates a separate Git worktree for each conversation. Follow-ups resume that conversation's native Codex thread. It does not silently create a replacement thread when a saved thread or worktree is unavailable. No GitHub credential is passed into Codex. Publishing changes, merging and deployment are not automatic features of the runner.

## Reliability and limits

Queue claims and updates use an optimistic compare-and-swap transaction on a versioned workspace document. This is designed for a small shared workspace; it is not a high-volume multi-tenant database design. Task events use idempotency keys. Runner leases expire after 45 seconds, after which uncertain tasks are marked interrupted and are **not** automatically executed again. Retry with an explicit follow-up after reviewing the worktree.

A stopped runner loses no saved web history. Its own Codex home and Git worktrees must be preserved to resume native threads and retain uncommitted code. Subscription eligibility, quotas and sign-in policy are controlled by OpenAI. Successful sign-in is not a guarantee of available model quota.

## Local development

```sh
npm ci
cp .env.example .env
# Generate distinct OWNER_SETUP_KEY and RUNNER_KEY; configure PORT as needed.
npm run dev
```

SQLite history lives in `data/convos.sqlite` by default. It is ignored by Git. Local development data is not automatically promoted to production.

## Validation

```sh
npm run check
npm test
```

The tests cover owner bootstrap, private access, one-use invitations, atomic claims, event deduplication, approvals, leases, persistence, the office projection and the runner protocol through a **test-only** Codex peer. Protocol fixture tests do not call a model or prove production subscription access. Real end-to-end model execution remains a deployment check after the owner's sign-in.

## Third-party visualizer

The office assets and reducer derive from Agent Floor (MIT), provided by the user's original archive. License: `lib/AGENT-FLOOR-LICENSE`. The bundled visualizer includes Three.js (MIT), Geist/Geist Mono fonts (SIL Open Font License), and Phosphor icons (MIT).
