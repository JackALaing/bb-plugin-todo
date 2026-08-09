import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  definePluginApp,
  useBbNavigate,
  useComposerView,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@bb/plugin-sdk/app";
import type { rpcContract, UiTodoNodeDto } from "./src/rpc";
import { REALTIME_CHANNEL } from "./src/constants";
import "./app.css";

const PLUGIN_ID = "todo";

interface UiCounts {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  cancelled: number;
  blocked: number;
  ready: number;
}

interface UiSnapshot {
  threadId: string;
  updatedAt: number;
  counts: UiCounts;
  tree: UiTodoNodeDto[];
}

function payloadThreadId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const threadId = (payload as { threadId?: unknown }).threadId;
  return typeof threadId === "string" ? threadId : null;
}

function glyph(status: string): string {
  switch (status) {
    case "completed":
      return "✓";
    case "in_progress":
      return "●";
    case "cancelled":
      return "–";
    case "blocked":
      return "!";
    default:
      return "○";
  }
}

function flattenTree(nodes: UiTodoNodeDto[]): UiTodoNodeDto[] {
  const out: UiTodoNodeDto[] = [];
  const walk = (list: UiTodoNodeDto[]) => {
    for (const node of list) {
      out.push(node);
      if (node.children.length > 0) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className="todo-banner-chevron"
      data-open={open ? "true" : "false"}
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <path
        d="M4.5 6.25 8 9.75l3.5-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ExpandHeightIcon({ full }: { full: boolean }) {
  // full=true shows "compress"; false shows "expand to tall".
  return full ? (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M5 3.5H3.5V5M11 3.5h1.5V5M5 12.5H3.5V11M11 12.5h1.5V11M5.5 5.5h5v5h-5z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ) : (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M3.5 6.5V3.5H6.5M12.5 6.5V3.5H9.5M3.5 9.5v3H6.5M12.5 9.5v3H9.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

type HeightMode = "compact" | "full";

const HEIGHT_STORAGE_KEY = "bb-plugin-todo:height-mode";

function readStoredHeightMode(): HeightMode {
  try {
    const value = sessionStorage.getItem(HEIGHT_STORAGE_KEY);
    return value === "full" ? "full" : "compact";
  } catch {
    return "compact";
  }
}

function writeStoredHeightMode(mode: HeightMode) {
  try {
    sessionStorage.setItem(HEIGHT_STORAGE_KEY, mode);
  } catch {
    // ignore quota / private mode
  }
}

function TodoRows({
  nodes,
  listRef,
}: {
  nodes: UiTodoNodeDto[];
  listRef?: RefObject<HTMLUListElement | null>;
}) {
  const navigate = useBbNavigate();
  const flat = flattenTree(nodes);
  return (
    <ul className="todo-list" role="list" ref={listRef}>
      {flat.map((node) => {
        const metaBits: string[] = [];
        if (node.assigneeRole && node.assigneeRole !== "self") {
          metaBits.push(
            `@${node.assigneeLabel?.trim() || node.assigneeRole}${node.dispatchStatus && node.dispatchStatus !== "unassigned" ? ` · ${node.dispatchStatus}` : ""}`,
          );
        }
        if (node.waitingOn.length > 0) {
          metaBits.push(`blocked by ${node.waitingOn.join(", ")}`);
        } else if (
          node.dependsOn.length > 0 &&
          node.effectiveStatus !== "completed"
        ) {
          metaBits.push(`after ${node.dependsOn.join(", ")}`);
        }
        if (node.requires.length > 0) {
          metaBits.push(`requires ${node.requires.join(", ")}`);
        }
        if (node.priority === "high") metaBits.push("high priority");
        return (
          <li
            key={node.id}
            className="todo-row"
            data-status={node.effectiveStatus}
            style={{ paddingLeft: `${0.25 + node.depth * 0.85}rem` }}
          >
            <span className="todo-glyph" aria-hidden="true">
              {glyph(node.effectiveStatus)}
            </span>
            <span className="todo-main">
              <span className="todo-text">
                <span className="todo-id">{node.id}</span>{" "}
                {node.displayText}
              </span>
              {metaBits.length > 0 ? (
                <span className="todo-meta">{metaBits.join(" · ")}</span>
              ) : null}
            </span>
            {node.assigneeThreadId ? (
              <button
                type="button"
                className="todo-child-link"
                title={`Open child ${node.assigneeThreadId}`}
                aria-label={`Open assigned agent thread for ${node.id}`}
                onClick={(event) => {
                  event.stopPropagation();
                  navigate.toThread(node.assigneeThreadId!);
                }}
              >
                agent
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function TodoBannerForThread({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const previousConnection = useRef(connection);
  const [snapshot, setSnapshot] = useState<UiSnapshot | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [heightMode, setHeightMode] = useState<HeightMode>(() =>
    readStoredHeightMode(),
  );
  const listRef = useRef<HTMLUListElement | null>(null);
  const itemCount = snapshot ? flattenTree(snapshot.tree).length : 0;
  const tallUseful = itemCount >= 6;

  const load = useCallback(async () => {
    try {
      const result = await rpc.call("getTodos", { threadId });
      setSnapshot(result.snapshot as UiSnapshot | null);
    } catch {
      // Keep last good snapshot on transient RPC errors.
    }
  }, [rpc, threadId]);

  useEffect(() => {
    void load();
  }, [load]);

  useRealtime(
    REALTIME_CHANNEL,
    useCallback(
      (payload) => {
        if (payloadThreadId(payload) === threadId) {
          void load();
        }
      },
      [load, threadId],
    ),
  );

  useEffect(() => {
    const reconnected =
      connection === "connected" && previousConnection.current !== "connected";
    previousConnection.current = connection;
    if (reconnected) void load();
  }, [connection, load]);

  useEffect(() => {
    writeStoredHeightMode(heightMode);
  }, [heightMode]);

  const full = heightMode === "full";

  // When entering full height, keep the in-progress row in view if possible.
  useEffect(() => {
    if (heightMode !== "full" || !expanded || !listRef.current) return;
    const active = listRef.current.querySelector(
      '[data-status="in_progress"]',
    );
    if (active instanceof HTMLElement) {
      active.scrollIntoView({ block: "nearest" });
    }
  }, [heightMode, expanded, snapshot?.updatedAt]);

  // Escape exits full-height overlay. Must stay above any conditional return
  // so hook order is stable across loading → ready → empty transitions.
  useEffect(() => {
    if (!full) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setHeightMode("compact");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full]);

  const preview = useMemo(() => {
    if (!snapshot) return "";
    const flat = flattenTree(snapshot.tree);
    const active =
      flat.find((n) => n.effectiveStatus === "in_progress") ??
      flat.find((n) => n.effectiveStatus === "pending") ??
      flat.find((n) => n.effectiveStatus === "blocked") ??
      flat[0];
    return active?.displayText ?? "";
  }, [snapshot]);

  const openWork = snapshot
    ? snapshot.counts.pending +
      snapshot.counts.inProgress +
      snapshot.counts.blocked
    : 0;

  if (!snapshot || snapshot.counts.total === 0) return null;
  // Keep the card visible while any incomplete work remains (including blocked).
  if (openWork === 0) return null;

  const summary = `${snapshot.counts.completed}/${snapshot.counts.total} complete`;
  const extras: string[] = [];
  if (snapshot.counts.inProgress > 0) {
    extras.push(`${snapshot.counts.inProgress} active`);
  }
  if (snapshot.counts.blocked > 0) {
    extras.push(`${snapshot.counts.blocked} blocked`);
  }

  function toggleExpanded() {
    setExpanded((v) => {
      const next = !v;
      // Collapsing exits full-height so the overlay does not linger.
      if (!next && heightMode === "full") setHeightMode("compact");
      return next;
    });
  }

  function toggleHeight() {
    setHeightMode((mode) => (mode === "full" ? "compact" : "full"));
    setExpanded(true);
  }

  function renderHeader(opts: { fullMode: boolean; showPreview: boolean }) {
    return (
      <div className="todo-banner-header-row">
        <button
          type="button"
          className="todo-banner-header"
          aria-expanded={expanded || opts.fullMode}
          onClick={toggleExpanded}
        >
          <span className="todo-banner-meta">{summary}</span>
          {extras.length > 0 ? (
            <span className="todo-banner-meta">· {extras.join(" · ")}</span>
          ) : null}
          {opts.showPreview && preview ? (
            <span className="todo-banner-preview">{preview}</span>
          ) : (
            <span className="todo-banner-title">
              Todos{opts.fullMode ? " · full height" : ""}
            </span>
          )}
        </button>
        <div className="todo-banner-actions">
          <button
            type="button"
            className="todo-banner-icon-btn"
            data-active={full ? "true" : "false"}
            title={full ? "Compact height" : "Expand to full height"}
            aria-label={full ? "Compact height" : "Expand to full height"}
            aria-pressed={full}
            onClick={toggleHeight}
          >
            <ExpandHeightIcon full={full} />
          </button>
          <button
            type="button"
            className="todo-banner-icon-btn"
            title={expanded || full ? "Collapse" : "Expand"}
            aria-label={
              expanded || full ? "Collapse todo list" : "Expand todo list"
            }
            aria-expanded={expanded || full}
            onClick={toggleExpanded}
          >
            <Chevron open={expanded || full} />
          </button>
        </div>
      </div>
    );
  }

  function renderListBody(withRef: boolean) {
    return (
      <div className="todo-banner-body-inner">
        <TodoRows
          nodes={snapshot.tree}
          listRef={withRef ? listRef : undefined}
        />
        <div className="todo-list-footer">
          <span className="todo-list-footer-hint">
            {itemCount} item{itemCount === 1 ? "" : "s"}
            {tallUseful ? " · scroll for more" : ""}
          </span>
          <button
            type="button"
            className="todo-list-footer-btn"
            onClick={toggleHeight}
          >
            {full ? "Compact" : "Full height"}
          </button>
        </div>
      </div>
    );
  }

  // Full height: portal a viewport-filling panel so the list is not clipped by
  // the composer stack. Compact mode stays an inline banner pill.
  const fullPanel =
    full && typeof document !== "undefined"
      ? createPortal(
          <div className="todo-full-root" role="presentation">
            <button
              type="button"
              className="todo-full-backdrop"
              aria-label="Close full-height todos"
              onClick={() => setHeightMode("compact")}
            />
            <section
              className="todo-banner todo-full-panel"
              aria-label="To-do list full height"
              data-open="true"
              data-height="full"
            >
              {renderHeader({ fullMode: true, showPreview: false })}
              <div className="todo-banner-body" data-open="true">
                {renderListBody(true)}
              </div>
            </section>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <section
        className="todo-banner"
        aria-label="To-do list"
        data-open={expanded && !full ? "true" : "false"}
        data-height="compact"
        data-full-active={full ? "true" : "false"}
      >
        {renderHeader({
          fullMode: false,
          showPreview: !expanded && !full,
        })}
        {!full ? (
          <div
            className="todo-banner-body"
            data-open={expanded ? "true" : "false"}
          >
            {renderListBody(true)}
          </div>
        ) : (
          <div className="todo-full-placeholder">
            Full-height list open — press Esc or Compact to return
          </div>
        )}
      </section>
      {fullPanel}
    </>
  );
}

function TodoBanner() {
  const composerView = useComposerView();
  if (composerView.scope.kind !== "thread") return null;
  return (
    <TodoBannerForThread
      key={composerView.scope.threadId}
      threadId={composerView.scope.threadId}
    />
  );
}

function HeaderBadge({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [label, setLabel] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await rpc.call("getTodos", { threadId });
      const snap = result.snapshot as UiSnapshot | null;
      if (!snap || snap.counts.total === 0) {
        setLabel(null);
        return;
      }
      const open =
        snap.counts.pending + snap.counts.inProgress + snap.counts.blocked;
      if (open === 0) {
        setLabel(null);
        return;
      }
      setLabel(`${snap.counts.completed}/${snap.counts.total}`);
    } catch {
      setLabel(null);
    }
  }, [rpc, threadId]);

  useEffect(() => {
    void load();
  }, [load]);

  useRealtime(
    REALTIME_CHANNEL,
    useCallback(
      (payload) => {
        if (payloadThreadId(payload) === threadId) void load();
      },
      [load, threadId],
    ),
  );

  if (!label) return null;
  return (
    <span
      title="Thread todos"
      style={{
        display: "inline-flex",
        alignItems: "center",
        height: 28,
        padding: "0 8px",
        borderRadius: 999,
        border: "1px solid color-mix(in oklab, var(--border) 85%, transparent)",
        fontSize: 11,
        fontVariantNumeric: "tabular-nums",
        color: "var(--muted-foreground)",
        whiteSpace: "nowrap",
      }}
    >
      ✓ {label}
    </span>
  );
}

function ThreadHeaderTodo({
  threadId,
}: {
  threadId: string;
  projectId: string | null;
  isCompactViewport: boolean;
}): ReactNode {
  return <HeaderBadge threadId={threadId} />;
}

async function callTodoRpc(method: string, input: unknown): Promise<unknown> {
  const response = await fetch(
    `/api/v1/plugins/${PLUGIN_ID}/rpc/${encodeURIComponent(method)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input ?? null),
    },
  );
  const body = (await response.json().catch(() => null)) as {
    ok?: unknown;
    result?: unknown;
    error?: { message?: unknown } | unknown;
  } | null;
  if (!response.ok || body?.ok !== true) {
    const message =
      typeof body?.error === "object" &&
      body.error !== null &&
      typeof (body.error as { message?: unknown }).message === "string"
        ? String((body.error as { message: string }).message)
        : `rpc "${method}" failed (HTTP ${response.status})`;
    throw new Error(message);
  }
  return body.result;
}

type OpenSummary = {
  threadId: string;
  total: number;
  completed: number;
  open: number;
  inProgress: number;
  blocked: number;
  ready: number;
  runningAgents: number;
};

function mountSidebarTodoPills(args: {
  signal: AbortSignal;
  setThreadRowStatus?:
    | ((
        threadId: string,
        status: {
          icon: string;
          label: string;
          tone?: "default" | "running" | "success" | "error";
        } | null,
      ) => void)
    | undefined;
}) {
  const { signal, setThreadRowStatus } = args;
  if (!setThreadRowStatus) return () => undefined;

  const tracked = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;

  const clearTracked = () => {
    for (const threadId of tracked) {
      try {
        setThreadRowStatus(threadId, null);
      } catch {
        // host may already have torn down
      }
    }
    tracked.clear();
  };

  const apply = (summaries: OpenSummary[]) => {
    const nextIds = new Set(summaries.map((s) => s.threadId));
    for (const threadId of tracked) {
      if (!nextIds.has(threadId)) {
        setThreadRowStatus(threadId, null);
        tracked.delete(threadId);
      }
    }
    for (const summary of summaries) {
      const label = `${summary.completed}/${summary.total} todos`;
      const tone =
        summary.inProgress > 0 || summary.runningAgents > 0
          ? "running"
          : summary.blocked > 0
            ? "error"
            : "default";
      setThreadRowStatus(summary.threadId, {
        icon: "ListTodo",
        label,
        tone,
      });
      tracked.add(summary.threadId);
    }
  };

  const refresh = async () => {
    if (signal.aborted || inFlight) return;
    inFlight = true;
    try {
      const result = (await callTodoRpc("listOpenSummaries", null)) as {
        summaries?: OpenSummary[];
      };
      apply(Array.isArray(result?.summaries) ? result.summaries : []);
    } catch {
      // keep last glyphs on transient failures
    } finally {
      inFlight = false;
    }
  };

  const schedule = (ms: number) => {
    if (signal.aborted) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void refresh().finally(() => schedule(4_000));
    }, ms);
  };

  void refresh().finally(() => schedule(4_000));

  const onVisibility = () => {
    if (document.visibilityState === "visible") void refresh();
  };
  document.addEventListener("visibilitychange", onVisibility);

  // Best-effort: when any todo realtime event fires, the host may not forward
  // plugin-signal to content scripts, so polling is the backbone. Still try a
  // short refresh burst after focus.
  const onFocus = () => void refresh();
  window.addEventListener("focus", onFocus);

  const dispose = () => {
    if (timer) clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("focus", onFocus);
    clearTracked();
  };
  signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "todo-status",
    scopes: ["thread"],
    banners: [{ id: "todo-card", chrome: "bare", component: TodoBanner }],
  });
  app.slots.experimental_threadHeaderAction({
    id: "todo-progress",
    title: "Todos",
    component: ThreadHeaderTodo,
  });
  // Sidebar trailing glyph next to activity/drafting (host single-slot API).
  app.contentScripts.register({
    id: "sidebar-todo-pills",
    mount({ signal, experimental_setThreadRowStatus }) {
      return mountSidebarTodoPills({
        signal,
        setThreadRowStatus: experimental_setThreadRowStatus,
      });
    },
  });
});
