import type { ChildLauncher, LaunchSpec, ReadinessProbe } from "./child.ts";
import { FakeChild } from "./fake-child.ts";
import { FakePortSpace } from "./fake-port-space.ts";
import type { PortAllocator } from "./supervisor.ts";

export class FakeBacklog {
	public readonly launches: LaunchSpec[] = [];
	private readonly kernel = new FakePortSpace();
	private readonly children: FakeChild[] = [];
	private readonly listening = new Set<number>();
	private readonly remembered = new Map<string, number>();
	private refusal: string | null = null;
	private everyPortListens = false;

	public launch: ChildLauncher = (spec) => {
		this.launches.push(spec);
		const child = new FakeChild(spec);
		this.children.push(child);

		if (this.kernel.isTaken(spec.port)) {
			queueMicrotask(() => {
				child.crash(`error: EADDRINUSE: port ${spec.port} is in use`);
			});
		}

		return child;
	};

	public probe: ReadinessProbe = (port) =>
		Promise.resolve(
			this.listening.has(port) ||
				(this.everyPortListens && !this.kernel.isTaken(port)),
		);

	public allocatePort = this.kernel.allocate;

	public portFor: PortAllocator = async ({ path, reuse }) => {
		if (this.refusal !== null) {
			throw new Error(this.refusal);
		}

		const port = await this.allocatePort(
			reuse ? (this.remembered.get(path) ?? 0) : 0,
		);
		this.remembered.set(path, port);

		return port;
	};

	public occupy(...ports: readonly number[]): void {
		this.kernel.occupy(...ports);
	}

	public occupyNext(count: number): void {
		this.kernel.occupyNext(count);
	}

	public refusePorts(reason: string): void {
		this.refusal = reason;
	}

	public grantPorts(): void {
		this.refusal = null;
	}

	public answerOn(port: number): void {
		this.listening.add(port);
	}

	/** Every unoccupied port answers, so a test survives the child landing wherever it retries to. */
	public answersAnywhere(): void {
		this.everyPortListens = true;
	}

	public childAt(index: number): FakeChild {
		const child = this.children[index];
		if (!child) {
			throw new Error(`no child launched at index ${index}`);
		}

		return child;
	}

	public childFor(cwd: string): FakeChild {
		const child = this.children.findLast(
			(candidate) => candidate.spec.cwd === cwd,
		);
		if (!child) {
			throw new Error(`no child launched for ${cwd}`);
		}

		return child;
	}

	public get live(): FakeChild[] {
		return this.children.filter((child) => !child.killed);
	}
}
