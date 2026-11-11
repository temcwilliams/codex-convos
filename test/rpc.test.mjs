import { test } from "node:test";
import assert from "node:assert/strict";
import { projectFloor } from "../server/floor.mjs";
test("the office derives queued and running agents from actual conversation state", () => {
  const s = {
    conversations: [{ id: "c1", title: "My task" }],
    runs: [
      {
        id: "r",
        conversationId: "c1",
        status: "queued",
        text: "Build it",
        createdAt: Date.now(),
      },
    ],
    events: [],
  };
  let floor = projectFloor(s);
  assert.equal(floor.agents.c1.status, "idle");
  assert.match(floor.agents.c1.activity, /Waiting/);
  s.runs[0].status = "running";
  floor = projectFloor(s);
  assert.equal(floor.agents.c1.status, "working");
  s.conversations = [];
  assert.deepEqual(projectFloor(s).agents, {});
});
