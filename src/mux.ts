// mu — multiplexer backend hub.
//
// Concrete backends live in the cohesive src/mux/ cluster: one file per
// backend plus shared types and detection. This root file is the public
// `import { ... } from "./mux.js"` surface, mirroring src/vcs.ts.
//
// A "mux" is the terminal multiplexer that owns panes. Exactly one is
// active per mu invocation, resolved by `activeMux()`. Everything
// backend-specific — topology, the send protocol, capture, pane-id
// validation, identity fallback — lives behind `MuxBackend`.
//
// See docs/VOCABULARY.md § "mux backend" and docs/ARCHITECTURE.md
// § "Mux session topology".

export {
  type AttachTarget,
  activeMux,
  type CaptureOptions,
  detectMux,
  HerdrError,
  HerdrNotImplementedError,
  HerdrSyntaxError,
  herdrBackend,
  type MuxBackend,
  type MuxBackendName,
  type MuxCommand,
  type MuxDiagnostics,
  MuxError,
  type MuxHealth,
  type MuxPane,
  type MuxSession,
  type MuxWindow,
  muxByName,
  type NewSessionOptions,
  type NewSessionWithPaneOptions,
  type NewWindowOptions,
  NoMultiplexerError,
  PaneNotFoundError,
  parseAgentNameFromTitle,
  resetHerdrExecutor,
  resetMux,
  type SendOptions,
  type SendWarning,
  type SplitWindowOptions,
  setHerdrExecutor,
  setMuxForTests,
  tmuxBackend,
} from "./mux/index.js";
