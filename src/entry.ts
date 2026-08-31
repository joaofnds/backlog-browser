import type { ChildProcess } from "./child.ts";
import type { Project } from "./project.ts";
import type { Activation } from "./supervisor.ts";

/**
 * One project's child and what the hub currently believes about it. The state changes as the child
 * starts, answers or dies, so the transitions live here as named methods: callers ask the entry to
 * move, and nothing outside writes its fields.
 */
export class Entry {
	public readonly project: Project;
	private currentChild: ChildProcess | null = null;
	private currentPort = 0;
	private currentActivation: Activation = { status: "starting" };
	private usedAt: number;
	private settlingNow: Promise<void> = Promise.resolve();

	public constructor(project: Project, at: number) {
		this.project = project;
		this.usedAt = at;
	}

	public get child(): ChildProcess | null {
		return this.currentChild;
	}

	public get port(): number {
		return this.currentPort;
	}

	public get activation(): Activation {
		return this.currentActivation;
	}

	public get settling(): Promise<void> {
		return this.settlingNow;
	}

	public idleSince(cutoff: number): boolean {
		return this.usedAt <= cutoff;
	}

	public used(at: number): void {
		this.usedAt = at;
	}

	public running(child: ChildProcess, port: number): void {
		this.currentChild = child;
		this.currentPort = port;
	}

	public abandoned(): void {
		this.currentChild = null;
	}

	public settles(work: Promise<void>): void {
		this.settlingNow = work;
	}

	public became(activation: Activation): void {
		this.currentActivation = activation;
	}
}
