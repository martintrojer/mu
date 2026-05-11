import { describe, expect, it } from "vitest";
import { TracksPopup } from "../src/cli/tui/popups/tracks.js";

describe("TracksPopup", () => {
  it("is exported as a function", () => {
    expect(typeof TracksPopup).toBe("function");
  });
  it("source yanks `mu task tree <goal>`", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("./src/cli/tui/popups/tracks.tsx", "utf-8");
    expect(src).toContain("mu task tree");
  });
  it("source drills into per-track task list (getTask + onModeChange)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("./src/cli/tui/popups/tracks.tsx", "utf-8");
    expect(src).toContain("getTask");
    expect(src).toContain('onModeChange("drill")');
    expect(src).toContain('onModeChange("list")');
  });
  // feat_track_drill_chains_to_task_drill: Enter on a Tracks-drill
  // task row chains into the same task-detail leaf the Tasks popup
  // uses (notes timeline). One Esc/q backs out per recursion level.
  it("source widens the drill view with a task-detail sub-mode", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("./src/cli/tui/popups/tracks.tsx", "utf-8");
    // The internal sub-mode union (kept local while app.tsx is
    // owned by another agent's branch).
    expect(src).toContain('"task-list"');
    expect(src).toContain('"task-detail"');
    // Enter inside the drill triggers the chain into task-detail.
    expect(src).toContain('setDrillSubMode("task-detail")');
    // Esc/q from task-detail backs out to task-list (NOT all the
    // way to the tracks list).
    expect(src).toContain('setDrillSubMode("task-list")');
  });
  it("source consumes the shared TaskDetailDrill leaf (no inline notes render)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("./src/cli/tui/popups/tracks.tsx", "utf-8");
    expect(src).toContain("TaskDetailDrill");
    // The shared formatter is the single source of truth for the
    // notes body — tracks.tsx must NOT roll its own renderer.
    expect(src).toContain("renderNotes");
    // Render branch updates the Shell title for the leaf level.
    expect(src).toContain("task:");
  });
});
