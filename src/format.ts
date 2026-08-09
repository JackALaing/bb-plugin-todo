import {
  countTodos,
  deriveTree,
  displayText,
  findReady,
  flattenDerived,
  type DerivedTodo,
  type TodoItem,
  type TodoSnapshot,
} from "./model.js";

const STATUS_GLYPH: Record<string, string> = {
  pending: "[ ]",
  in_progress: "[~]",
  completed: "[x]",
  cancelled: "[-]",
  blocked: "[!]",
};

function indent(depth: number): string {
  return "  ".repeat(depth);
}

function formatNode(node: DerivedTodo): string[] {
  const glyph = STATUS_GLYPH[node.effectiveStatus] ?? "[ ]";
  const label = displayText(node, node.effectiveStatus);
  const bits: string[] = [];
  if (node.priority === "high") bits.push("P0");
  if (node.priority === "low") bits.push("P2");
  if (node.requires.length > 0) {
    bits.push(`requires: ${node.requires.join(", ")}`);
  }
  if (node.assigneeRole && node.assigneeRole !== "self") {
    const who =
      node.assigneeLabel?.trim() ||
      node.assigneeRole +
        (node.assigneeThreadId ? `→${node.assigneeThreadId}` : "") +
        (node.dispatchStatus && node.dispatchStatus !== "unassigned"
          ? `/${node.dispatchStatus}`
          : "");
    bits.push(`@${who}`);
  } else if (node.assigneeThreadId) {
    bits.push(`thread:${node.assigneeThreadId}`);
  }
  if (node.waitingOn.length > 0) {
    bits.push(`blocked by: ${node.waitingOn.join(", ")}`);
  } else if (node.dependsOn.length > 0 && node.effectiveStatus !== "completed") {
    bits.push(`dependsOn: ${node.dependsOn.join(", ")}`);
  }
  if (node.notes) bits.push(`note: ${node.notes}`);
  const suffix = bits.length > 0 ? `  (${bits.join(" · ")})` : "";
  const lines = [
    `${indent(node.depth)}- ${glyph} **${node.id}** ${label}${suffix}`,
  ];
  for (const child of node.children) {
    lines.push(...formatNode(child));
  }
  return lines;
}

export function formatSnapshotMarkdown(
  snapshot: TodoSnapshot,
  options?: {
    changes?: string[];
    warnings?: string[];
    errors?: string[];
    note?: string;
  },
): string {
  const counts = countTodos(snapshot.items);
  const tree = deriveTree(snapshot.items);
  const lines: string[] = [];

  lines.push(
    `## Todos (${counts.completed}/${counts.total} complete · ${counts.inProgress} in progress · ${counts.blocked} blocked · ${counts.ready} ready)`,
  );

  if (options?.note) {
    lines.push("", `_${options.note}_`);
  }

  if (options?.errors?.length) {
    lines.push("", "### Errors");
    for (const err of options.errors) lines.push(`- ${err}`);
  }

  if (options?.warnings?.length) {
    lines.push("", "### Warnings");
    for (const warn of options.warnings) lines.push(`- ${warn}`);
  }

  if (options?.changes?.length) {
    lines.push("", "### Changes");
    for (const change of options.changes) lines.push(`- ${change}`);
  }

  if (snapshot.items.length === 0) {
    lines.push("", "_No todos._");
    return lines.join("\n");
  }

  lines.push("");
  for (const node of tree) {
    lines.push(...formatNode(node));
  }

  const ready = findReady(snapshot.items).filter(
    (item) => item.effectiveStatus === "pending",
  );
  if (ready.length > 0) {
    lines.push("", "### Ready next");
    for (const item of ready.slice(0, 8)) {
      const deps =
        item.dependsOn.length > 0
          ? ` (after ${item.dependsOn.join(", ")})`
          : "";
      lines.push(`- **${item.id}** ${item.content}${deps}`);
    }
    if (ready.length > 8) {
      lines.push(`- …and ${ready.length - 8} more`);
    }
  }

  const inProgress = flattenDerived(tree).filter(
    (item) => item.effectiveStatus === "in_progress",
  );
  if (inProgress.length > 1) {
    lines.push(
      "",
      `### Note`,
      `- ${inProgress.length} items are in_progress; prefer exactly one at a time.`,
    );
  }

  return lines.join("\n");
}

export function snapshotForUi(snapshot: TodoSnapshot) {
  const counts = countTodos(snapshot.items);
  const tree = deriveTree(snapshot.items);
  return {
    threadId: snapshot.threadId,
    updatedAt: snapshot.updatedAt,
    counts,
    items: snapshot.items,
    tree: tree.map(serializeDerived),
  };
}

function serializeDerived(node: DerivedTodo): UiTodoNode {
  return {
    id: node.id,
    content: node.content,
    activeForm: node.activeForm,
    status: node.status,
    effectiveStatus: node.effectiveStatus,
    priority: node.priority,
    parentId: node.parentId,
    dependsOn: node.dependsOn,
    requires: node.requires,
    notes: node.notes,
    assigneeRole: node.assigneeRole,
    assigneeLabel: node.assigneeLabel,
    assigneeThreadId: node.assigneeThreadId,
    dispatchStatus: node.dispatchStatus,
    lastReport: node.lastReport,
    depth: node.depth,
    waitingOn: node.waitingOn,
    displayText: displayText(node, node.effectiveStatus),
    children: node.children.map(serializeDerived),
  };
}

export interface UiTodoNode {
  id: string;
  content: string;
  activeForm: string | null;
  status: TodoItem["status"];
  effectiveStatus: TodoItem["status"];
  priority: TodoItem["priority"];
  parentId: string | null;
  dependsOn: string[];
  requires: string[];
  notes: string | null;
  assigneeRole: TodoItem["assigneeRole"];
  assigneeLabel: string | null;
  assigneeThreadId: string | null;
  dispatchStatus: TodoItem["dispatchStatus"];
  lastReport: string | null;
  depth: number;
  waitingOn: string[];
  displayText: string;
  children: UiTodoNode[];
}

export function openTodoSummary(snapshot: TodoSnapshot): {
  threadId: string;
  total: number;
  completed: number;
  open: number;
  inProgress: number;
  blocked: number;
  ready: number;
  runningAgents: number;
} | null {
  const counts = countTodos(snapshot.items);
  const open = counts.pending + counts.inProgress + counts.blocked;
  if (counts.total === 0 || open === 0) return null;
  const runningAgents = snapshot.items.filter(
    (i) => i.dispatchStatus === "running" && i.assigneeThreadId,
  ).length;
  return {
    threadId: snapshot.threadId,
    total: counts.total,
    completed: counts.completed,
    open,
    inProgress: counts.inProgress,
    blocked: counts.blocked,
    ready: counts.ready,
    runningAgents,
  };
}

export type UiTodoSnapshot = ReturnType<typeof snapshotForUi>;
