# CODEX CONVOS implementation plan

## Goal and scope

A private, mobile-first workspace for conversations created here. Invited collaborators can view shared projects and start tasks. The owner manages invitations and the subscription-backed Codex runner. Existing OpenAI app conversations are outside this system's coverage.

## Architecture

- Node 24 web service: authenticated API, responsive conversation UI, invitation management, event replay and work queue.
- PostgreSQL in production (free Neon tier after connection); SQLite on disk for local development. The production service refuses ephemeral storage.
- Separate outbound-polling runner: official Codex app-server over stdio, device-code sign-in, per-conversation Git worktrees, workspace-write sandbox and user approvals for sandbox escapes.
- Durable messages, events and queued runs. Atomic job claims with renewable leases. Runner loss marks execution interrupted and never silently reruns an uncertain task.
- Git publishing, merging and hosting changes are explicit owner actions, not automatic runner features. No GitHub credential is supplied to the agent process.

## Free-tier operating constraints

Render can sleep. A connected runner must remain available for task execution. Database retention depends on the selected provider's free-tier terms. The UI shows runner readiness and queued tasks, not simulated activity. No paid resource is provisioned without authorization.

## Delivery order

1. Build storage/authentication, invitations and durable queue with integration tests.
2. Build mobile conversation list, live messages, activity, stop and approval controls.
3. Implement official app-server bridge, device sign-in and event mapping; test protocol transport with fixtures and real initialization.
4. Add deployment configuration, setup diagnostics and operational documentation.
5. Validate browser flows and deploy only with persistent production storage configured. Verify real end-to-end execution only after owner sign-in.
