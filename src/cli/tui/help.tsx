// Help overlay (?). Renders the keymap summary table from
// design_global_keymap as a static reference. Per design_help_overlay
// (workstream `tui`).
//
// Aesthetic: rounded box `╭─ keys ───╮` matching the cards' family.
//
// In v0 the help overlay always shows the same content (global +
// in-popup convention). Per-popup verbs are documented inline in the
// popup itself; surfacing them in a context-sensitive help overlay
// is a v0.next refinement.

import { Box, Text } from "ink";
import { superscriptDigit } from "./glyphs.js";

// Cards 1..9 visualised the same way they appear in each card's top
// border line (per feat_card_header_digit_prefix). Slots 5/6/7/8/9
// were promoted by feat_card_5_workspaces, feat_card_6_inprogress,
// feat_card_7_blocked, feat_tui_commits_card, and feat_card_9_doctor;
// all reserved digit slots are now filled (slot 0 stays reserved by
// convention, no promotion task today).
const CARD_DIGITS = `${superscriptDigit(1)}${superscriptDigit(2)}${superscriptDigit(3)}${superscriptDigit(4)}${superscriptDigit(5)}${superscriptDigit(6)}${superscriptDigit(7)}${superscriptDigit(8)}${superscriptDigit(9)}`;

export function Help(): JSX.Element {
  return (
    <Box flexDirection="row" gap={2}>
      <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
        <Text bold color="cyan">
          keys · dashboard
        </Text>
        <HelpRow
          keys={CARD_DIGITS}
          effect="toggle Agents/Tracks/Ready/Log/Workspaces/In-progress/Blocked/Commits/Doctor (1-9)"
        />
        <HelpRow keys="g" effect="DAG popup" />
        <HelpRow keys="l" effect="commits popup" />
        <HelpRow keys="Shift 1-9" effect="open numbered popup (Shift+8 = Recent)" />
        <HelpRow keys="+/=" effect="tick faster (floor 100ms)" />
        <HelpRow keys="-" effect="tick slower (ceiling 10s)" />
        <HelpRow keys="0" effect="reset tick to 1s" />
        <HelpRow keys="r/F5" effect="refresh now" />
        <HelpRow keys="?" effect="toggle this overlay" />
        <HelpRow keys="q/Q" effect="quit (Ctrl-C also)" />
        <HelpRow keys="c" effect="clear footer (last yank)" />
        <HelpRow keys="Tab / Shift-Tab" effect="next / previous workstream tab (multi-ws)" />
      </Box>
      <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
        <Text bold color="cyan">
          keys · in popup
        </Text>
        <HelpRow keys="j / ↓" effect="move selection down" />
        <HelpRow keys="k / ↑" effect="move selection up" />
        <HelpRow keys="g / G" effect="first / last row" />
        <HelpRow keys="Ctrl-D / Ctrl-U" effect="half-page down / up" />
        <HelpRow keys="PgDn / PgUp" effect="full-page down / up" />
        <HelpRow keys="/" effect="filter (incremental substring; Esc cancel, Enter commit)" />
        <HelpRow keys="n / N" effect="next / prev match (v0.next)" />
        <HelpRow keys="y" effect="yank action for focused row" />
        <HelpRow keys="Esc / q" effect="close popup → return to dashboard" />
        <HelpRow keys="?" effect="toggle this overlay" />
        <HelpRow keys="(any letter)" effect="per-popup verb (see popup footer)" />
      </Box>
    </Box>
  );
}

function HelpRow({ keys, effect }: { keys: string; effect: string }): JSX.Element {
  return (
    <Box>
      <Box width={20}>
        <Text color="yellow">{keys}</Text>
      </Box>
      <Text dimColor>{effect}</Text>
    </Box>
  );
}
