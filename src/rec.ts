/**
 * Facade over `src/recorder/`.
 *
 * The recorder grew from one module wrapping an external bash script into a
 * small directory with two backends. This file stays so that `record.ts`,
 * `index.ts` and the recording e2e keep importing `./rec.js`, and so that the
 * import path still names the thing rather than its implementation.
 */
export {
  findRunningCaptures,
  importSessionEnv,
  previewCommand,
  RecCapabilityError,
  Recording,
  RecError,
  resolveBackend,
  SESSION_ENV_KEYS,
  startRecording,
  type RecOptions,
  type RecorderBackendName,
  type RecorderCapabilities,
  type RecTarget,
  type ResolvedBackend,
  type RunningCapture,
  type SessionEnvResult,
} from "./recorder/index.js";
