import { z } from "zod";

import { readRoots, writeJson } from "./json-store.ts";
import { findProjectPaths, readProjects } from "./discovery.ts";
import { Project } from "./project.ts";

/**
 * What one walk left behind: the paths it found and the depth it reached. The depth is part of
 * the record because a shallower walk's answer must not be served for a deeper request.
 */
const scanSchema = z.object({
	depth: z.number().int(),
	paths: z.array(z.string()),
});

type CachedScan = z.infer<typeof scanSchema>;

export class ProjectRegistry {
	public readonly root: string;
	private currentDepth: number;
	private readonly file: string;
	private discovered: Project[] = [];
	private adopted: Project[] = [];

	public constructor(props: {
		readonly root: string;
		readonly depth: number;
		readonly file: string;
	}) {
		this.root = props.root;
		this.currentDepth = props.depth;
		this.file = props.file;
	}

	public get depth(): number {
		return this.currentDepth;
	}

	public async load(): Promise<readonly Project[]> {
		const cached = await this.cachedScan();
		if (cached === null) {
			return this.refresh();
		}

		this.discovered = await readProjects(cached);
		if (this.discovered.length !== cached.length) {
			await this.save();
		}

		return this.all();
	}

	public async refresh(depth = this.currentDepth): Promise<readonly Project[]> {
		this.currentDepth = depth;
		this.discovered = await readProjects(
			await findProjectPaths({ root: this.root, depth }),
		);
		await this.save();

		return this.all();
	}

	/**
	 * Paths the user picked by hand, merged into every later answer. They stay out of the discovery
	 * cache: a walk rewrites it, and nothing in a walk would put them back.
	 */
	public async adopt(paths: readonly string[]): Promise<readonly Project[]> {
		this.adopted = await readProjects(paths);

		return this.all();
	}

	/** The paths the walk produced. Everything else in `all()` is there because the user added it. */
	public walked(): ReadonlySet<string> {
		return new Set(this.discovered.map((project) => project.path));
	}

	public all(): readonly Project[] {
		const known = new Set(this.discovered.map((project) => project.path));

		return [
			...this.discovered,
			...this.adopted.filter((project) => !known.has(project.path)),
		].toSorted(Project.byName);
	}

	public find(slug: string): Project | undefined {
		return this.all().find((project) => project.slug === slug);
	}

	/** The cache is keyed by depth, so a shallower saved walk misses rather than serving less. */
	private async cachedScan(): Promise<string[] | null> {
		const roots = await readRoots(this.file, scanSchema);
		const scan = roots[this.root];
		if (scan === undefined || scan.depth !== this.currentDepth) {
			return null;
		}

		return scan.paths;
	}

	private async save(): Promise<void> {
		const roots = await readRoots(this.file, scanSchema);

		await writeJson(this.file, {
			roots: {
				...roots,
				[this.root]: {
					depth: this.currentDepth,
					paths: this.discovered.map((project) => project.path),
				},
			},
		});
	}
}
