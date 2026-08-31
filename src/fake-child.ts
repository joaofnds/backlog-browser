import type { ChildProcess, LaunchSpec } from "./child.ts";

export class FakeChild implements ChildProcess {
	public readonly exited: Promise<number>;
	public killed = false;

	private stderr = "";
	private stubborn = false;
	private settle!: (code: number) => void;

	public constructor(public readonly spec: LaunchSpec) {
		this.exited = new Promise((resolve) => {
			this.settle = resolve;
		});
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
