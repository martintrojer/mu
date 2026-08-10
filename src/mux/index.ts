// mu — multiplexer backend dispatcher.

export { activeMux, detectMux, muxByName, resetMux, setMuxForTests } from "./detect.js";
export {
  HerdrError,
  HerdrNotImplementedError,
  HerdrSyntaxError,
  herdrBackend,
  resetHerdrExecutor,
  setHerdrExecutor,
} from "./herdr.js";
export { tmuxBackend } from "./tmux.js";
export {
  type AttachTarget,
  type CaptureOptions,
  type MuxBackend,
  type MuxBackendName,
  type MuxCommand,
  type MuxDiagnostics,
  MuxError,
  type MuxHealth,
  type MuxPane,
  type MuxSession,
  type MuxWindow,
  type NewSessionOptions,
  type NewSessionWithPaneOptions,
  type NewWindowOptions,
  NoMultiplexerError,
  PaneNotFoundError,
  parseAgentNameFromTitle,
  type SendOptions,
  type SendWarning,
  type SplitWindowOptions,
} from "./types.js";
