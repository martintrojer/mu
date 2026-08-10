// mu — tmux substrate (back-compat re-export hub).
//
// The tmux implementation moved to src/mux/tmux.ts when the MuxBackend
// interface was extracted, so mu could grow a second multiplexer. This
// file preserves the historical `import { ... } from "./tmux.js"`
// surface — 12 src modules and 47 test files import it directly, and
// churning them in the same commit as the extraction would have made
// the diff unreviewable.
//
// NEW CODE SHOULD IMPORT `./mux.js` and go through `activeMux()`.
// Importing this module pins you to tmux specifically, which is correct
// only for genuinely tmux-only concerns (the `MU_TMUX_SOCKET` test
// isolation seam, `mu doctor`'s tmux version probe).
//
// Migrating the call sites is tracked by mux-callsite-migration.

export * from "./mux/tmux.js";
