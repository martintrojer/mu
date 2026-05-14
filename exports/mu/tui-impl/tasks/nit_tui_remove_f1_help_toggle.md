---
id: "nit_tui_remove_f1_help_toggle"
workstream: "tui-impl"
status: CLOSED
impact: 30
effort_days: 0.05
roi: 600.00
owner: null
created_at: "2026-05-11T16:41:11.308Z"
updated_at: "2026-05-11T19:00:02.274Z"
blocked_by: []
blocks: ["tui_impl_complete"]
---

# NIT: remove F1 as a help toggle alias — '?' is enough; F1 collides with terminal apps

## Notes (2)

### #1 by "π - mu", 2026-05-11T16:41:56.892Z

```
GOAL
----
Drop F1 as a help-toggle alias. Keep '?' as the sole help binding.

WHY
---
F1 is awkward in many terminals (function keys are remapped, eaten
by tmux/screen, or fire OS-level help). '?' is the canonical help
binding in lazygit / btop / k9s / vim and works everywhere. Two
keys for the same action is friction in the docs/help/status-bar
without enough payoff.

LINE-PRECISE EDITS
------------------
1. src/cli/tui/keys.ts:81
     - if (input === \"?\" || key.f1) return { kind: \"toggleHelp\" };
     + if (input === \"?\")            return { kind: \"toggleHelp\" };

2. src/cli/tui/keys.ts:63
     Drop the optional `f1?: boolean;` field from the InkKey type if
     no other dispatcher reads it. (use-popup-filter.tsx:117 also
     reads key.f1 — check + remove from that read too if F1 is no
     longer special anywhere.)

3. src/cli/tui/use-popup-filter.tsx:117
     The filter-edit reducer treats key.f1 as a control key (so it's
     not appended to the query). With F1 no longer a control key
     anywhere in the TUI, it simply becomes \"unhandled\" — but the
     printable-char filter already only accepts ASCII 32..126 + space,
     so F1 (which ink reports as input=\"\" + key.f1=true) was never
     printable. SAFE to drop the key.f1 check from this guard.

4. src/cli/tui/help.tsx:39
     - <HelpRow keys=\"?/F1\" effect=\"toggle this overlay\" />
     + <HelpRow keys=\"?\"    effect=\"toggle this overlay\" />

5. src/cli/tui/status-bar.tsx:84
     - return \"1-4 toggle · !@#$ popup · ?/F1 help · q quit · +/- tick · r refresh\";
     + return \"1-4 toggle · !@#$ popup · ? help · q quit · +/- tick · r refresh\";
   (also see sibling task nit_tui_status_bar_card_range — '1-4' →
   '1-9'; resolve the merge with the OTHER task's wider range.)

6. src/cli/tui/status-bar.tsx:111
     - <Text dimColor>popup ·</Text> <Key>?/F1</Key> <Text dimColor>help ·</Text>
     + <Text dimColor>popup ·</Text> <Key>?</Key>    <Text dimColor>help ·</Text>

7. src/cli/tui/app.tsx:8 (comment)
     -   - Help overlay (?/F1)
     +   - Help overlay (?)

8. src/cli/tui/keys.ts:22 (comment)
     -   ? / F1      toggle help overlay
     +   ?           toggle help overlay

DOCS
----
- skills/mu/SKILL.md TUI keymap (if it lists F1): drop F1.
- docs/USAGE_GUIDE.md TUI section (if it lists F1): drop F1.
- CHANGELOG.md (under v0.4.0): bullet under TUI changes.

TESTS
-----
- test/tui-keys.test.ts: any test asserting key.f1 → toggleHelp
  needs to be removed (or rewritten for '?' only).
- test/tui-status-bar.test.ts: assertion that the dashboard hint
  string contains '?/F1' needs updating to '?'.
- test/tui-use-popup-filter.test.ts: any case asserting F1 is
  filtered out of editing-mode appends needs to be removed (F1 is
  no longer in the explicit guard list, it's just naturally
  non-printable).

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- 1500 LOC hard cap per file (this is a removal, no growth).
- Conventional commit prefix: tui:
- Four greens before commit.
- Suggested commit:
    tui: drop F1 as a help alias; keep '?'

OUT OF SCOPE
------------
- Don't remove '?' itself.
- Don't change any other keybinding.

⚠️ FINAL ACTION ⚠️
After committing, run from the workspace dir:
    mu task close nit_tui_remove_f1_help_toggle -w tui-impl --evidence \"<sha + summary>\"
```

### #2 by "worker-3", 2026-05-11T19:00:02.274Z

```
CLOSE: d163e9d — drop F1 as help alias across keys.ts/help.tsx/status-bar.tsx/use-popup-filter.tsx/app.tsx; ? remains canonical (1626 tests pass)
```
