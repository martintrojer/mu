// Recorded herdr wire fixtures, shared by every mux test.
//
// Every JSON body here is a VERBATIM capture from a real herdr 0.8.0
// server (protocol 19) driven through an isolated `herdr --session
// mutest-topo`. Hardcoding the recordings is what keeps herdr tests in
// the FAST tier: no subprocess, no server, no sleeps.
//
// The `herdr status` payloads below are 0.9.0 (protocol 22, endpoint
// generation 1), which renamed the single `compatible:` line into
// `endpoint_compatible:` + `private_protocol_compatible:`. The JSON
// bodies were unchanged by that release.
//
// Why a shared module rather than a const block per test file: the
// recordings are a contract with an external binary. When herdr changes
// a payload shape, exactly one file should need re-recording — and
// every test that depends on the old shape should break at once, not
// drift apart file by file. Re-record with:
//
//   MU_HERDR_SESSION=mutest-topo herdr --session mutest-topo <cmd>
//
// NEVER re-record against the default session (see `test/_mux.ts`).

// ─── Workspaces (= mu sessions) ────────────────────────────────────────

export const WORKSPACE_LIST = JSON.stringify({
  id: "cli:workspace:list",
  result: {
    type: "workspace_list",
    workspaces: [
      {
        active_tab_id: "w1:t1",
        agent_status: "unknown",
        focused: true,
        label: "mu-topotest",
        number: 1,
        pane_count: 1,
        tab_count: 1,
        workspace_id: "w1",
      },
    ],
  },
});

export const WORKSPACE_LIST_EMPTY = JSON.stringify({
  id: "cli:workspace:list",
  result: { type: "workspace_list", workspaces: [] },
});

export const WORKSPACE_CREATED = JSON.stringify({
  id: "cli:workspace:create",
  result: {
    root_pane: {
      agent_status: "unknown",
      cwd: "/var/home/martintrojer",
      focused: true,
      pane_id: "w1:p1",
      tab_id: "w1:t1",
      terminal_id: "term_658aea428bdf51",
      workspace_id: "w1",
    },
    tab: { focused: true, label: "1", number: 1, tab_id: "w1:t1", workspace_id: "w1" },
    type: "workspace_created",
    workspace: { label: "mu-topotest", number: 1, workspace_id: "w1" },
  },
});

export const WORKSPACE_NOT_FOUND = JSON.stringify({
  error: { code: "workspace_not_found", message: "workspace w99 not found" },
  id: "cli:workspace:close",
});

// ─── Tabs (= mu windows) ───────────────────────────────────────────────

export const TAB_LIST = JSON.stringify({
  id: "cli:tab:list",
  result: {
    tabs: [
      { focused: true, label: "1", number: 1, pane_count: 1, tab_id: "w1:t1", workspace_id: "w1" },
      {
        focused: false,
        label: "mytab",
        number: 2,
        pane_count: 1,
        tab_id: "w1:t2",
        workspace_id: "w1",
      },
    ],
    type: "tab_list",
  },
});

export const TAB_CREATED = JSON.stringify({
  id: "cli:tab:create",
  result: {
    root_pane: {
      cwd: "/var/home/martintrojer",
      focused: false,
      pane_id: "w1:p2",
      tab_id: "w1:t2",
      workspace_id: "w1",
    },
    tab: { focused: false, label: "mytab", number: 2, tab_id: "w1:t2", workspace_id: "w1" },
    type: "tab_created",
  },
});

// ─── Panes (= mu agents) ───────────────────────────────────────────────

export const PANE_LIST = JSON.stringify({
  id: "cli:pane:list",
  result: {
    panes: [
      { focused: true, label: "worker-1", pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" },
      { focused: false, pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1" },
    ],
    type: "pane_list",
  },
});

export const PANE_SPLIT = JSON.stringify({
  id: "cli:pane:split",
  result: {
    pane: { cwd: "/tmp", focused: false, pane_id: "w1:p3", tab_id: "w1:t1", workspace_id: "w1" },
    type: "pane_info",
  },
});

export const PANE_GET = JSON.stringify({
  id: "cli:pane:get",
  result: {
    pane: {
      focused: true,
      label: "mylabel",
      pane_id: "w1:p1",
      tab_id: "w1:t1",
      workspace_id: "w1",
    },
    type: "pane_info",
  },
});

export const PANE_NOT_FOUND = JSON.stringify({
  error: { code: "pane_not_found", message: "pane w9:p9 not found" },
  id: "cli:pane:get",
});

export const OK = JSON.stringify({ id: "cli:pane:close", result: { type: "ok" } });

// ─── `herdr status` (the one non-JSON command) ─────────────────────────

/** herdr 0.9.0's shape: `compatible:` split into `endpoint_compatible:`
 *  (load-bearing) and `private_protocol_compatible:` (advisory). */
export const STATUS_RUNNING = [
  "client:",
  "  version: 0.9.0",
  "  channel: stable",
  "  protocol: 22",
  "  endpoint_protocol_generation: 1",
  "",
  "server:",
  "  status: running",
  "  version: 0.9.0",
  "  endpoint_compatible: yes",
  "  private_protocol: 22",
  "  private_protocol_compatible: yes",
  "  socket: /home/u/.config/herdr/herdr.sock",
].join("\n");

export const STATUS_STOPPED = [
  "client:",
  "  version: 0.9.0",
  "  protocol: 22",
  "",
  "server:",
  "  status: not running",
  "  socket: /home/u/.config/herdr/herdr.sock",
].join("\n");

/** Server predates endpoint generation 1: no verb works until upgraded. */
export const STATUS_INCOMPATIBLE = STATUS_RUNNING.replace(
  "endpoint_compatible: yes",
  "endpoint_compatible: no",
);

/** Private-protocol skew only. Since 0.9.0 this disables individual
 *  actions rather than the connection, so mu must still treat the
 *  backend as available. */
export const STATUS_PRIVATE_PROTOCOL_SKEW = STATUS_RUNNING.replace(
  "private_protocol_compatible: yes",
  "private_protocol_compatible: no",
);

/** herdr ≤0.8.x, whose single `compatible:` line mu still honours. */
export const STATUS_LEGACY_INCOMPATIBLE = [
  "client:",
  "  version: 0.8.0",
  "  protocol: 19",
  "",
  "server:",
  "  status: running",
  "  protocol: 19",
  "  compatible: no",
].join("\n");

/** herdr 0.9.0's refusal to close a workspace that has linked worktree
 *  workspaces without explicit group intent. */
export const WORKSPACE_GROUP_CLOSE_REQUIRED = JSON.stringify({
  error: {
    code: "workspace_group_close_required",
    message:
      "workspace has linked worktree workspaces; use --group (close_group=true in the API) to close the group",
  },
  id: "cli:workspace:close",
});
