import { basename } from "node:path";
import { captureGitCommit, checkCwdCanaries, ensureArtifactCanary, type ArtifactCanary } from "./canaries.ts";
import { computeIdentity } from "./identity.ts";
import { writeRawEvent, type RawEventPaths } from "./raw-store.ts";

/**
 * Live capture (ticket #3, spec §5.1/§15.1): binds a session's identity,
 * git-commit canary, and artifact canary at session start, then writes a
 * raw event (plaintext mirror + redacted evidence + provenance) for every
 * user input and assistant turn.
 */

export interface CaptureDeps {
  root: string; // memory root (raw/ lives under here)
  agentDir: string; // pi agent dir (artifact canary lives here, outside root)
  cwd: string;
  timezone: string;
  sessionStartIso: string;
}

export class SessionCapture {
  readonly identity: string;
  private readonly deps: CaptureDeps;
  private readonly gitCommit: string;
  private readonly artifact: ArtifactCanary;
  private lastUserText: string | null = null;

  constructor(deps: CaptureDeps) {
    this.deps = deps;
    this.identity = computeIdentity(deps.cwd, basename(deps.cwd), deps.sessionStartIso);
    this.gitCommit = captureGitCommit(deps.cwd);
    this.artifact = ensureArtifactCanary(deps.agentDir);
  }

  /** Latest user input text (from the `input` event). */
  onInput(text: string): void {
    this.lastUserText = text;
  }

  /** Write the user + assistant raw events for a completed turn. */
  onTurnEnd(turnIndex: number, assistantTexts: string[], toolResultTexts: string[]): RawEventPaths[] {
    const written: RawEventPaths[] = [];
    const canaryBase = {
      gitCommit: this.gitCommit,
      artifactPath: this.artifact.path,
      artifactSha256: this.artifact.sha256,
    };
    if (this.lastUserText !== null) {
      const cwd = checkCwdCanaries(this.lastUserText, this.deps.cwd);
      written.push(
        writeRawEvent({
          root: this.deps.root,
          identity: this.identity,
          timezone: this.deps.timezone,
          turnIndex,
          role: "user",
          texts: [this.lastUserText],
          canaries: { ...canaryBase, cwdPrefix: cwd.prefix, cwdSuffix: cwd.suffix },
        }),
      );
      this.lastUserText = null;
    }
    const texts = [...assistantTexts, ...toolResultTexts];
    if (texts.length > 0) {
      written.push(
        writeRawEvent({
          root: this.deps.root,
          identity: this.identity,
          timezone: this.deps.timezone,
          turnIndex,
          role: "assistant",
          texts,
          canaries: { ...canaryBase, cwdPrefix: false, cwdSuffix: false },
        }),
      );
    }
    return written;
  }
}
