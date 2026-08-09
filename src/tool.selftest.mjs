/**
 * Lightweight self-test for model + tool logic (no bb host required).
 * Run: node src/tool.selftest.mjs
 */
import assert from "node:assert/strict";
import {
  nestedToFlat,
  deriveTree,
  countTodos,
  validateAcyclic,
  moveItem,
  waitingOnDeps,
  indexById,
} from "./model.ts";
import { formatSnapshotMarkdown } from "./format.ts";
import { executeTodoTool } from "./tool.ts";

function memoryStore() {
  const map = new Map();
  const links = new Map(); // childThreadId -> { parentThreadId, todoId }
  return {
    get(threadId) {
      return (
        map.get(threadId) ?? {
          threadId,
          updatedAt: 0,
          items: [],
        }
      );
    },
    save(snapshot) {
      map.set(snapshot.threadId, snapshot);
      for (const [child, link] of [...links.entries()]) {
        if (link.parentThreadId === snapshot.threadId) links.delete(child);
      }
      for (const item of snapshot.items) {
        if (item.assigneeThreadId) {
          links.set(item.assigneeThreadId, {
            parentThreadId: snapshot.threadId,
            todoId: item.id,
          });
        }
      }
      return snapshot;
    },
    clear(threadId, now = Date.now()) {
      map.delete(threadId);
      for (const [child, link] of [...links.entries()]) {
        if (link.parentThreadId === threadId) links.delete(child);
      }
      return { threadId, updatedAt: now, items: [] };
    },
    knownThreadIds() {
      return [...map.keys()];
    },
    findByChildThread(childThreadId) {
      const link = links.get(childThreadId);
      if (!link) return null;
      const parent = map.get(link.parentThreadId);
      if (!parent) return null;
      const item = parent.items.find((i) => i.id === link.todoId);
      if (!item) return null;
      return {
        parent,
        item,
        link: { childThreadId, ...link },
      };
    },
    forgetChild(childThreadId) {
      links.delete(childThreadId);
    },
    listChildLinks(parentThreadId) {
      return [...links.entries()]
        .filter(([, link]) => link.parentThreadId === parentThreadId)
        .map(([childThreadId, link]) => ({ childThreadId, ...link }));
    },
  };
}

const now = 1_700_000_000_000;
const { items, errors } = nestedToFlat(
  [
    {
      id: "api",
      content: "Ship API",
      children: [
        { id: "api.schema", content: "Define schema" },
        {
          id: "api.routes",
          content: "Add routes",
          dependsOn: ["api.schema"],
        },
        {
          id: "api.tests",
          content: "Tests",
          children: [
            {
              id: "api.tests.unit",
              content: "Unit tests",
              dependsOn: ["api.routes"],
            },
          ],
        },
      ],
    },
    {
      id: "docs",
      content: "Docs",
      dependsOn: ["api"],
      requires: ["review"],
    },
  ],
  now,
);

assert.equal(errors.length, 0, errors.join("; "));
assert.equal(items.length, 6);
const tree = deriveTree(items);
assert.equal(tree.length, 2);
assert.equal(tree[0].children.length, 3);
assert.equal(tree[0].children[2].children.length, 1);

const byId = indexById(items);
const routes = items.find((i) => i.id === "api.routes");
assert.deepEqual(waitingOnDeps(routes, byId), ["api.schema"]);

const counts = countTodos(items);
assert.equal(counts.total, 6);
assert.equal(counts.blocked, 3); // routes, unit tests, docs (api parent not complete — docs depends on api which is pending)
// Actually docs depends on api which is pending -> blocked
// routes blocked by schema
// unit tests blocked by routes
// api, schema, api.tests are pending ready? api.tests has no dependsOn
assert.ok(counts.ready >= 2);

const cycle = validateAcyclic([
  ...items,
  {
    ...items[0],
    id: "loop-a",
    dependsOn: ["loop-b"],
    parentId: null,
    content: "A",
    activeForm: null,
    status: "pending",
    priority: "medium",
    requires: [],
    notes: null,
    sortOrder: 99,
    createdAt: now,
    updatedAt: now,
  },
  {
    ...items[0],
    id: "loop-b",
    dependsOn: ["loop-a"],
    parentId: null,
    content: "B",
    activeForm: null,
    status: "pending",
    priority: "medium",
    requires: [],
    notes: null,
    sortOrder: 100,
    createdAt: now,
    updatedAt: now,
  },
]);
assert.equal(cycle.ok, false);

const moved = moveItem(items, "api.tests.unit", "api", null, now);
assert.equal(moved.error, undefined);
assert.equal(
  moved.items.find((i) => i.id === "api.tests.unit").parentId,
  "api",
);

const store = memoryStore();
const publishes = [];
const ctx = {
  threadId: "thr_test",
  projectId: "proj_test",
  store,
  publish: (id) => publishes.push(id),
  bb: {
    sdk: {
      threads: {
        get: async () => ({
          id: "thr_test",
          environmentId: null,
          providerId: "test",
        }),
        spawn: async () => {
          throw new Error("spawn not expected in unit selftest");
        },
      },
    },
  },
};

let out = await executeTodoTool(
  {
    action: "set",
    items: [
      {
        id: "a",
        content: "Parent",
        children: [
          { id: "a1", content: "Child 1" },
          { id: "a2", content: "Child 2", dependsOn: ["a1"] },
        ],
      },
    ],
  },
  ctx,
);
assert.equal(typeof out, "string");
assert.match(out, /a1/);
assert.match(out, /blocked by: a1|Ready next/);
assert.equal(publishes.at(-1), "thr_test");

out = await executeTodoTool(
  {
    action: "mark",
    mark: [
      { id: "a1", status: "completed" },
      { id: "a2", status: "in_progress", activeForm: "Doing child 2" },
    ],
  },
  ctx,
);
assert.match(out, /Doing child 2/);
assert.match(out, /completed a1/);

out = await executeTodoTool(
  { action: "assign", id: "a2", assignee: "worker" },
  ctx,
);
assert.match(out, /assigned a2|@worker|worker/i);

out = await executeTodoTool({ action: "list" }, ctx);
assert.match(out, /1\/3 complete|1\/3 complete/i);

const md = formatSnapshotMarkdown(store.get("thr_test"));
assert.match(md, /\*\*a\*\*/);

console.log("ok — todo selftest passed");
