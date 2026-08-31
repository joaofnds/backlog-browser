import type { ChildProcess, LaunchSpec } from "./child.ts";
import { deferred } from "./deferred.ts";

export class FakeChild implements ChildProcess {
	public readonly exited: Promise<number>;
	public killed = false;

	private stderr = "";
	private stubborn = false;
	private readonly settle: (code: number) => void;

	public constructor(public readonly spec: LaunchSpec) {
		const exit = deferred<number>();
		this.exited = exit.promise;
		this.settle = exit.settle;
	}

	public stderrTail(): string {
		return this.stderr;
	}

	public kill(): void {
		if (this.stubborn) {
			return;
		}

		this.killed = true;
		this.settle(0);
	}

	public terminate(): void {
		this.killed = true;
		this.settle(0);
	}

	public ignoresTermination(): void {
		this.stubborn = true;
	}

	public crash(stderr: string, code = 1): void {
		this.stderr = stderr;
		this.settle(code);
	}
}
