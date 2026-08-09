import type { BbPluginApi } from "@bb/plugin-sdk";
import {
  emptySnapshot,
  normalizeItems,
  type TodoItem,
  type TodoSnapshot,
} from "./model.js";

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS thread_todos (
    thread_id TEXT PRIMARY KEY NOT NULL,
    updated_at INTEGER NOT NULL,
    items_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS assignee_index (
    child_thread_id TEXT PRIMARY KEY NOT NULL,
    parent_thread_id TEXT NOT NULL,
    todo_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
];

export interface AssigneeLink {
  childThreadId: string;
  parentThreadId: string;
  todoId: string;
}

export function openTodoStore(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);

  const select = db.prepare(
    `SELECT thread_id, updated_at, items_json FROM thread_todos WHERE thread_id = ?`,
  );
  const upsert = db.prepare(
    `INSERT INTO thread_todos (thread_id, updated_at, items_json)
     VALUES (@threadId, @updatedAt, @itemsJson)
     ON CONFLICT(thread_id) DO UPDATE SET
       updated_at = excluded.updated_at,
       items_json = excluded.items_json`,
  );
  const remove = db.prepare(`DELETE FROM thread_todos WHERE thread_id = ?`);
  const listThreadIds = db.prepare(`SELECT thread_id FROM thread_todos`);

  const upsertLink = db.prepare(
    `INSERT INTO assignee_index (child_thread_id, parent_thread_id, todo_id, updated_at)
     VALUES (@childThreadId, @parentThreadId, @todoId, @updatedAt)
     ON CONFLICT(child_thread_id) DO UPDATE SET
       parent_thread_id = excluded.parent_thread_id,
       todo_id = excluded.todo_id,
       updated_at = excluded.updated_at`,
  );
  const deleteLink = db.prepare(
    `DELETE FROM assignee_index WHERE child_thread_id = ?`,
  );
  const deleteLinksForParent = db.prepare(
    `DELETE FROM assignee_index WHERE parent_thread_id = ?`,
  );
  const selectLink = db.prepare(
    `SELECT child_thread_id AS childThreadId,
            parent_thread_id AS parentThreadId,
            todo_id AS todoId
     FROM assignee_index WHERE child_thread_id = ?`,
  );
  const selectLinksByParent = db.prepare(
    `SELECT child_thread_id AS childThreadId,
            parent_thread_id AS parentThreadId,
            todo_id AS todoId
     FROM assignee_index WHERE parent_thread_id = ?`,
  );

  function rebuildIndex(snapshot: TodoSnapshot) {
    deleteLinksForParent.run(snapshot.threadId);
    const now = snapshot.updatedAt;
    for (const item of snapshot.items) {
      if (!item.assigneeThreadId) continue;
      upsertLink.run({
        childThreadId: item.assigneeThreadId,
        parentThreadId: snapshot.threadId,
        todoId: item.id,
        updatedAt: now,
      });
    }
  }

  function get(threadId: string): TodoSnapshot {
    const row = select.get(threadId) as
      | { thread_id: string; updated_at: number; items_json: string }
      | undefined;
    if (!row) return emptySnapshot(threadId);
    let items: TodoItem[] = [];
    try {
      const parsed: unknown = JSON.parse(row.items_json);
      if (Array.isArray(parsed)) items = normalizeItems(parsed, row.updated_at);
    } catch {
      items = [];
    }
    return {
      threadId: row.thread_id,
      updatedAt: row.updated_at,
      items,
    };
  }

  function save(snapshot: TodoSnapshot): TodoSnapshot {
    if (snapshot.items.length === 0) {
      remove.run(snapshot.threadId);
      deleteLinksForParent.run(snapshot.threadId);
      return emptySnapshot(snapshot.threadId, snapshot.updatedAt);
    }
    upsert.run({
      threadId: snapshot.threadId,
      updatedAt: snapshot.updatedAt,
      itemsJson: JSON.stringify(snapshot.items),
    });
    rebuildIndex(snapshot);
    return snapshot;
  }

  function clear(threadId: string, now = Date.now()): TodoSnapshot {
    remove.run(threadId);
    deleteLinksForParent.run(threadId);
    return emptySnapshot(threadId, now);
  }

  function knownThreadIds(): string[] {
    const rows = listThreadIds.all() as Array<{ thread_id: string }>;
    return rows.map((r) => r.thread_id);
  }

  function findByChildThread(childThreadId: string): {
    parent: TodoSnapshot;
    item: TodoItem;
    link: AssigneeLink;
  } | null {
    const link = selectLink.get(childThreadId) as AssigneeLink | undefined;
    if (!link) {
      // Fallback scan for legacy rows without index.
      for (const parentId of knownThreadIds()) {
        const parent = get(parentId);
        const item = parent.items.find((i) => i.assigneeThreadId === childThreadId);
        if (item) {
          return {
            parent,
            item,
            link: {
              childThreadId,
              parentThreadId: parentId,
              todoId: item.id,
            },
          };
        }
      }
      return null;
    }
    const parent = get(link.parentThreadId);
    const item = parent.items.find((i) => i.id === link.todoId);
    if (!item) return null;
    return { parent, item, link };
  }

  function listChildLinks(parentThreadId: string): AssigneeLink[] {
    return selectLinksByParent.all(parentThreadId) as AssigneeLink[];
  }

  function forgetChild(childThreadId: string) {
    deleteLink.run(childThreadId);
  }

  return {
    get,
    save,
    clear,
    knownThreadIds,
    findByChildThread,
    listChildLinks,
    forgetChild,
  };
}

export type TodoStore = ReturnType<typeof openTodoStore>;
