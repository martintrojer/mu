// Recorded herdr wire fixtures, shared by every mux test.
//
// Every JSON body here is a VERBATIM capture from a real herdr 0.8.0
// server (protocol 19) driven through an isolated `herdr --session
// mutest-topo`. Hardcoding the recordings is what keeps herdr tests in
// the FAST tier: no subprocess, no server, no sleeps.
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

export const STATUS_RUNNING = [
  "client:",
  "  version: 0.8.0",
  "  protocol: 19",
  "",
  "server:",
  "  status: running",
  "  protocol: 19",
  "  compatible: yes",
].join("\n");

export const STATUS_STOPPED = [
  "client:",
  "  version: 0.8.0",
  "",
  "server:",
  "  status: not running",
  "  socket: /home/u/.config/herdr/herdr.sock",
].join("\n");

export const STATUS_INCOMPATIBLE = STATUS_RUNNING.replace("compatible: yes", "compatible: no");
