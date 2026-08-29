import { asRecord } from "../json.ts";
import { readRoots, writeJson } from "../json-store.ts";
import { findProjectPaths, readProjects } from "./discovery.ts";
import { Project } from "./project.ts";

type CachedScan = { depth: number; paths: string[] };

export class ProjectRegistry {
  readonly root: string;
  private currentDepth: number;
  private readonly file: string;
  private discovered: Project[] = [];
  private adopted: Project[] = [];

  constructor(props: { root: string; depth: number; file: string }) {
    this.root = props.root;
    this.currentDepth = props.depth;
    this.file = props.file;
  }

  get depth(): number {
    return this.currentDepth;
  }

  async load(): Promise<readonly Project[]> {
    const cached = await this.cachedScan();
    if (cached === null) return this.refresh();

    this.discovered = await readProjects(cached);
    if (this.discovered.length !== cached.length) await this.save();

    return this.all();
  }

  async refresh(depth = this.currentDepth): Promise<readonly Project[]> {
    this.currentDepth = depth;
    this.discovered = await readProjects(await findProjectPaths({ root: this.root, depth }));
    await this.save();

    return this.all();
  }

  /**
   * Paths the user picked by hand, merged into every later answer. They stay out of the discovery
   * cache: a walk rewrites it, and nothing in a walk would put them back.
   */
  async adopt(paths: readonly string[]): Promise<readonly Project[]> {
    this.adopted = await readProjects(paths);

    return this.all();
  }

  /** The paths the walk produced. Everything else in `all()` is there because the user added it. */
  walked(): ReadonlySet<string> {
    return new Set(this.discovered.map((project) => project.path));
  }

  all(): readonly Project[] {
    const known = new Set(this.discovered.map((project) => project.path));

    return [...this.discovered, ...this.adopted.filter((project) => !known.has(project.path))].sort(
      Project.byName,
    );
  }

  find(slug: string): Project | undefined {
    return this.all().find((project) => project.slug === slug);
  }

  /** The cache is keyed by depth, so a shallower saved walk misses rather than serving less. */
  private async cachedScan(): Promise<string[] | null> {
    const scan = asScan((await readRoots(this.file))[this.root]);
    if (scan === null || scan.depth !== this.currentDepth) return null;

    return scan.paths;
  }

  private async save(): Promise<void> {
    const roots = await readRoots(this.file);

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

function asScan(value: unknown): CachedScan | null {
  const stored = asRecord(value);
  if (stored === null) return null;

  const { depth, paths } = stored;
  if (typeof depth !== "number") return null;
  if (!Array.isArray(paths)) return null;
  if (!paths.every((path): path is string => typeof path === "string")) return null;

  return { depth, paths };
}
