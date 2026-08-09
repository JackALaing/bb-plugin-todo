import {
  MAX_DEPS,
  MAX_DEPTH,
  MAX_ITEMS,
  NOTES_MAX,
  PRIORITIES,
  REPORT_MAX,
  STATUSES,
  TEXT_MAX,
  type TodoPriority,
  type TodoStatus,
} from "./constants.js";
import {
  DISPATCH_STATUSES,
  isRole,
  type DispatchStatus,
  type TodoRole,
} from "./roles.js";

export interface TodoItem {
  id: string;
  content: string;
  activeForm: string | null;
  status: TodoStatus;
  priority: TodoPriority;
  parentId: string | null;
  dependsOn: string[];
  requires: string[];
  notes: string | null;
  /** Who should execute this item. */
  assigneeRole: TodoRole;
  /** Optional custom label (especially for role=custom). */
  assigneeLabel: string | null;
  /** Child BB thread currently (or last) assigned to this todo. */
  assigneeThreadId: string | null;
  dispatchStatus: DispatchStatus;
  /** Last report summary from a child agent. */
  lastReport: string | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface NestedTodoInput {
  id?: string;
  content: string;
  activeForm?: string;
  status?: TodoStatus;
  priority?: TodoPriority;
  /** Task ids that must be completed before this can start. */
  dependsOn?: string[];
  /**
   * Alias for dependsOn (accepted for LLM convenience). Merged with dependsOn.
   * Prefer dependsOn in new calls.
   */
  blockedBy?: string[];
  /**
   * Freeform prerequisites that are not other todos (env, approval, docs…).
   * Shown in the UI; does not auto-block by task graph.
   */
  requires?: string[];
  notes?: string;
  /** Assign on create: self | scout | worker | reviewer | custom */
  assignee?: TodoRole | string;
  assigneeRole?: TodoRole | string;
  assigneeLabel?: string;
  children?: NestedTodoInput[];
}

function parseRole(raw: unknown): TodoRole {
  if (typeof raw !== "string") return "self";
  const v = raw.trim().toLowerCase();
  if (isRole(v)) return v;
  // Treat unknown strings as custom labels via caller.
  return "custom";
}

function parseDispatchStatus(raw: unknown): DispatchStatus {
  if (typeof raw === "string" && (DISPATCH_STATUSES as readonly string[]).includes(raw)) {
    return raw as DispatchStatus;
  }
  return "unassigned";
}

/** Normalize legacy rows missing assignee fields. */
export function normalizeItem(raw: unknown, now = Date.now()): TodoItem | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id.trim() : "";
  const content =
    typeof row.content === "string" ? clampText(row.content, TEXT_MAX) : "";
  if (!id || !content) return null;
  const status =
    typeof row.status === "string" && STATUSES.includes(row.status as TodoStatus)
      ? (row.status as TodoStatus)
      : "pending";
  const priority =
    typeof row.priority === "string" &&
    PRIORITIES.includes(row.priority as TodoPriority)
      ? (row.priority as TodoPriority)
      : "medium";
  const roleRaw = row.assigneeRole ?? row.assignee;
  let assigneeRole = parseRole(roleRaw);
  let assigneeLabel =
    typeof row.assigneeLabel === "string"
      ? clampText(row.assigneeLabel, TEXT_MAX) || null
      : null;
  if (
    typeof roleRaw === "string" &&
    !isRole(roleRaw.trim().toLowerCase()) &&
    roleRaw.trim()
  ) {
    assigneeRole = "custom";
    assigneeLabel = assigneeLabel ?? clampText(roleRaw, TEXT_MAX);
  }
  const assigneeThreadId =
    typeof row.assigneeThreadId === "string" && row.assigneeThreadId.startsWith("thr_")
      ? row.assigneeThreadId
      : null;
  let dispatchStatus = parseDispatchStatus(row.dispatchStatus);
  if (assigneeThreadId && dispatchStatus === "unassigned") {
    dispatchStatus = "running";
  } else if (assigneeRole !== "self" && dispatchStatus === "unassigned") {
    dispatchStatus = "assigned";
  }
  return {
    id,
    content,
    activeForm:
      typeof row.activeForm === "string"
        ? clampText(row.activeForm, TEXT_MAX) || null
        : null,
    status,
    priority,
    parentId: typeof row.parentId === "string" ? row.parentId : null,
    dependsOn: Array.isArray(row.dependsOn)
      ? uniqueIds(row.dependsOn.filter((x): x is string => typeof x === "string"))
      : [],
    requires: Array.isArray(row.requires)
      ? uniqueIds(row.requires.filter((x): x is string => typeof x === "string"))
      : [],
    notes:
      typeof row.notes === "string"
        ? clampText(row.notes, NOTES_MAX) || null
        : null,
    assigneeRole,
    assigneeLabel,
    assigneeThreadId,
    dispatchStatus,
    lastReport:
      typeof row.lastReport === "string"
        ? clampText(row.lastReport, REPORT_MAX) || null
        : null,
    sortOrder: typeof row.sortOrder === "number" ? row.sortOrder : 0,
    createdAt: typeof row.createdAt === "number" ? row.createdAt : now,
    updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : now,
  };
}

export function normalizeItems(raw: unknown[], now = Date.now()): TodoItem[] {
  const out: TodoItem[] = [];
  for (const row of raw) {
    const item = normalizeItem(row, now);
    if (item) out.push(item);
  }
  return out;
}

export interface TodoSnapshot {
  threadId: string;
  updatedAt: number;
  items: TodoItem[];
}

export interface TodoCounts {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  cancelled: number;
  blocked: number;
  ready: number;
}

export interface DerivedTodo extends TodoItem {
  depth: number;
  /** True when incomplete dependsOn still block this item. */
  waitingOn: string[];
  /** Effective status after dependency blocking is applied for display. */
  effectiveStatus: TodoStatus;
  children: DerivedTodo[];
}

function clampText(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max);
}

function uniqueIds(ids: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_DEPS) break;
  }
  return out;
}

function slugify(content: string): string {
  const base = content
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
  return base.length > 0 ? base : "task";
}

export function allocateId(
  content: string,
  used: Set<string>,
  preferred?: string,
  parentId?: string | null,
): string {
  let base =
    preferred && preferred.trim().length > 0
      ? preferred.trim().replace(/\s+/g, "-").slice(0, 48)
      : slugify(content);
  if (parentId && !preferred) {
    base = `${parentId}.${slugify(content)}`.slice(0, 48);
  }
  if (!base) base = "task";
  let id = base;
  let n = 2;
  while (used.has(id)) {
    id = `${base}-${n++}`;
  }
  used.add(id);
  return id;
}

export function emptySnapshot(threadId: string, now = Date.now()): TodoSnapshot {
  return { threadId, updatedAt: now, items: [] };
}

export function indexById(items: readonly TodoItem[]): Map<string, TodoItem> {
  return new Map(items.map((item) => [item.id, item]));
}

export function childrenOf(
  items: readonly TodoItem[],
  parentId: string | null,
): TodoItem[] {
  return items
    .filter((item) => item.parentId === parentId)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt);
}

export function collectDescendantIds(
  items: readonly TodoItem[],
  rootId: string,
): Set<string> {
  const byParent = new Map<string | null, TodoItem[]>();
  for (const item of items) {
    const list = byParent.get(item.parentId) ?? [];
    list.push(item);
    byParent.set(item.parentId, list);
  }
  const out = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    for (const child of byParent.get(id) ?? []) {
      stack.push(child.id);
    }
  }
  return out;
}

function isTerminal(status: TodoStatus): boolean {
  return status === "completed" || status === "cancelled";
}

export function waitingOnDeps(
  item: TodoItem,
  byId: Map<string, TodoItem>,
): string[] {
  const waiting: string[] = [];
  for (const depId of item.dependsOn) {
    const dep = byId.get(depId);
    if (!dep) {
      waiting.push(depId);
      continue;
    }
    if (!isTerminal(dep.status) || dep.status === "cancelled") {
      // cancelled deps still block unless completed
      if (dep.status !== "completed") waiting.push(depId);
    }
  }
  return waiting;
}

export function effectiveStatus(
  item: TodoItem,
  waitingOn: string[],
): TodoStatus {
  if (item.status === "completed" || item.status === "cancelled") {
    return item.status;
  }
  if (item.status === "blocked") return "blocked";
  if (waitingOn.length > 0 && item.status !== "in_progress") {
    return "blocked";
  }
  return item.status;
}

export function deriveTree(items: readonly TodoItem[]): DerivedTodo[] {
  const byId = indexById(items);

  function build(parentId: string | null, depth: number): DerivedTodo[] {
    if (depth > MAX_DEPTH) return [];
    return childrenOf(items, parentId).map((item) => {
      const waiting = waitingOnDeps(item, byId);
      return {
        ...item,
        depth,
        waitingOn: waiting,
        effectiveStatus: effectiveStatus(item, waiting),
        children: build(item.id, depth + 1),
      };
    });
  }

  return build(null, 0);
}

export function flattenDerived(nodes: readonly DerivedTodo[]): DerivedTodo[] {
  const out: DerivedTodo[] = [];
  const walk = (list: readonly DerivedTodo[]) => {
    for (const node of list) {
      out.push(node);
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

export function countTodos(items: readonly TodoItem[]): TodoCounts {
  const derived = flattenDerived(deriveTree(items));
  const counts: TodoCounts = {
    total: derived.length,
    pending: 0,
    inProgress: 0,
    completed: 0,
    cancelled: 0,
    blocked: 0,
    ready: 0,
  };
  for (const item of derived) {
    switch (item.effectiveStatus) {
      case "pending":
        counts.pending += 1;
        counts.ready += 1;
        break;
      case "in_progress":
        counts.inProgress += 1;
        break;
      case "completed":
        counts.completed += 1;
        break;
      case "cancelled":
        counts.cancelled += 1;
        break;
      case "blocked":
        counts.blocked += 1;
        break;
    }
  }
  return counts;
}

export function findReady(items: readonly TodoItem[]): DerivedTodo[] {
  return flattenDerived(deriveTree(items)).filter(
    (item) =>
      item.effectiveStatus === "pending" ||
      (item.effectiveStatus === "in_progress" && item.waitingOn.length === 0),
  );
}

export function validateAcyclic(
  items: readonly TodoItem[],
): { ok: true } | { ok: false; cycle: string[] } {
  const byId = indexById(items);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  function dfs(id: string): string[] | null {
    if (visited.has(id)) return null;
    if (visiting.has(id)) {
      const idx = stack.indexOf(id);
      return [...stack.slice(idx), id];
    }
    visiting.add(id);
    stack.push(id);
    const item = byId.get(id);
    if (item) {
      for (const dep of item.dependsOn) {
        if (!byId.has(dep)) continue;
        const cycle = dfs(dep);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  }

  for (const item of items) {
    const cycle = dfs(item.id);
    if (cycle) return { ok: false, cycle };
  }
  return { ok: true };
}

function mergeDepLists(
  dependsOn?: string[],
  blockedBy?: string[],
): string[] {
  return uniqueIds([...(dependsOn ?? []), ...(blockedBy ?? [])]);
}

export function nestedToFlat(
  inputs: readonly NestedTodoInput[],
  now: number,
  existing?: readonly TodoItem[],
): { items: TodoItem[]; errors: string[] } {
  const errors: string[] = [];
  // Seed with existing ids so add/subtree inserts never collide.
  // Full replace passes no existing and starts empty.
  const allocated = new Set<string>(existing?.map((i) => i.id) ?? []);
  const items: TodoItem[] = [];

  function walk(
    nodes: readonly NestedTodoInput[],
    parentId: string | null,
    depth: number,
  ) {
    if (depth > MAX_DEPTH) {
      errors.push(`Exceeded max nesting depth (${MAX_DEPTH}).`);
      return;
    }
    let order = 0;
    for (const node of nodes) {
      if (items.length >= MAX_ITEMS) {
        errors.push(`Exceeded max items (${MAX_ITEMS}).`);
        return;
      }
      const content = clampText(node.content ?? "", TEXT_MAX);
      if (!content) {
        errors.push("Skipped item with empty content.");
        continue;
      }
      const preferred = node.id?.trim();
      if (preferred && allocated.has(preferred)) {
        // On full replace, preferred ids must be unique within the new tree.
        // On add, collision with an existing id is also rejected.
        errors.push(`Duplicate id "${preferred}".`);
        continue;
      }
      const id = allocateId(
        content,
        allocated,
        preferred || undefined,
        parentId,
      );
      const status = node.status && STATUSES.includes(node.status)
        ? node.status
        : "pending";
      const priority =
        node.priority && PRIORITIES.includes(node.priority)
          ? node.priority
          : "medium";
      const activeForm = node.activeForm
        ? clampText(node.activeForm, TEXT_MAX)
        : null;
      const notes = node.notes ? clampText(node.notes, NOTES_MAX) : null;
      const roleRaw = node.assigneeRole ?? node.assignee;
      let assigneeRole = parseRole(roleRaw);
      let assigneeLabel = node.assigneeLabel
        ? clampText(node.assigneeLabel, TEXT_MAX) || null
        : null;
      if (
        typeof roleRaw === "string" &&
        !isRole(roleRaw.trim().toLowerCase()) &&
        roleRaw.trim()
      ) {
        assigneeRole = "custom";
        assigneeLabel = assigneeLabel ?? clampText(roleRaw, TEXT_MAX);
      }
      items.push({
        id,
        content,
        activeForm: activeForm && activeForm.length > 0 ? activeForm : null,
        status,
        priority,
        parentId,
        dependsOn: mergeDepLists(node.dependsOn, node.blockedBy),
        requires: uniqueIds(node.requires ?? []),
        notes: notes && notes.length > 0 ? notes : null,
        assigneeRole,
        assigneeLabel,
        assigneeThreadId: null,
        dispatchStatus: assigneeRole === "self" ? "unassigned" : "assigned",
        lastReport: null,
        sortOrder: order++,
        createdAt: now,
        updatedAt: now,
      });
      if (node.children && node.children.length > 0) {
        walk(node.children, id, depth + 1);
      }
    }
  }

  walk(inputs, null, 0);

  // Drop dependsOn pointing at unknown ids (warn).
  const ids = new Set(items.map((i) => i.id));
  for (const item of items) {
    const missing = item.dependsOn.filter((d) => !ids.has(d));
    if (missing.length > 0) {
      errors.push(
        `Item "${item.id}" dependsOn unknown id(s): ${missing.join(", ")}.`,
      );
      item.dependsOn = item.dependsOn.filter((d) => ids.has(d));
    }
    if (item.dependsOn.includes(item.id)) {
      errors.push(`Item "${item.id}" cannot depend on itself.`);
      item.dependsOn = item.dependsOn.filter((d) => d !== item.id);
    }
  }

  const cycle = validateAcyclic(items);
  if (!cycle.ok) {
    errors.push(`Dependency cycle: ${cycle.cycle.join(" → ")}`);
  }

  return { items, errors };
}

export function patchItem(
  item: TodoItem,
  patch: {
    content?: string;
    activeForm?: string | null;
    status?: TodoStatus;
    priority?: TodoPriority;
    parentId?: string | null;
    dependsOn?: string[];
    addDependsOn?: string[];
    removeDependsOn?: string[];
    requires?: string[];
    addRequires?: string[];
    removeRequires?: string[];
    notes?: string | null;
    assigneeRole?: TodoRole;
    assigneeLabel?: string | null;
    assigneeThreadId?: string | null;
    dispatchStatus?: DispatchStatus;
    lastReport?: string | null;
    sortOrder?: number;
  },
  now: number,
): TodoItem {
  let dependsOn = item.dependsOn;
  if (patch.dependsOn) {
    dependsOn = uniqueIds(patch.dependsOn);
  } else {
    if (patch.addDependsOn?.length) {
      dependsOn = uniqueIds([...dependsOn, ...patch.addDependsOn]);
    }
    if (patch.removeDependsOn?.length) {
      const remove = new Set(patch.removeDependsOn);
      dependsOn = dependsOn.filter((d) => !remove.has(d));
    }
  }

  let requires = item.requires;
  if (patch.requires) {
    requires = uniqueIds(patch.requires);
  } else {
    if (patch.addRequires?.length) {
      requires = uniqueIds([...requires, ...patch.addRequires]);
    }
    if (patch.removeRequires?.length) {
      const remove = new Set(patch.removeRequires);
      requires = requires.filter((r) => !remove.has(r));
    }
  }

  const assigneeRole = patch.assigneeRole ?? item.assigneeRole;
  let assigneeLabel =
    patch.assigneeLabel === undefined
      ? item.assigneeLabel
      : patch.assigneeLabel === null
        ? null
        : clampText(patch.assigneeLabel, TEXT_MAX) || null;
  let dispatchStatus = patch.dispatchStatus ?? item.dispatchStatus;
  const assigneeThreadId =
    patch.assigneeThreadId !== undefined
      ? patch.assigneeThreadId
      : item.assigneeThreadId;

  if (patch.assigneeRole !== undefined && patch.dispatchStatus === undefined) {
    if (assigneeRole === "self" && !assigneeThreadId) {
      dispatchStatus = "unassigned";
    } else if (!assigneeThreadId) {
      dispatchStatus = "assigned";
    }
  }

  return {
    ...item,
    content:
      patch.content !== undefined
        ? clampText(patch.content, TEXT_MAX) || item.content
        : item.content,
    activeForm:
      patch.activeForm === undefined
        ? item.activeForm
        : patch.activeForm === null
          ? null
          : clampText(patch.activeForm, TEXT_MAX) || null,
    status: patch.status ?? item.status,
    priority: patch.priority ?? item.priority,
    parentId: patch.parentId !== undefined ? patch.parentId : item.parentId,
    dependsOn,
    requires,
    notes:
      patch.notes === undefined
        ? item.notes
        : patch.notes === null
          ? null
          : clampText(patch.notes, NOTES_MAX) || null,
    assigneeRole,
    assigneeLabel,
    assigneeThreadId,
    dispatchStatus,
    lastReport:
      patch.lastReport === undefined
        ? item.lastReport
        : patch.lastReport === null
          ? null
          : clampText(patch.lastReport, REPORT_MAX) || null,
    sortOrder: patch.sortOrder ?? item.sortOrder,
    updatedAt: now,
  };
}

export function displayText(
  item: {
    content: string;
    activeForm: string | null;
    status: TodoStatus;
  },
  effective?: TodoStatus,
): string {
  const status = effective ?? item.status;
  if (status === "in_progress" && item.activeForm) return item.activeForm;
  return item.content;
}

export function reorderSiblings(
  items: TodoItem[],
  parentId: string | null,
  orderedIds: string[],
  now: number,
): TodoItem[] {
  const siblingSet = new Set(
    items.filter((i) => i.parentId === parentId).map((i) => i.id),
  );
  const orderMap = new Map<string, number>();
  let order = 0;
  for (const id of orderedIds) {
    if (!siblingSet.has(id) || orderMap.has(id)) continue;
    orderMap.set(id, order++);
  }
  for (const id of siblingSet) {
    if (!orderMap.has(id)) orderMap.set(id, order++);
  }
  return items.map((item) => {
    if (item.parentId !== parentId) return item;
    const next = orderMap.get(item.id);
    if (next === undefined || next === item.sortOrder) return item;
    return { ...item, sortOrder: next, updatedAt: now };
  });
}

export function moveItem(
  items: TodoItem[],
  id: string,
  toParentId: string | null | undefined,
  afterId: string | null | undefined,
  now: number,
): { items: TodoItem[]; error?: string } {
  const byId = indexById(items);
  const item = byId.get(id);
  if (!item) return { items, error: `Unknown id "${id}".` };

  const parentId =
    toParentId === undefined ? item.parentId : toParentId;

  if (parentId === id) {
    return { items, error: "Cannot parent a todo under itself." };
  }
  if (parentId !== null) {
    if (!byId.has(parentId)) {
      return { items, error: `Unknown parentId "${parentId}".` };
    }
    const descendants = collectDescendantIds(items, id);
    if (descendants.has(parentId)) {
      return { items, error: "Cannot move a todo under its own descendant." };
    }
  }

  let next = items.map((row) =>
    row.id === id ? { ...row, parentId, updatedAt: now } : row,
  );

  const siblings = childrenOf(next, parentId).map((s) => s.id);
  const without = siblings.filter((s) => s !== id);
  let ordered: string[];
  if (afterId === null) {
    ordered = [id, ...without];
  } else if (afterId === undefined) {
    ordered = [...without, id];
  } else {
    const idx = without.indexOf(afterId);
    if (idx === -1) {
      ordered = [...without, id];
    } else {
      ordered = [
        ...without.slice(0, idx + 1),
        id,
        ...without.slice(idx + 1),
      ];
    }
  }
  next = reorderSiblings(next, parentId, ordered, now);
  return { items: next };
}
