import type { Project } from "../discovery/project.ts";
import {
  type ChildLauncher,
  type ChildProcess,
  isPortCollision,
  type ReadinessProbe,
  urlFor,
} from "./child.ts";

export const MAX_PORT_ATTEMPTS = 3;

/**
 * `reuse` asks for the port this project bound last time, which is what keeps its board's
 * `localStorage` alive across hub runs. A retry clears it, or a collision would repeat forever.
 */
export type PortRequest = { path: string; reuse: boolean };
export type PortAllocator = (request: PortRequest) => Promise<number>;

export type Activation =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "ready"; port: number; url: string }
  | { status: "failed"; error: string; stderr?: string };

type Entry = {
  readonly project: Project;
  child: ChildProcess | null;
  port: number;
  activation: Activation;
  lastUsedAt: number;
  settling: Promise<void>;
};

type Failure = { kind: "collision" } | { kind: "exited"; code: number } | { kind: "timeout" };

type Outcome = { kind: "ready" } | Failure;

export class Supervisor {
  private readonly launch: ChildLauncher;
  private readonly probe: ReadinessProbe;
  private readonly portFor: PortAllocator;
  private readonly idleTimeoutMs: number;
  private readonly readyTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;

  private readonly entries = new Map<string, Entry>();
  private stopped = false;

  constructor(props: {
    launch: ChildLauncher;
    probe: ReadinessProbe;
    portFor: PortAllocator;
    idleTimeoutMs: number;
    readyTimeoutMs: number;
    pollIntervalMs?: number;
    now?: () => number;
  }) {
    this.launch = props.launch;
    this.probe = props.probe;
    this.portFor = props.portFor;
    this.idleTimeoutMs = props.idleTimeoutMs;
    this.readyTimeoutMs = props.readyTimeoutMs;
    this.pollIntervalMs = props.pollIntervalMs ?? 250;
    this.now = props.now ?? Date.now;
  }

  async activate(project: Project): Promise<Activation> {
    if (this.stopped) return { status: "failed", error: "The hub is shutting down." };

    const warm = this.entries.get(project.slug);
    if (warm && warm.activation.status !== "failed") {
      warm.lastUsedAt = this.now();

      return warm.activation;
    }

    if (warm) this.discard(warm);

    const entry: Entry = {
      project,
      child: null,
      port: 0,
      activation: { status: "starting" },
      lastUsedAt: this.now(),
      settling: Promise.resolve(),
    };
    this.entries.set(project.slug, entry);

    try {
      await this.spawn(entry, { reuse: true });
    } catch (cause) {
      entry.activation = this.portFailure(entry, cause);

      return entry.activation;
    }
    entry.settling = this.supervise(entry, 1);

    return { status: "starting" };
  }

  statusOf(project: Project): Activation {
    return this.entries.get(project.slug)?.activation ?? { status: "idle" };
  }

  /** The shell names its on-screen project every status poll; that report is what keeps it warm. */
  touch(project: Project): void {
    const entry = this.entries.get(project.slug);
    if (entry) entry.lastUsedAt = this.now();
  }

  settled(project: Project): Promise<void> {
    return this.entries.get(project.slug)?.settling ?? Promise.resolve();
  }

  stopIdle(): void {
    if (this.idleTimeoutMs === 0) return;

    const cutoff = this.now() - this.idleTimeoutMs;
    for (const entry of [...this.entries.values()]) {
      if (entry.lastUsedAt <= cutoff) this.discard(entry);
    }
  }

  /** Children stay listed until they exit, so a `terminate` racing this still finds them. */
  async shutdown(): Promise<void> {
    this.stopped = true;

    const children = this.children();
    for (const child of children) child.kill();
    await Promise.all(children.map((child) => child.exited));

    this.entries.clear();
  }

  terminate(): void {
    this.stopped = true;

    for (const child of this.children()) child.terminate();
    this.entries.clear();
  }

  private children(): ChildProcess[] {
    return [...this.entries.values()]
      .map((entry) => entry.child)
      .filter((child): child is ChildProcess => child !== null);
  }

  private async spawn(entry: Entry, options: { reuse: boolean }): Promise<void> {
    const port = await this.portFor({ path: entry.project.path, reuse: options.reuse });
    if (this.stopped) {
      entry.child = null;
      return;
    }

    entry.port = port;
    entry.child = this.launch({ cwd: entry.project.path, port: entry.port });
  }

  private async supervise(entry: Entry, attempt: number): Promise<void> {
    const child = entry.child;
    if (child === null) return;

    const outcome = await this.waitForReady(child, entry.port);

    if (outcome.kind === "ready") {
      entry.activation = { status: "ready", port: entry.port, url: urlFor(entry.port) };
      this.watchForCollapse(entry, child);
      return;
    }

    if (outcome.kind === "collision" && attempt < MAX_PORT_ATTEMPTS) {
      try {
        await this.spawn(entry, { reuse: false });
      } catch (cause) {
        entry.activation = this.portFailure(entry, cause);
        return;
      }
      return this.supervise(entry, attempt + 1);
    }

    entry.activation = this.failure(entry, child, outcome);
  }

  private portFailure(entry: Entry, cause: unknown): Activation {
    const reason = cause instanceof Error ? cause.message : String(cause);

    return {
      status: "failed",
      error: `Could not get a port for ${entry.project.name}: ${reason}`,
    };
  }

  private failure(entry: Entry, child: ChildProcess, outcome: Failure): Activation {
    const stderr = child.stderrTail();
    const name = entry.project.name;

    if (outcome.kind === "timeout") {
      const seconds = Math.round(this.readyTimeoutMs / 1000);

      return failed(`${name} did not answer on port ${entry.port} within ${seconds}s.`, stderr);
    }

    if (outcome.kind === "collision") {
      return failed(
        `Could not find a free port for ${name} after ${MAX_PORT_ATTEMPTS} attempts.`,
        stderr,
      );
    }

    return failed(`\`backlog browser\` for ${name} exited with code ${outcome.code}.`, stderr);
  }

  private watchForCollapse(entry: Entry, child: ChildProcess): void {
    child.exited.then((code) => {
      if (this.entries.get(entry.project.slug)?.child !== child) return;

      entry.activation = this.failure(entry, child, { kind: "exited", code });
    });
  }

  private async waitForReady(child: ChildProcess, port: number): Promise<Outcome> {
    const deadline = this.now() + this.readyTimeoutMs;
    let exitCode: number | null = null;
    child.exited.then((code) => {
      exitCode = code;
    });

    while (this.now() < deadline) {
      if (await this.probe(port)) return { kind: "ready" };

      if (exitCode !== null) {
        return isPortCollision(child.stderrTail())
          ? { kind: "collision" }
          : { kind: "exited", code: exitCode };
      }

      await Bun.sleep(this.pollIntervalMs);
    }

    return { kind: "timeout" };
  }

  private discard(entry: Entry): void {
    this.entries.delete(entry.project.slug);
    entry.child?.kill();
  }
}

function failed(error: string, stderr: string): Activation {
  return { status: "failed", error, stderr: stderr === "" ? undefined : stderr };
}
