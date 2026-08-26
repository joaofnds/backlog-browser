import type { ChildLauncher, ChildProcess, LaunchSpec, ReadinessProbe } from "./child.ts";
import type { PortAllocator } from "./supervisor.ts";

export class FakeChild implements ChildProcess {
  readonly pid = Math.floor(Math.random() * 100_000);
  readonly exited: Promise<number>;
  killed = false;

  private stderr = "";
  private settle!: (code: number) => void;

  constructor(readonly spec: LaunchSpec) {
    this.exited = new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  stderrTail(): string {
    return this.stderr;
  }

  kill(): void {
    this.killed = true;
    this.settle(0);
  }

  terminate(): void {
    this.kill();
  }

  crash(stderr: string, code = 1): void {
    this.stderr = stderr;
    this.settle(code);
  }
}

export class FakeBacklog {
  readonly launches: LaunchSpec[] = [];
  private readonly children: FakeChild[] = [];
  private readonly listening = new Set<number>();
  private readonly remembered = new Map<string, number>();
  private occupied = new Set<number>();
  private nextPort = 40_000;

  launch: ChildLauncher = (spec) => {
    this.launches.push(spec);
    const child = new FakeChild(spec);
    this.children.push(child);

    if (this.occupied.has(spec.port)) {
      queueMicrotask(() => child.crash(`error: EADDRINUSE: port ${spec.port} is in use`));
    }

    return child;
  };

  probe: ReadinessProbe = async (port) => this.listening.has(port);

  /** Stands in for the kernel: a free preferred port is honoured, anything else is the next one up. */
  allocatePort = async (preferred = 0): Promise<number> => {
    if (preferred !== 0 && !this.occupied.has(preferred)) return preferred;

    this.nextPort += 1;

    return this.nextPort;
  };

  portFor: PortAllocator = async ({ path, reuse }) => {
    const port = await this.allocatePort(reuse ? (this.remembered.get(path) ?? 0) : 0);
    this.remembered.set(path, port);

    return port;
  };

  occupy(...ports: number[]): void {
    this.occupied = new Set(ports);
  }

  answerOn(port: number): void {
    this.listening.add(port);
  }

  childAt(index: number): FakeChild {
    const child = this.children[index];
    if (!child) throw new Error(`no child launched at index ${index}`);

    return child;
  }

  childFor(cwd: string): FakeChild {
    const child = this.children.findLast((candidate) => candidate.spec.cwd === cwd);
    if (!child) throw new Error(`no child launched for ${cwd}`);

    return child;
  }

  get live(): FakeChild[] {
    return this.children.filter((child) => !child.killed);
  }
}
