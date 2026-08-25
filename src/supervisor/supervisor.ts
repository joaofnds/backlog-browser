import type { Project } from "../discovery/project.ts";
import {
  type ChildLauncher,
  type ChildProcess,
  isPortCollision,
  type ReadinessProbe,
  urlFor,
} from "./child.ts";

export const MAX_PORT_ATTEMPTS = 3;

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
  private readonly allocatePort: () => Promise<number>;
  private readonly maxChildren: number;
  private readonly idleTimeoutMs: number;
  private readonly readyTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;

  private readonly entries = new Map<string, Entry>();
  private activeSlug: string | null = null;
  private stopped = false;

  constructor(props: {
    launch: ChildLauncher;
    probe: ReadinessProbe;
    allocatePort: () => Promise<number>;
    maxChildren: number;
    idleTimeoutMs: number;
    readyTimeoutMs: number;
    pollIntervalMs?: number;
    now?: () => number;
  }) {
    this.launch = props.launch;
    this.probe = props.probe;
    this.allocatePort = props.allocatePort;
    this.maxChildren = props.maxChildren;
    this.idleTimeoutMs = props.idleTimeoutMs;
    this.readyTimeoutMs = props.readyTimeoutMs;
    this.pollIntervalMs = props.pollIntervalMs ?? 250;
    this.now = props.now ?? Date.now;
  }

  async activate(project: Project): Promise<Activation> {
    if (this.stopped) return { status: "failed", error: "The hub is shutting down." };

    this.activeSlug = project.slug;

    const warm = this.entries.get(project.slug);
    if (warm && warm.activation.status !== "failed") {
      warm.lastUsedAt = this.now();

      return warm.activation;
    }

    if (warm) this.discard(warm);
    this.evictBeyondCap();

    const entry: Entry = {
      project,
      child: null,
      port: 0,
      activation: { status: "starting" },
      lastUsedAt: this.now(),
      settling: Promise.resolve(),
    };
    this.entries.set(project.slug, entry);

    await this.spawn(entry);
    entry.settling = this.supervise(entry, 1);

    return { status: "starting" };
  }

  statusOf(project: Project): Activation {
    return this.entries.get(project.slug)?.activation ?? { status: "idle" };
  }

  settled(project: Project): Promise<void> {
    return this.entries.get(project.slug)?.settling ?? Promise.resolve();
  }

  stopIdle(): void {
    if (this.idleTimeoutMs === 0) return;

    const cutoff = this.now() - this.idleTimeoutMs;
    for (const entry of [...this.entries.values()]) {
      if (entry.project.slug === this.activeSlug) continue;
      if (entry.lastUsedAt <= cutoff) this.discard(entry);
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true;

    const children = [...this.entries.values()]
      .map((entry) => entry.child)
      .filter((child): child is ChildProcess => child !== null);
    this.entries.clear();

    for (const child of children) child.kill();
    await Promise.all(children.map((child) => child.exited));
  }

  terminate(): void {
    this.stopped = true;

    for (const entry of this.entries.values()) entry.child?.terminate();
    this.entries.clear();
  }

  private async spawn(entry: Entry): Promise<void> {
    entry.port = await this.allocatePort();
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
      await this.spawn(entry);
      return this.supervise(entry, attempt + 1);
    }

    entry.activation = this.failure(entry, child, outcome);
  }

  private failure(entry: Entry, child: ChildProcess, outcome: Failure): Activation {
    const stderr = child.stderrTail();
    const name = entry.project.name;

    if (outcome.kind === "timeout") {
      const seconds = Math.round(this.readyTimeoutMs / 1000);

      return {
        status: "failed",
        error: `${name} did not answer on port ${entry.port} within ${seconds}s.`,
        stderr: stderr === "" ? undefined : stderr,
      };
    }

    if (outcome.kind === "collision") {
      return {
        status: "failed",
        error: `Could not find a free port for ${name} after ${MAX_PORT_ATTEMPTS} attempts.`,
        stderr: stderr === "" ? undefined : stderr,
      };
    }

    return {
      status: "failed",
      error: `\`backlog browser\` for ${name} exited with code ${outcome.code}.`,
      stderr: stderr === "" ? undefined : stderr,
    };
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

  private evictBeyondCap(): void {
    while (this.entries.size >= this.maxChildren) {
      const stale = [...this.entries.values()]
        .filter((entry) => entry.project.slug !== this.activeSlug)
        .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
      if (!stale) return;

      this.discard(stale);
    }
  }

  private discard(entry: Entry): void {
    this.entries.delete(entry.project.slug);
    entry.child?.kill();
  }
}
