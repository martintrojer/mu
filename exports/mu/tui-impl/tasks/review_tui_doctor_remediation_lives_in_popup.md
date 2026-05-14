---
id: "review_tui_doctor_remediation_lives_in_popup"
workstream: "tui-impl"
status: CLOSED
impact: 35
effort_days: 0.15
roi: 233.33
owner: "worker-4"
created_at: "2026-05-13T12:53:30.639Z"
updated_at: "2026-05-13T13:27:47.546Z"
blocked_by: []
blocks: []
---

# REVIEW low: yankCommandForCheck + remediationParagraph belong in doctor-summary, not popup

## Notes (2)

### #1 by "worker-4", 2026-05-13T12:53:30.964Z

```
FILE(S):
  src/cli/tui/popups/doctor.tsx:271-326 (yankCommandForCheck + remediationParagraph)

FINDING (non-idiomatic — wrong layer):
  `yankCommandForCheck` and `remediationParagraph` live inside
  the popup module. Both are pure functions that map a
  `DoctorCheck.name` to a piece of human-readable text or a
  shell command. Neither has any popup-rendering concern; they
  could equally well be called from `mu doctor` (CLI), the
  static `mu state` card, or a future `mu help check <name>`
  verb.

  The header comment even concedes this:
  > "Lives here rather than in doctor-summary.ts because it's a
  >  render concern (longer than the card's one-line summary) and
  >  the SDK seam stays focused on the `{name, status, detail}`
  >  triple."

  But neither function uses any rendering primitive. They return
  `string` and `readonly string[]`. The "render concern" framing
  is post-hoc.

WHY IT'S A PROBLEM:
  - Discoverability: a developer adding a new doctor check via
    src/doctor-summary.ts has to remember to also touch
    src/cli/tui/popups/doctor.tsx for the popup remediation hint.
    That's two places per check; the second site has no compiler
    enforcement (forgetting drops to the `default` branch which
    yanks `mu doctor` and a single fallback paragraph).
  - The one-line "yank a command for this check" mapping
    (`yankCommandForCheck`) is potentially useful from `mu doctor`
    too — printing "remediation: mu agent list" inline in the
    doctor textual output. Today only the TUI popup gets it.
  - Tests that should live next to doctor-summary's behaviour
    (does every check have a remediation? what's the fallback?)
    live in the popup test file, mixed with popup-rendering
    assertions.

PROPOSED FIX:
  Move both functions into src/doctor-summary.ts:

      export function yankCommandForCheck(check: Pick<DoctorCheck, "name" | "status">): string;
      export function remediationParagraph(check: DoctorCheck): readonly string[];

  Re-export from src/index.ts for SDK consumers. Update doctor
  popup to import from doctor-summary (single seam already
  imported via loadDoctorChecks). Move the small unit tests for
  these two functions to a dedicated doctor-summary test file
  (or extend the existing one).

  The popup-only `renderDrillBody` (which formats the drill
  multi-line body) STAYS in the popup — it is genuinely a render
  concern (interleaves the summary + status + detail + the
  separator lines).

EFFORT NOTE:
  ~0.15d. Pure refactor; no user-visible change. Catches the
  "second touchpoint" risk for future check additions.
  The `yankCommandForCheck` switch on
  schema/schema_version/journal_mode/foreign_keys returns a
  `# ...` comment which already handles "no actionable mutation"
  defensively.

  Side benefit: lets `mu doctor` CLI optionally print the
  remediation paragraph inline (a separate ROADMAP candidate but
  newly possible).
```

### #2 by "worker-4", 2026-05-13T13:27:47.546Z

```
CLOSE: ce11022: yank/remediation moved to doctor-summary; popup imports them
```
