import { openStore } from "./store.mjs";
import { createApp } from "./app.mjs";
const store = await openStore();
const app = createApp({
  store,
  setupKey: process.env.OWNER_SETUP_KEY,
  runnerKey: process.env.RUNNER_KEY,
  publicUrl: process.env.PUBLIC_URL,
});
const server = app.listen(Number(process.env.PORT) || 3000, "0.0.0.0", () =>
  console.log("CODEX CONVOS listening"),
);
process.on("SIGTERM", () =>
  server.close(async () => {
    await store.close();
    process.exit(0);
  }),
);
