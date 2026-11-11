# CODEX CONVOS

Project workspace for coding work with Codex.

Tracking covers GitHub repository activity and notifications from configured Codex CLI sessions working in this directory. It does not import ChatGPT conversations or account-wide Codex history.

The protected viewer is https://my-codex-agents.onrender.com.

## Tracking

GitHub activity is visible in the CODEX CONVOS panel on the protected viewer. It refreshes every five minutes while the dashboard is open. GitHub API failures appear in the panel instead of invented data. Public repository tracking does not require a GitHub token on the host.

Codex CLI sessions started with this folder as their working directory use the workspace's configured notify hook. Completed turns report to the viewer under the codex-convos team. A GitHub commit alone does not start a Codex agent. ChatGPT conversations and sessions on other computers are not automatically imported.
