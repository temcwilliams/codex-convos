# Deployment checklist

- [x] Implement the owner/collaborator workspace and official Codex runner.
- [x] Add durable queue semantics, one-use invitations and owner approval controls.
- [x] Verify official app-server initialization without executing model work.
- [x] Validate local phone flow and persistent history.
- [x] Pass backend, storage and runner-protocol integration tests.
- [ ] Provision a dedicated **free** Neon database after its tools become available.
- [ ] Apply the workspace-state schema (the service bootstraps it idempotently).
- [ ] Create the free Render web service with production database and secret bindings.
- [ ] Verify deployed authentication and persistence across a restart.
- [ ] Connect an available runner and complete the owner's official device sign-in.
- [ ] Run a small owner-requested real task and verify worktree edits, events and follow-up.

The existing `my-codex-agents.onrender.com` viewer is separate and is not overwritten by this service. Do not report CODEX CONVOS as deployed until its own URL and durable database are verified.
