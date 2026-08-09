import { defineRpcContract } from "@bb/plugin-sdk";
import { z } from "zod";
import { PRIORITIES, STATUSES } from "./constants.js";
import { DISPATCH_STATUSES, ROLES } from "./roles.js";

const statusSchema = z.enum(STATUSES);
const prioritySchema = z.enum(PRIORITIES);
const roleSchema = z.enum(ROLES);
const dispatchStatusSchema = z.enum(DISPATCH_STATUSES);

export const uiTodoNodeSchema: z.ZodType<UiTodoNodeDto> = z.lazy(() =>
  z.object({
    id: z.string(),
    content: z.string(),
    activeForm: z.string().nullable(),
    status: statusSchema,
    effectiveStatus: statusSchema,
    priority: prioritySchema,
    parentId: z.string().nullable(),
    dependsOn: z.array(z.string()),
    requires: z.array(z.string()),
    notes: z.string().nullable(),
    assigneeRole: roleSchema,
    assigneeLabel: z.string().nullable(),
    assigneeThreadId: z.string().nullable(),
    dispatchStatus: dispatchStatusSchema,
    lastReport: z.string().nullable(),
    depth: z.number().int().nonnegative(),
    waitingOn: z.array(z.string()),
    displayText: z.string(),
    children: z.array(uiTodoNodeSchema),
  }),
);

export interface UiTodoNodeDto {
  id: string;
  content: string;
  activeForm: string | null;
  status: z.infer<typeof statusSchema>;
  effectiveStatus: z.infer<typeof statusSchema>;
  priority: z.infer<typeof prioritySchema>;
  parentId: string | null;
  dependsOn: string[];
  requires: string[];
  notes: string | null;
  assigneeRole: z.infer<typeof roleSchema>;
  assigneeLabel: string | null;
  assigneeThreadId: string | null;
  dispatchStatus: z.infer<typeof dispatchStatusSchema>;
  lastReport: string | null;
  depth: number;
  waitingOn: string[];
  displayText: string;
  children: UiTodoNodeDto[];
}

export const uiTodoSnapshotSchema = z.object({
  threadId: z.string(),
  updatedAt: z.number(),
  counts: z.object({
    total: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    inProgress: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    ready: z.number().int().nonnegative(),
  }),
  items: z.array(z.unknown()),
  tree: z.array(uiTodoNodeSchema),
});

export const openTodoSummarySchema = z.object({
  threadId: z.string(),
  total: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  open: z.number().int().nonnegative(),
  inProgress: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  ready: z.number().int().nonnegative(),
  runningAgents: z.number().int().nonnegative(),
});

export const rpcContract = defineRpcContract({
  getTodos: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({
      snapshot: uiTodoSnapshotSchema.nullable(),
    }),
  },
  /** Compact per-thread open-todo summaries for sidebar glyphs. */
  listOpenSummaries: {
    input: z.null(),
    output: z.object({
      summaries: z.array(openTodoSummarySchema),
    }),
  },
});
