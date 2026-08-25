export const LOOPBACK = "127.0.0.1";
export const STDERR_TAIL_LINES = 25;
export const KILL_GRACE_MS = 2_000;

export type LaunchSpec = { cwd: string; port: number };

export interface ChildProcess {
  readonly pid: number;
  readonly exited: Promise<number>;
  stderrTail(): string;
  kill(): void;
  terminate(): void;
}

export type ChildLauncher = (spec: LaunchSpec) => ChildProcess;
export type ReadinessProbe = (port: number) => Promise<boolean>;

export function urlFor(port: number): string {
  return `http://${LOOPBACK}:${port}/`;
}

export function isPortCollision(stderr: string): boolean {
  return /EADDRINUSE|address already in use/i.test(stderr);
}

export function backlogLauncher(binary: string): ChildLauncher {
  return (spec) => new BacklogChild(binary, spec);
}

class BacklogChild implements ChildProcess {
  private readonly process: Bun.Subprocess<"ignore", "ignore", "pipe">;
  private readonly lines: string[] = [];
  private escalation: ReturnType<typeof setTimeout> | null = null;

  constructor(binary: string, spec: LaunchSpec) {
    this.process = Bun.spawn(
      [binary, "browser", "--port", String(spec.port), "--no-open", "--non-interactive"],
      {
        cwd: spec.cwd,
        env: { ...process.env, BACKLOG_CWD: spec.cwd },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        detached: true,
      },
    );

    this.collectStderr();
    this.exited.then(() => this.cancelEscalation());
  }

  get pid(): number {
    return this.process.pid;
  }

  get exited(): Promise<number> {
    return this.process.exited;
  }

  stderrTail(): string {
    return this.lines.join("");
  }

  kill(): void {
    if (this.escalation !== null) return;

    this.signalGroup("SIGTERM");
    this.escalation = setTimeout(() => this.signalGroup("SIGKILL"), KILL_GRACE_MS);
    this.escalation.unref?.();
  }

  terminate(): void {
    this.cancelEscalation();
    this.signalGroup("SIGKILL");
  }

  /**
   * `backlog` on PATH may be a wrapper that runs the real server as a grandchild; signalling the
   * spawned pid alone leaves that server listening. Hence `detached` above, and the whole group here.
   */
  private signalGroup(signal: NodeJS.Signals): void {
    try {
      process.kill(-this.process.pid, signal);
    } catch {
      this.process.kill(signal);
    }
  }

  private cancelEscalation(): void {
    if (this.escalation === null) return;

    clearTimeout(this.escalation);
    this.escalation = null;
  }

  private async collectStderr(): Promise<void> {
    const reader = this.process.stderr.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) return;

      this.lines.push(decoder.decode(value, { stream: true }));
      if (this.lines.length > STDERR_TAIL_LINES) this.lines.shift();
    }
  }
}

export const probeBacklogConfig: ReadinessProbe = async (port) => {
  try {
    const response = await fetch(`${urlFor(port)}api/config`, {
      signal: AbortSignal.timeout(1_000),
    });
    await response.body?.cancel();

    return response.ok;
  } catch {
    return false;
  }
};

export async function allocatePort(): Promise<number> {
  const probe = Bun.serve({
    hostname: LOOPBACK,
    port: 0,
    fetch: () => new Response(null, { status: 404 }),
  });
  const { port } = probe;
  await probe.stop(true);

  if (port === undefined) throw new Error("the kernel assigned no port to bind against");

  return port;
}
