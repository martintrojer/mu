// mu — multiplexer backend dispatcher.

export { activeMux, detectMux, muxByName, resetMux, setMuxForTests } from "./detect.js";
export { tmuxBackend } from "./tmux.js";
export {
  type CaptureOptions,
  type MuxBackend,
  type MuxBackendName,
  MuxError,
  type MuxPane,
  type MuxSession,
  type MuxWindow,
  type NewSessionOptions,
  type NewSessionWithPaneOptions,
  type NewWindowOptions,
  NoMultiplexerError,
  PaneNotFoundError,
  type SendOptions,
  type SendWarning,
  type SplitWindowOptions,
} from "./types.js";
