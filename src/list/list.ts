import type { Project } from "../discovery/project.ts";
import type { StoredRoot } from "../state/stored.ts";

export type OrderMode = "default" | "manual";

export interface ListedProject {
	readonly project: Project;
	readonly hidden: boolean;
}

export class ProjectList {
	public readonly mode: OrderMode;
	public readonly order: readonly string[];
	public readonly hidden: readonly string[];
	/** Paths the user picked by hand. The walk never produces them, so only this list keeps them. */
	public readonly added: readonly string[];

	public constructor(props: {
		readonly mode: OrderMode;
		readonly order: readonly string[];
		readonly hidden: readonly string[];
		readonly added: readonly string[];
	}) {
		this.mode = props.mode;
		this.order = props.order;
		this.hidden = props.hidden;
		this.added = props.added;
	}

	public static empty(): ProjectList {
		return new ProjectList({
			mode: "default",
			order: [],
			hidden: [],
			added: [],
		});
	}

	/** Built from what the state file recorded, which the schema has already made sense of. */
	public static from(stored: StoredRoot): ProjectList {
		return new ProjectList({
			mode: stored.mode,
			order: stored.order,
			hidden: stored.hidden,
			added: stored.added,
		});
	}

	public arrange(discovered: readonly Project[]): ListedProject[] {
		const hidden = new Set(this.hidden);
		const visible = discovered.filter((project) => !hidden.has(project.path));
		const concealed = discovered.filter((project) => hidden.has(project.path));

		return [
			...this.sequence(visible).map((project) => ({ project, hidden: false })),
			...concealed.map((project) => ({ project, hidden: true })),
		];
	}

	public hide(path: string): ProjectList {
		return new ProjectList({
			mode: this.mode,
			order: this.order.filter((stored) => stored !== path),
			hidden: this.hidden.includes(path) ? this.hidden : [...this.hidden, path],
			added: this.added,
		});
	}

	public show(path: string): ProjectList {
		return new ProjectList({
			mode: this.mode,
			order: this.order,
			hidden: this.hidden.filter((stored) => stored !== path),
			added: this.added,
		});
	}

	public add(path: string): ProjectList {
		return new ProjectList({
			mode: this.mode,
			order: this.order,
			hidden: this.hidden.filter((stored) => stored !== path),
			added: this.added.includes(path) ? this.added : [...this.added, path],
		});
	}

	/** Drops every trace of the path, because nothing else would put an added project back. */
	public drop(path: string): ProjectList {
		return new ProjectList({
			mode: this.mode,
			order: this.order.filter((stored) => stored !== path),
			hidden: this.hidden.filter((stored) => stored !== path),
			added: this.added.filter((stored) => stored !== path),
		});
	}

	/**
	 * `before` names the project the moved one lands in front of; `null` means the end. Anchoring on
	 * a neighbour rather than an index is what lets a stored path the walk did not find keep its
	 * slot: it is never named, so it rides along with whichever neighbour it sits behind.
	 */
	public move(props: {
		readonly path: string;
		readonly before: string | null;
		readonly discovered: readonly Project[];
	}): ProjectList {
		if (this.hidden.includes(props.path)) {
			return this;
		}

		const seeded =
			this.mode === "manual" ? this.order : this.defaultOrder(props.discovered);
		if (!seeded.includes(props.path)) {
			return this;
		}
		if (props.before !== null && !seeded.includes(props.before)) {
			return this;
		}

		const rest = seeded.filter((stored) => stored !== props.path);
		const at = props.before === null ? rest.length : rest.indexOf(props.before);

		return new ProjectList({
			mode: "manual",
			order: [...rest.slice(0, at), props.path, ...rest.slice(at)],
			hidden: this.hidden,
			added: this.added,
		});
	}

	public reset(): ProjectList {
		return new ProjectList({
			mode: "default",
			order: [],
			hidden: this.hidden,
			added: this.added,
		});
	}

	public toJSON(): {
		mode: OrderMode;
		order: readonly string[];
		hidden: readonly string[];
		added: readonly string[];
	} {
		return {
			mode: this.mode,
			order: this.order,
			hidden: this.hidden,
			added: this.added,
		};
	}

	private sequence(visible: readonly Project[]): Project[] {
		if (this.mode === "default") {
			return [...visible];
		}

		const byPath = new Map(visible.map((project) => [project.path, project]));
		const ordered = new Set(this.order);

		return [
			...this.order
				.map((path) => byPath.get(path))
				.filter((project) => project !== undefined),
			...visible.filter((project) => !ordered.has(project.path)),
		];
	}

	private defaultOrder(discovered: readonly Project[]): string[] {
		const hidden = new Set(this.hidden);

		return discovered
			.filter((project) => !hidden.has(project.path))
			.map((project) => project.path);
	}
}
