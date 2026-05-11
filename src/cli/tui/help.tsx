// Help overlay (?/F1). Renders the keymap summary table from
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

// Cards 1..5 visualised the same way they appear in each card's top
// border line (per feat_card_header_digit_prefix). Slot 5 was promoted
// by feat_card_5_workspaces; remaining slots 6..9 stay reserved (per
// design_global_keymap) until each is promoted by its own feat task.
const CARD_DIGITS = `${superscriptDigit(1)}${superscriptDigit(2)}${superscriptDigit(3)}${superscriptDigit(4)}${superscriptDigit(5)}`;

export function Help(): JSX.Element {
  return (
    <Box flexDirection="row" gap={2}>
      <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
        <Text bold color="cyan">
          keys · dashboard
        </Text>
        <HelpRow keys={CARD_DIGITS} effect="toggle Agents/Tracks/Ready/Log/Workspaces (1-5)" />
        <HelpRow keys="!@#$" effect="open card popup (Shift+1..Shift+4 on US)" />
        <HelpRow keys="+/=" effect="tick faster (floor 100ms)" />
        <HelpRow keys="-" effect="tick slower (ceiling 10s)" />
        <HelpRow keys="0" effect="reset tick to 1s" />
        <HelpRow keys="r/F5" effect="refresh now" />
        <HelpRow keys="?/F1" effect="toggle this overlay" />
        <HelpRow keys="q/Q" effect="quit (Ctrl-C also)" />
        <HelpRow keys="c" effect="clear footer (last yank)" />
        <HelpRow keys="w" effect="workstream picker (v0.next)" />
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
        <HelpRow keys="/" effect="enter filter mode (v0.next)" />
        <HelpRow keys="n / N" effect="next / prev match" />
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
