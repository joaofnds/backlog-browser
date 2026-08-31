import { readRoots, stateFile, writeJson } from "./json-store.ts";
import { ProjectList } from "./list.ts";
import { EMPTY_ROOT, storedRootSchema } from "./stored.ts";
import type { StoredRoot } from "./stored.ts";

interface RootState {
	readonly active: string | null;
	readonly list: ProjectList;
	readonly ports: Readonly<Record<string, number>>;
	readonly depth: number | null;
}

export class StateStore {
	private readonly file: string;
	private readonly root: string;
	private writes: Promise<unknown> = Promise.resolve();

	public constructor(props: { readonly file: string; readonly root: string }) {
		this.file = props.file;
		this.root = props.root;
	}

	public static default(root: string): StateStore {
		return new StateStore({ file: stateFile("state.json"), root });
	}

	public async lastActive(): Promise<string | null> {
		const state = await this.state();

		return state.active;
	}

	public async list(): Promise<ProjectList> {
		const state = await this.state();

		return state.list;
	}

	/** `null` is a depth never chosen, which is what lets a flag win without erasing a choice. */
	public async depth(): Promise<number | null> {
		const state = await this.state();

		return state.depth;
	}

	public async portFor(path: string): Promise<number | null> {
		const state = await this.state();

		return state.ports[path] ?? null;
	}

	public async remember(slug: string): Promise<void> {
		await this.update((current) => ({ ...current, active: slug }));
	}

	public async rememberDepth(depth: number): Promise<void> {
		await this.update((current) => ({ ...current, depth }));
	}

	public async rememberPort(path: string, port: number): Promise<void> {
		await this.update((current) => ({
			...current,
			ports: { ...current.ports, [path]: port },
		}));
	}

	public async updateList(
		change: (list: ProjectList) => ProjectList,
	): Promise<ProjectList> {
		const updated = await this.update((current) => ({
			...current,
			list: change(current.list),
		}));

		return updated.list;
	}

	private async state(): Promise<RootState> {
		const roots = await readRoots(this.file, storedRootSchema);

		return readRoot(roots[this.root]);
	}

	/**
	 * Every write is a read-modify-write of the whole file, so two of them in flight at once lose
	 * one update. Activating a project, reordering the list and claiming a port are separate writers,
	 * so queue them, and read the current state inside the queue rather than before joining it.
	 *
	 * Not `async`, and the `.then` is the reason: the queue tail has to be reassigned in the same
	 * tick as the call. Awaiting first lets a second caller join the queue before the first has
	 * extended it, and both then write from the same starting state. `store.test.ts` catches it.
	 */
	private update(
		change: (current: RootState) => RootState,
	): Promise<RootState> {
		const done = this.writes.then(() => this.apply(change));
		this.writes = done.catch(() => {});

		return done;
	}

	private async apply(
		change: (current: RootState) => RootState,
	): Promise<RootState> {
		const roots = await readRoots(this.file, storedRootSchema);
		const next = change(readRoot(roots[this.root]));

		await writeJson(this.file, {
			roots: {
				...roots,
				[this.root]: {
					active: next.active,
					...next.list.toJSON(),
					ports: next.ports,
					settings: { depth: next.depth },
				},
			},
		});

		return next;
	}
}

function readRoot(stored: StoredRoot | undefined): RootState {
	const recorded = stored ?? EMPTY_ROOT;

	return {
		active: recorded.active,
		list: ProjectList.from(recorded),
		ports: recorded.ports,
		depth: recorded.settings.depth,
	};
}
