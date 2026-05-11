// Card tests use static rendering via React's TestRenderer-style
// approach, but since ink-testing-library is not installable here, we
// use static-source assertions on the component file plus a simple
// JSON-shape audit on the props it accepts. Wave 5 Task 30.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AgentsCard } from "../src/cli/tui/cards/agents.js";

const AGENTS_SRC = readFileSync(
  new URL("../src/cli/tui/cards/agents.tsx", import.meta.url),
  "utf8",
);

describe("AgentsCard", () => {
  it("is exported as a function", () => {
    expect(typeof AgentsCard).toBe("function");
  });

  it("accepts { snapshot } as a prop and tolerates null", () => {
    // The component renders a placeholder when snapshot is null.
    // We can call it as a function (React FC) and assert it returns
    // a JSX element shape — sufficient to catch import-graph drift
    // without a full ink renderer.
    const result = AgentsCard({ snapshot: null });
    expect(result).toBeTruthy();
    // Top-level element is a Box with dimColor text.
  });

  it("no '—' idle placeholder — exception-only render per nit_tui_agents_card_drop_idle_placeholder", () => {
    // The non-idle branch must render an empty string, not the literal
    // em-dash. The placeholder was visually noisy (column placeholder
    // doing zero work). Cheapest regression guard without ink-testing-library.
    expect(AGENTS_SRC).not.toMatch(/idle\s*\?\s*"⚠ idle"\s*:\s*"—"/);
    expect(AGENTS_SRC).toMatch(/a\.idle\s*\?\s*"⚠ idle"\s*:\s*""/);
  });

  it("renders something for an empty agents list", () => {
    const result = AgentsCard({
      snapshot: {
        workstreamName: "demo",
        view: { agents: [], orphans: [], report: { reaped: [], pruned: [] } },
        tracks: [],
        ready: [],
        inProgress: [],
        blocked: [],
        recentClosed: [],
        workspaces: [],
        workspaceOrphans: [],
        recent: [],
      },
    });
    expect(result).toBeTruthy();
  });
});
