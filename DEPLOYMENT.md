# Deployment checklist

- [x] Implement the owner/collaborator workspace and official Codex runner.
- [x] Add durable queue semantics, one-use invitations and owner approval controls.
- [x] Verify official app-server initialization without executing model work.
- [x] Validate local phone flow and persistent history.
- [x] Pass backend, storage and runner-protocol integration tests.
- [x] Provision a dedicated **free** Neon database (winter-river-70351562).
- [x] Validate the schema and versioned update on isolated branch br-long-paper-bfsaeod8.
- [x] Verify schema initialization on production branch br-old-lab-bfmw7orj during deployment.
- [x] Create free Render service srv-dbqfr956e07s73f342l0 with verified-TLS database and secret bindings.
- [x] Verify deployed setup page, PostgreSQL readiness and unclaimed owner state.
- [ ] Verify owner conversation history across a restart after owner registration.
- [x] Connect the workspace runner; its current status is waiting for owner sign-in.
- [ ] Complete the owner's official Codex device sign-in.
- [ ] Run a small owner-requested real task and verify worktree edits, events and follow-up.

The existing `my-codex-agents.onrender.com` viewer is separate and is not overwritten by this service. Do not report CODEX CONVOS as deployed until its own URL and durable database are verified.

Live workspace: https://codex-convos.onrender.com

The owner setup key is held only in Render secret settings. The existing viewer access code was reused for this one-time owner setup to avoid another credential handoff. Choose a separate owner password in the web UI. No owner password, OAuth token or real model task has been created by the deployment process. The connected workspace runner is available only while this execution environment remains running.
