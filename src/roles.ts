export const ROLES = [
  "self",
  "scout",
  "worker",
  "reviewer",
  "custom",
] as const;

export type TodoRole = (typeof ROLES)[number];

export const DISPATCH_STATUSES = [
  "unassigned",
  "assigned",
  "running",
  "idle",
  "failed",
  "released",
] as const;

export type DispatchStatus = (typeof DISPATCH_STATUSES)[number];

export interface RolePreset {
  id: TodoRole;
  label: string;
  /** Short system-style brief injected into the child prompt. */
  brief: string;
  /** Default title prefix when spawning. */
  titlePrefix: string;
}

export const ROLE_PRESETS: Record<Exclude<TodoRole, "custom">, RolePreset> = {
  self: {
    id: "self",
    label: "Orchestrator",
    brief: "Work on this item yourself in the parent thread; do not spawn a child.",
    titlePrefix: "self",
  },
  scout: {
    id: "scout",
    label: "Scout",
    brief:
      "You are a scout agent. Explore the codebase quickly, gather facts, and return a compressed briefing. Prefer read/search tools. Do not make large refactors unless the todo explicitly requires it. End with a structured summary the parent can act on.",
    titlePrefix: "scout",
  },
  worker: {
    id: "worker",
    label: "Worker",
    brief:
      "You are a worker agent with full implementation capability. Complete the assigned todo end-to-end in this child thread. Prefer small, verified changes. When finished, call the todo tool with action \"report\" and status completed (or blocked with notes).",
    titlePrefix: "worker",
  },
  reviewer: {
    id: "reviewer",
    label: "Reviewer",
    brief:
      "You are a reviewer agent. Inspect the relevant diffs/files, list findings by severity, and recommend accept / request-changes. Do not implement fixes unless the todo explicitly asks. Call todo report when done.",
    titlePrefix: "reviewer",
  },
};

export function isRole(value: string): value is TodoRole {
  return (ROLES as readonly string[]).includes(value);
}

export function roleLabel(role: TodoRole | null | undefined, custom?: string | null): string {
  if (!role || role === "self") return custom?.trim() || "self";
  if (role === "custom") return custom?.trim() || "custom";
  return ROLE_PRESETS[role].label;
}

export function roleBrief(role: TodoRole | null | undefined, custom?: string | null): string {
  if (!role || role === "self") return ROLE_PRESETS.self.brief;
  if (role === "custom") {
    return (
      custom?.trim() ||
      "You are a specialized agent. Complete the assigned todo and report back via the todo tool."
    );
  }
  return ROLE_PRESETS[role].brief;
}
