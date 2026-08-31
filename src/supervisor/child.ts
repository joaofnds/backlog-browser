export const LOOPBACK = "127.0.0.1";
export const STDERR_TAIL_CHUNKS = 25;
export const KILL_GRACE_MS = 2000;

export interface LaunchSpec {
	cwd: string;
	port: number;
}

export interface ChildProcess {
	readonly exited: Promise<number>;
	stderrTail: () => string;
	kill: () => void;
	terminate: () => void;
}

export type ChildLauncher = (spec: LaunchSpec) => ChildProcess;
export type ReadinessProbe = (port: number) => Promise<boolean>;

export function urlFor(port: number): string {
	return `http://${LOOPBACK}:${port}/`;
}

export function isPortCollision(stderr: string): boolean {
	return /EADDRINUSE|address already in use/iu.test(stderr);
}

export function backlogLauncher(binary: string): ChildLauncher {
	return (spec) => new BacklogChild(binary, spec);
}

class BacklogChild implements ChildProcess {
	private readonly process: Bun.Subprocess<"ignore", "ignore", "pipe">;
	private readonly chunks: string[] = [];
	private escalation: ReturnType<typeof setTimeout> | null = null;

	public constructor(binary: string, spec: LaunchSpec) {
		this.process = Bun.spawn(
			[
				binary,
				"browser",
				"--port",
				String(spec.port),
				"--no-open",
				"--non-interactive",
			],
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
		void this.awaitExit();
	}

	public get exited(): Promise<number> {
		return this.process.exited;
	}

	private async awaitExit(): Promise<void> {
		await this.exited;
		this.cancelEscalation();
	}

	public stderrTail(): string {
		return this.chunks.join("");
	}

	public kill(): void {
		if (this.escalation !== null) {
			return;
		}

		this.signalGroup("SIGTERM");
		this.escalation = setTimeout(
			() => this.signalGroup("SIGKILL"),
			KILL_GRACE_MS,
		);
		this.escalation.unref?.();
	}

	public terminate(): void {
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
			try {
				this.process.kill(signal);
			} catch {
				// The process is already gone, which is the outcome the signal was for.
			}
		}
	}

	private cancelEscalation(): void {
		if (this.escalation === null) {
			return;
		}

		clearTimeout(this.escalation);
		this.escalation = null;
	}

	private async collectStderr(): Promise<void> {
		const reader = this.process.stderr.getReader();
		const decoder = new TextDecoder();

		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				return;
			}

			this.chunks.push(decoder.decode(value, { stream: true }));
			if (this.chunks.length > STDERR_TAIL_CHUNKS) {
				this.chunks.shift();
			}
		}
	}
}

export const probeBacklogConfig: ReadinessProbe = async (port) => {
	try {
		const response = await fetch(`${urlFor(port)}api/config`, {
			signal: AbortSignal.timeout(1000),
		});
		await response.body?.cancel();

		return response.ok;
	} catch {
		return false;
	}
};

/**
 * `preferred` is the port a project bound last time, and holding on to it is what keeps the child's
 * origin, and so its board's `localStorage`, stable across hub runs. Zero means the kernel picks.
 */
export async function allocatePort(preferred = 0): Promise<number> {
	const port =
		(preferred === 0 ? null : await bind(preferred)) ?? (await bind(0));

	if (port === null) {
		throw new Error("the kernel assigned no port to bind against");
	}

	return port;
}

async function bind(port: number): Promise<number | null> {
	let probe: Bun.Server<undefined>;
	try {
		probe = Bun.serve({
			hostname: LOOPBACK,
			port,
			fetch: () => new Response(null, { status: 404 }),
		});
	} catch {
		return null;
	}

	const bound = probe.port ?? null;
	await probe.stop(true);

	return bound;
}
