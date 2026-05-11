// Lifecycle tests for src/tasks.ts: claimTask + atomic CAS,
// setTaskStatus / closeTask / openTask, releaseTask, evidence
// threading on lifecycle verbs, resolveActorIdentity.
//
// rejectTask / deferTask (terminal-but-blocking, --cascade
// dry-run/--yes) live in test/tasks-reject-defer.test.ts.
// Split out of test/tasks.test.ts under
// testreview_test_files_past_800loc — see test/tasks-crud.test.ts
// for the full split rationale.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { listLogs } from "../src/logs.js";
import {
  ClaimerNotRegisteredError,
  TaskAlreadyOwnedError,
  TaskNotFoundError,
  addTask,
  claimTask,
  closeTask,
  getTask,
  listNotes,
  openTask,
  releaseTask,
  resolveActorIdentity,
  setTaskStatus,
} from "../src/tasks.js";
import { type TmuxExecutor, resetTmuxExecutor, setTmuxExecutor } from "../src/tmux.js";
import { withCleanIdentityEnv, withEnv } from "./_env.js";

// ─── Setup / teardown ──────────────────────────────────────────────────

let tempDir: string;
let db: Db;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-tasks-lifecycle-"));
  db = openDb({ path: join(tempDir, "mu.db") });
  resetTmuxExecutor();
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
  resetTmuxExecutor();
});

describe("claimTask", () => {
  beforeEach(() => {
    addTask(db, { localId: "auth", workstream: "test", title: "Auth", impact: 80, effortDays: 2 });
    // tasks.owner is now a real FK to agents(name); the test agents must
    // exist before they can claim.
    insertAgent(db, { name: "alice", workstream: "test", paneId: "%1", status: "busy" });
    insertAgent(db, { name: "bob", workstream: "test", paneId: "%2", status: "busy" });
  });

  it("claims with explicit agentName", async () => {
    const result = await claimTask(db, "auth", { agentName: "alice", workstream: "test" });
    expect(result.ownerName).toBe("alice");
    expect(result.previousOwnerName).toBeNull();
    expect(result.previousStatus).toBe("OPEN");
    expect(result.status).toBe("IN_PROGRESS");
    expect(getTask(db, "auth", "test")?.ownerName).toBe("alice");
    expect(getTask(db, "auth", "test")?.status).toBe("IN_PROGRESS");
  });

  it("flips OPEN → IN_PROGRESS but leaves IN_PROGRESS unchanged on re-claim", async () => {
    await claimTask(db, "auth", { agentName: "alice", workstream: "test" });
    const second = await claimTask(db, "auth", { agentName: "alice", workstream: "test" });
    expect(second.previousStatus).toBe("IN_PROGRESS");
    expect(second.status).toBe("IN_PROGRESS");
  });

  it("does NOT flip status when CLOSED", async () => {
    db.prepare("UPDATE tasks SET status='CLOSED' WHERE local_id='auth'").run();
    const result = await claimTask(db, "auth", { agentName: "alice", workstream: "test" });
    expect(result.status).toBe("CLOSED");
  });

  it("re-claim by same agent is a no-op (idempotent)", async () => {
    await claimTask(db, "auth", { agentName: "alice", workstream: "test" });
    await claimTask(db, "auth", { agentName: "alice", workstream: "test" });
    expect(getTask(db, "auth", "test")?.ownerName).toBe("alice");
  });

  it("throws TaskAlreadyOwnedError when another agent owns it", async () => {
    await claimTask(db, "auth", { agentName: "alice", workstream: "test" });
    await expect(
      claimTask(db, "auth", { agentName: "bob", workstream: "test" }),
    ).rejects.toBeInstanceOf(TaskAlreadyOwnedError);
    // alice still owns it.
    expect(getTask(db, "auth", "test")?.ownerName).toBe("alice");
  });

  it("throws TaskNotFoundError for unknown task", async () => {
    await expect(
      claimTask(db, "ghost", { agentName: "alice", workstream: "test" }),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
  });

  it("derives agentName from currentPaneTitle when not provided", async () => {
    const executor: TmuxExecutor = async (args) => {
      if (args[0] === "display-message" && args.includes("#{pane_title}")) {
        return { stdout: "alice\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "unmocked", exitCode: 1 };
    };
    setTmuxExecutor(executor);
    await withEnv("TMUX_PANE", "%15", async () => {
      const result = await claimTask(db, "auth", { workstream: "test" });
      expect(result.ownerName).toBe("alice");
    });
  });

  it("throws when no agent name available (no $TMUX_PANE, no opts.agentName)", async () => {
    await withEnv("TMUX_PANE", undefined, async () => {
      await expect(claimTask(db, "auth", { workstream: "test" })).rejects.toThrow(/no agent name/);
    });
  });

  it("bumps updated_at", async () => {
    const before = getTask(db, "auth", "test")?.updatedAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await claimTask(db, "auth", { agentName: "alice", workstream: "test" });
    const after = getTask(db, "auth", "test")?.updatedAt;
    expect(after).not.toBe(before);
  });

  // ─ ClaimerNotRegisteredError: pre-check that maps the would-be
  //   bare 'FOREIGN KEY constraint failed' (from the FK on tasks.owner
  //   added in the v2 migration) into a typed actionable error.
  it("throws ClaimerNotRegisteredError when --for names a non-existent agent", async () => {
    await expect(
      claimTask(db, "auth", { agentName: "ghost", workstream: "test" }),
    ).rejects.toBeInstanceOf(ClaimerNotRegisteredError);
    // Task untouched (no partial write through the FK).
    expect(getTask(db, "auth", "test")?.ownerName).toBeNull();
    expect(getTask(db, "auth", "test")?.status).toBe("OPEN");
  });

  it("ClaimerNotRegisteredError carries three structured next-steps via errorNextSteps()", async () => {
    try {
      await claimTask(db, "auth", { agentName: "ghost", workstream: "test" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ClaimerNotRegisteredError);
      const msg = (err as Error).message;
      // The bare message identifies the claimer + condition; resolutions
      // live in errorNextSteps(), not the prose.
      expect(msg).toContain("ghost");
      expect(msg).toContain("not a registered mu agent");
      const steps = (err as ClaimerNotRegisteredError).errorNextSteps();
      expect(steps).toHaveLength(3);
      // --self is first (most-common-resolution-first).
      expect(steps[0]?.command).toContain("--self");
      expect(steps[1]?.command).toContain("--for");
      expect(steps[2]?.command).toContain("mu adopt");
    }
  });

  it("ClaimerNotRegisteredError errorNextSteps() pins the actual pane id when name came from $TMUX_PANE", async () => {
    const executor: TmuxExecutor = async (args) => {
      if (args[0] === "display-message" && args.includes("#{pane_title}")) {
        return { stdout: "unregistered\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "unmocked", exitCode: 1 };
    };
    setTmuxExecutor(executor);
    await withEnv("TMUX_PANE", "%99", async () => {
      try {
        await claimTask(db, "auth", { workstream: "test" });
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ClaimerNotRegisteredError);
        const steps = (err as ClaimerNotRegisteredError).errorNextSteps();
        const adopt = steps.find((s) => s.command.startsWith("mu adopt"));
        expect(adopt?.command).toBe("mu adopt %99");
      }
    });
  });

  // ─ --self anonymous claim path (orchestrator pattern) ─
  it("--self skips the FK check; sets owner=NULL; records actor in result + log", async () => {
    const result = await claimTask(db, "auth", {
      self: true,
      actor: "orchestrator",
      workstream: "test",
    });
    expect(result.ownerName).toBeNull();
    expect(result.actorName).toBe("orchestrator");
    expect(result.previousStatus).toBe("OPEN");
    expect(result.status).toBe("IN_PROGRESS");
    expect(getTask(db, "auth", "test")?.ownerName).toBeNull();
    expect(getTask(db, "auth", "test")?.status).toBe("IN_PROGRESS");
  });

  it("--self emits an agent_logs event with the actor as source", async () => {
    await claimTask(db, "auth", { self: true, actor: "deploy-bot", workstream: "test" });
    const events = listLogs(db, { workstream: "test", kind: "event" });
    const claim = events.find((e) => e.payload.includes("task claim auth"));
    expect(claim).toBeDefined();
    expect(claim?.source).toBe("deploy-bot");
    expect(claim?.payload).toContain("--self");
    expect(claim?.payload).toContain("anonymous");
  });

  it("--self does NOT require the actor to exist in the agents table", async () => {
    // 'phantom' has no row in agents — worker-claim path would reject;
    // --self happily proceeds because owner stays NULL (no FK to satisfy).
    const result = await claimTask(db, "auth", {
      self: true,
      actor: "phantom",
      workstream: "test",
    });
    expect(result.ownerName).toBeNull();
    expect(result.actorName).toBe("phantom");
  });

  it("--self with an unowned task succeeds; --self with an owned task throws TaskAlreadyOwnedError", async () => {
    await claimTask(db, "auth", { agentName: "alice", workstream: "test" });
    await expect(
      claimTask(db, "auth", { self: true, actor: "orchestrator", workstream: "test" }),
    ).rejects.toBeInstanceOf(TaskAlreadyOwnedError);
    // Alice still owns it (no overwrite).
    expect(getTask(db, "auth", "test")?.ownerName).toBe("alice");
  });

  it("--self and agentName together is a usage error", async () => {
    await expect(
      claimTask(db, "auth", { self: true, agentName: "alice", workstream: "test" }),
    ).rejects.toThrow(/mutually exclusive/);
  });

  it("--self resolves actor from $TMUX_PANE when not explicit", async () => {
    const executor: TmuxExecutor = async (args) => {
      if (args[0] === "display-message" && args.includes("#{pane_title}")) {
        return { stdout: "orchestrator-pane\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "unmocked", exitCode: 1 };
    };
    setTmuxExecutor(executor);
    // withCleanIdentityEnv strips MU_AGENT_NAME/TMUX_PANE/USER from
    // process.env before the inner withEnv reinstates TMUX_PANE.
    // Without it, MU_AGENT_NAME leaking from a mu-spawned host pane
    // wins the resolveActorIdentity fallback chain.
    await withCleanIdentityEnv(async () => {
      await withEnv("TMUX_PANE", "%42", async () => {
        const result = await claimTask(db, "auth", { self: true, workstream: "test" });
        expect(result.actorName).toBe("orchestrator-pane");
      });
    });
  });

  it("--self resolves actor from $USER when no $TMUX_PANE", async () => {
    await withCleanIdentityEnv(async () => {
      await withEnv("USER", "martin", async () => {
        const result = await claimTask(db, "auth", { self: true, workstream: "test" });
        expect(result.actorName).toBe("martin");
      });
    });
  });

  it("--self falls back to 'orchestrator' when no $MU_AGENT_NAME, $TMUX_PANE, or $USER", async () => {
    // Was 'unknown' before the resolveActorIdentity refactor; changed
    // to 'orchestrator' for symmetry with task_notes.author and the
    // overall identity-resolution chain. The 'orchestrator' label is
    // meaningful; 'unknown' was a placeholder.
    await withEnv("MU_AGENT_NAME", undefined, async () => {
      await withEnv("TMUX_PANE", undefined, async () => {
        await withEnv("USER", undefined, async () => {
          const result = await claimTask(db, "auth", { self: true, workstream: "test" });
          expect(result.actorName).toBe("orchestrator");
        });
      });
    });
  });

  // ─ Cross-workstream guard: --for must reject when the named agent
  //   lives in a different workstream than the task. The schema's FK
  //   on tasks.owner is keyed on agents.name only (no workstream
  //   qualifier), so without this pre-check the claim would silently
  //   accept and the rest of mu would treat the row as in-scope.
  //   Surfaced live by snap_dogfood; filed as cross_workstream_claim_for.
  // v5: claimTask resolves both task and agent inside opts.workstream
  // (per-workstream uniqueness). A wrong-workstream agent surfaces
  // as ClaimerNotRegisteredError; a wrong-workstream task surfaces as
  // TaskNotFoundError. The cross-workstream-guard pre-check that used
  // to raise AgentNotInWorkstreamError is gone — the mismatch is
  // structurally impossible.
  it("claims by an agent missing in opts.workstream raise ClaimerNotRegisteredError", async () => {
    insertAgent(db, {
      name: "cross",
      workstream: "other",
      paneId: "%99",
      status: "busy",
    });
    // 'cross' lives in 'other'; this claim targets workstream 'test'.
    await expect(
      claimTask(db, "auth", { agentName: "cross", workstream: "test" }),
    ).rejects.toBeInstanceOf(ClaimerNotRegisteredError);
    // No partial write: task untouched.
    expect(getTask(db, "auth", "test")?.ownerName).toBeNull();
    expect(getTask(db, "auth", "test")?.status).toBe("OPEN");
  });

  it("--self path resolves the task in opts.workstream", async () => {
    // No agent FK to check on --self; the orchestrator can drive the
    // workstream's tasks anonymously. The task lookup still scopes to
    // opts.workstream (no global-search fallback).
    const result = await claimTask(db, "auth", {
      self: true,
      actor: "orchestrator",
      workstream: "test",
    });
    expect(result.ownerName).toBeNull();
    expect(result.actorName).toBe("orchestrator");
    expect(getTask(db, "auth", "test")?.status).toBe("IN_PROGRESS");
  });
});

// ─── setTaskStatus / closeTask / openTask ──────────────────────────────────

describe("setTaskStatus / closeTask / openTask", () => {
  beforeEach(() => {
    addTask(db, {
      localId: "design",
      workstream: "auth",
      title: "D",
      impact: 50,
      effortDays: 1,
    });
    // FK: tasks.owner → agents(name); the worker-1 claim test below needs
    // the agent row to exist.
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", status: "busy" });
  });

  it("closeTask flips OPEN → CLOSED and reports the change", () => {
    const r = closeTask(db, "design", { workstream: "auth" });
    expect(r).toEqual({ previousStatus: "OPEN", status: "CLOSED", changed: true });
    expect(getTask(db, "design", "auth")?.status).toBe("CLOSED");
  });

  it("closeTask is idempotent on an already-CLOSED task", () => {
    closeTask(db, "design", { workstream: "auth" });
    const r = closeTask(db, "design", { workstream: "auth" });
    expect(r.changed).toBe(false);
    expect(r.status).toBe("CLOSED");
  });

  it("openTask flips CLOSED → OPEN and is idempotent on already-OPEN", () => {
    closeTask(db, "design", { workstream: "auth" });
    const r1 = openTask(db, "design", { workstream: "auth" });
    expect(r1).toEqual({ previousStatus: "CLOSED", status: "OPEN", changed: true });
    const r2 = openTask(db, "design", { workstream: "auth" });
    expect(r2.changed).toBe(false);
  });

  it("openTask leaves owner intact (use releaseTask to clear owner)", async () => {
    await claimTask(db, "design", { agentName: "worker-1", workstream: "auth" });
    closeTask(db, "design", { workstream: "auth" });
    openTask(db, "design", { workstream: "auth" });
    expect(getTask(db, "design", "auth")?.ownerName).toBe("worker-1");
  });

  it("setTaskStatus accepts arbitrary status", () => {
    const r = setTaskStatus(db, "design", "IN_PROGRESS", { workstream: "auth" });
    expect(r).toEqual({ previousStatus: "OPEN", status: "IN_PROGRESS", changed: true });
    expect(getTask(db, "design", "auth")?.status).toBe("IN_PROGRESS");
  });

  it("setTaskStatus / closeTask / openTask all throw TaskNotFoundError on missing", () => {
    expect(() => setTaskStatus(db, "ghost", "CLOSED", { workstream: "auth" })).toThrow(
      TaskNotFoundError,
    );
    expect(() => closeTask(db, "ghost", { workstream: "auth" })).toThrow(TaskNotFoundError);
    expect(() => openTask(db, "ghost", { workstream: "auth" })).toThrow(TaskNotFoundError);
  });

  it("closeTask bumps updated_at", () => {
    const before = getTask(db, "design", "auth")?.updatedAt;
    // Sleep tick to ensure ISO-string difference at ms resolution.
    const start = Date.now();
    while (Date.now() === start) {
      /* spin */
    }
    closeTask(db, "design", { workstream: "auth" });
    const after = getTask(db, "design", "auth")?.updatedAt;
    expect(after).not.toBe(before);
  });
});

// ─── releaseTask ──────────────────────────────────────────────────────────

describe("releaseTask", () => {
  beforeEach(async () => {
    addTask(db, {
      localId: "design",
      workstream: "auth",
      title: "D",
      impact: 50,
      effortDays: 1,
    });
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", status: "busy" });
  });

  it("clears owner on a claimed task; auto-flips IN_PROGRESS → OPEN", async () => {
    // review_release_open_in_progress_inconsistency: bare release
    // used to leave owner=NULL/IN_PROGRESS — a stranded state. The
    // SDK now flips IN_PROGRESS → OPEN automatically so the task
    // re-enters the ready set.
    await claimTask(db, "design", { agentName: "worker-1", workstream: "auth" });
    expect(getTask(db, "design", "auth")?.status).toBe("IN_PROGRESS");

    const r = releaseTask(db, "design", { workstream: "auth" });
    expect(r.previousOwnerName).toBe("worker-1");
    expect(r.changed).toBe(true);
    expect(r.previousStatus).toBe("IN_PROGRESS");
    expect(r.status).toBe("OPEN");
    const after = getTask(db, "design", "auth");
    expect(after?.ownerName).toBeNull();
    expect(after?.status).toBe("OPEN");
  });

  it("--reopen on a claimed IN_PROGRESS task also flips to OPEN (same shape as bare release)", async () => {
    await claimTask(db, "design", { agentName: "worker-1", workstream: "auth" });
    const r = releaseTask(db, "design", { reopen: true, workstream: "auth" });
    expect(r.previousStatus).toBe("IN_PROGRESS");
    expect(r.status).toBe("OPEN");
    expect(r.changed).toBe(true);
    const after = getTask(db, "design", "auth");
    expect(after?.ownerName).toBeNull();
    expect(after?.status).toBe("OPEN");
  });

  it("--reopen on a CLOSED owned task forces OPEN (the un-close escape hatch)", async () => {
    await claimTask(db, "design", { agentName: "worker-1", workstream: "auth" });
    closeTask(db, "design", { workstream: "auth" });
    // Owner is preserved across closeTask, status=CLOSED.
    expect(getTask(db, "design", "auth")?.status).toBe("CLOSED");
    const r = releaseTask(db, "design", { reopen: true, workstream: "auth" });
    expect(r.previousStatus).toBe("CLOSED");
    expect(r.status).toBe("OPEN");
    const after = getTask(db, "design", "auth");
    expect(after?.ownerName).toBeNull();
    expect(after?.status).toBe("OPEN");
  });

  it("bare release on a CLOSED owned task clears owner but preserves status", async () => {
    await claimTask(db, "design", { agentName: "worker-1", workstream: "auth" });
    closeTask(db, "design", { workstream: "auth" });
    const r = releaseTask(db, "design", { workstream: "auth" });
    expect(r.changed).toBe(true);
    expect(r.previousStatus).toBe("CLOSED");
    expect(r.status).toBe("CLOSED");
    const after = getTask(db, "design", "auth");
    expect(after?.ownerName).toBeNull();
    expect(after?.status).toBe("CLOSED");
  });

  it("--reopen on an already-OPEN unowned task is a no-op", () => {
    const r = releaseTask(db, "design", { reopen: true, workstream: "auth" });
    expect(r.changed).toBe(false);
  });

  it("plain release on an already-unowned task is a no-op", () => {
    const r = releaseTask(db, "design", { workstream: "auth" });
    expect(r.changed).toBe(false);
    expect(r.previousOwnerName).toBeNull();
  });

  it("--reopen on a CLOSED unowned task DOES flip back to OPEN (changed=true)", () => {
    closeTask(db, "design", { workstream: "auth" });
    const r = releaseTask(db, "design", { reopen: true, workstream: "auth" });
    expect(r.changed).toBe(true);
    expect(r.status).toBe("OPEN");
  });

  it("throws TaskNotFoundError on missing task", () => {
    expect(() => releaseTask(db, "ghost", { workstream: "auth" })).toThrow(TaskNotFoundError);
  });

  // Regression: task_updatedat_not_bumped_by_reparent. release is a
  // mutating write on the task row (owner_id + status side-effect);
  // updated_at must advance so `mu task list --sort recency` reflects
  // the change.
  it("bumps updated_at on a real release", async () => {
    await claimTask(db, "design", { agentName: "worker-1", workstream: "auth" });
    const before = getTask(db, "design", "auth")?.updatedAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const r = releaseTask(db, "design", { workstream: "auth" });
    expect(r.changed).toBe(true);
    const after = getTask(db, "design", "auth")?.updatedAt;
    expect(after).not.toBe(before);
  });
});

// ─── evidence on lifecycle verbs ──────────────────────────────
//
// First inch of the "observed vs claimed" distinction:
// the verb still trusts the caller, but the audit trail records what
// the caller said it relied on.

describe("evidence on lifecycle verbs", () => {
  beforeEach(() => {
    addTask(db, {
      localId: "design",
      workstream: "auth",
      title: "Design",
      impact: 50,
      effortDays: 1,
    });
    db.prepare("DELETE FROM agent_logs").run();
  });

  // Returns the latest `kind='event'` payload, optionally filtered to
  // events whose payload contains `match`. The match arg is needed
  // because closeTask now emits TWO events when --evidence is set:
  // the `task status ...` flip event AND the `task note ...` event
  // for the auto-inserted CLOSE: synthetic note (mufeedback
  // task_close_evidence_does_not_append_the). Tests that want the
  // status payload must scope to it explicitly.
  function lastEventPayload(match?: string): string {
    const sql = match
      ? "SELECT payload FROM agent_logs WHERE kind = 'event' AND payload LIKE ? ORDER BY seq DESC LIMIT 1"
      : "SELECT payload FROM agent_logs WHERE kind = 'event' ORDER BY seq DESC LIMIT 1";
    const stmt = db.prepare(sql);
    const row = (match ? stmt.get(`%${match}%`) : stmt.get()) as { payload: string } | undefined;
    return row?.payload ?? "";
  }

  it('closeTask --evidence appends evidence="…" to the event payload', () => {
    closeTask(db, "design", { evidence: "tests pass: npm test exit 0", workstream: "auth" });
    const p = lastEventPayload("task status");
    expect(p).toContain("task status design");
    expect(p).toContain('evidence="tests pass: npm test exit 0"');
  });

  it("closeTask without --evidence omits the suffix", () => {
    closeTask(db, "design", { workstream: "auth" });
    const p = lastEventPayload();
    expect(p).toContain("task status design");
    expect(p).not.toContain("evidence=");
  });

  it("openTask --evidence threads through too", () => {
    closeTask(db, "design", { workstream: "auth" });
    db.prepare("DELETE FROM agent_logs").run();
    openTask(db, "design", { evidence: "reopened: deploy rollback", workstream: "auth" });
    expect(lastEventPayload()).toContain('evidence="reopened: deploy rollback"');
  });

  it("releaseTask --evidence threads through (and survives --reopen)", () => {
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", status: "busy" });
    db.prepare(
      `UPDATE tasks SET owner_id = (SELECT id FROM agents WHERE name = 'worker-1'),
              status='IN_PROGRESS' WHERE local_id='design'`,
    ).run();
    db.prepare("DELETE FROM agent_logs").run();
    releaseTask(db, "design", {
      reopen: true,
      evidence: "agent crashed mid-task",
      workstream: "auth",
    });
    const p = lastEventPayload();
    expect(p).toContain("task release design");
    expect(p).toContain("IN_PROGRESS → OPEN");
    expect(p).toContain('evidence="agent crashed mid-task"');
  });

  it("claimTask --evidence threads through", async () => {
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", status: "busy" });
    db.prepare("DELETE FROM agent_logs").run();
    await claimTask(db, "design", {
      agentName: "worker-1",
      evidence: "reviewed task; have implementation plan",
      workstream: "auth",
    });
    const p = lastEventPayload();
    expect(p).toContain("task claim design by worker-1");
    expect(p).toContain('evidence="reviewed task; have implementation plan"');
  });

  it("evidence is JSON-quoted so multi-word + special chars stay legible", () => {
    closeTask(db, "design", { evidence: 'has "quotes" and a \\backslash', workstream: "auth" });
    const p = lastEventPayload("task status");
    // JSON.stringify preserves the inner quotes and backslash via escaping
    expect(p).toContain('evidence="has \\"quotes\\" and a \\\\backslash"');
  });

  // mufeedback task_close_evidence_does_not_append_the: when
  // `mu task close --evidence "..."` runs, the evidence string used to
  // land only in the agent_logs event payload, not in `mu task notes`.
  // Workers were skipping the "drop a final note" contract on the
  // assumption that --evidence was sufficient. closeTask now auto-
  // inserts a synthetic `CLOSE: <evidence>` note so the evidence joins
  // the note timeline.
  it("closeTask --evidence inserts a synthetic CLOSE note into task_notes", () => {
    closeTask(db, "design", {
      evidence: "npm test exit 0",
      author: "worker-1",
      workstream: "auth",
    });
    const notes = listNotes(db, "design", "auth");
    expect(notes).toHaveLength(1);
    expect(notes[0]?.content).toBe("CLOSE: npm test exit 0");
    expect(notes[0]?.author).toBe("worker-1");
  });

  it("closeTask without --evidence does NOT insert a synthetic note", () => {
    closeTask(db, "design", { workstream: "auth" });
    expect(listNotes(db, "design", "auth")).toHaveLength(0);
  });

  it("closeTask with empty-string --evidence does NOT insert a synthetic note", () => {
    closeTask(db, "design", { evidence: "", workstream: "auth" });
    expect(listNotes(db, "design", "auth")).toHaveLength(0);
  });

  it("closeTask is idempotent on the synthetic note (re-close on already-CLOSED skips it)", () => {
    closeTask(db, "design", {
      evidence: "shipped via PR #42",
      author: "worker-1",
      workstream: "auth",
    });
    // Second close with different evidence on an already-CLOSED task
    // is a no-op (changed=false); no second synthetic note should
    // accumulate, otherwise retries would spam the timeline.
    closeTask(db, "design", {
      evidence: "second attempt",
      author: "worker-1",
      workstream: "auth",
    });
    const notes = listNotes(db, "design", "auth");
    expect(notes).toHaveLength(1);
    expect(notes[0]?.content).toBe("CLOSE: shipped via PR #42");
  });
});

// ─── resolveActorIdentity (verb-agnostic identity resolution) ────────────

describe("resolveActorIdentity", () => {
  it("prefers $MU_AGENT_NAME when set (mu-spawned worker case)", async () => {
    await withEnv("MU_AGENT_NAME", "worker-7", async () => {
      // Even with TMUX_PANE pointing somewhere with a different title,
      // MU_AGENT_NAME wins (it's set at spawn time and unforgeable from
      // outside without explicit override).
      const executor: TmuxExecutor = async (args) => {
        if (args[0] === "display-message" && args.includes("#{pane_title}")) {
          return { stdout: "different-title\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "unmocked", exitCode: 1 };
      };
      setTmuxExecutor(executor);
      await withEnv("TMUX_PANE", "%99", async () => {
        const actor = await resolveActorIdentity();
        expect(actor).toBe("worker-7");
      });
    });
  });

  it("falls back to pane title when MU_AGENT_NAME is unset (legacy/adopted pane)", async () => {
    const executor: TmuxExecutor = async (args) => {
      if (args[0] === "display-message" && args.includes("#{pane_title}")) {
        return { stdout: "legacy-pane-title\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "unmocked", exitCode: 1 };
    };
    setTmuxExecutor(executor);
    await withEnv("MU_AGENT_NAME", undefined, async () => {
      await withEnv("TMUX_PANE", "%99", async () => {
        const actor = await resolveActorIdentity();
        expect(actor).toBe("legacy-pane-title");
      });
    });
  });

  it("falls back to $USER when no MU_AGENT_NAME and no TMUX_PANE", async () => {
    await withEnv("MU_AGENT_NAME", undefined, async () => {
      await withEnv("TMUX_PANE", undefined, async () => {
        await withEnv("USER", "martin", async () => {
          const actor = await resolveActorIdentity();
          expect(actor).toBe("martin");
        });
      });
    });
  });

  it("falls back to 'orchestrator' as the last-resort default", async () => {
    await withEnv("MU_AGENT_NAME", undefined, async () => {
      await withEnv("TMUX_PANE", undefined, async () => {
        await withEnv("USER", undefined, async () => {
          const actor = await resolveActorIdentity();
          expect(actor).toBe("orchestrator");
        });
      });
    });
  });
});
