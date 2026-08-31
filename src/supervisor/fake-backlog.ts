import type {
	ChildLauncher,
	ChildProcess,
	LaunchSpec,
	ReadinessProbe,
} from "./child.ts";
import { FakePortSpace } from "./fake-port-space.ts";
import type { PortAllocator } from "./supervisor.ts";

export class FakeChild implements ChildProcess {
	readonly exited: Promise<number>;
	killed = false;

	private stderr = "";
	private stubborn = false;
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
		if (this.stubborn) {
			return;
		}

		this.killed = true;
		this.settle(0);
	}

	terminate(): void {
		this.killed = true;
		this.settle(0);
	}

	ignoresTermination(): void {
		this.stubborn = true;
	}

	crash(stderr: string, code = 1): void {
		this.stderr = stderr;
		this.settle(code);
	}
}

export class FakeBacklog {
	readonly launches: LaunchSpec[] = [];
	private readonly kernel = new FakePortSpace();
	private readonly children: FakeChild[] = [];
	private readonly listening = new Set<number>();
	private readonly remembered = new Map<string, number>();
	private refusal: string | null = null;
	private everyPortListens = false;

	launch: ChildLauncher = (spec) => {
		this.launches.push(spec);
		const child = new FakeChild(spec);
		this.children.push(child);

		if (this.kernel.isTaken(spec.port)) {
			queueMicrotask(() =>
				child.crash(`error: EADDRINUSE: port ${spec.port} is in use`),
			);
		}

		return child;
	};

	probe: ReadinessProbe = async (port) =>
		this.listening.has(port) ||
		(this.everyPortListens && !this.kernel.isTaken(port));

	allocatePort = this.kernel.allocate;

	portFor: PortAllocator = async ({ path, reuse }) => {
		if (this.refusal !== null) {
			throw new Error(this.refusal);
		}

		const port = await this.allocatePort(
			reuse ? (this.remembered.get(path) ?? 0) : 0,
		);
		this.remembered.set(path, port);

		return port;
	};

	occupy(...ports: number[]): void {
		this.kernel.occupy(...ports);
	}

	occupyNext(count: number): void {
		this.kernel.occupyNext(count);
	}

	refusePorts(reason: string): void {
		this.refusal = reason;
	}

	grantPorts(): void {
		this.refusal = null;
	}

	answerOn(port: number): void {
		this.listening.add(port);
	}

	/** Every unoccupied port answers, so a test survives the child landing wherever it retries to. */
	answersAnywhere(): void {
		this.everyPortListens = true;
	}

	childAt(index: number): FakeChild {
		const child = this.children[index];
		if (!child) {
			throw new Error(`no child launched at index ${index}`);
		}

		return child;
	}

	childFor(cwd: string): FakeChild {
		const child = this.children.findLast(
			(candidate) => candidate.spec.cwd === cwd,
		);
		if (!child) {
			throw new Error(`no child launched for ${cwd}`);
		}

		return child;
	}

	get live(): FakeChild[] {
		return this.children.filter((child) => !child.killed);
	}
}
