import type { DiscoveryCache } from "./cache.ts";
import { findProjectPaths, type ProjectFinder, readProjects } from "./discovery.ts";
import { Project } from "./project.ts";

export class ProjectRegistry {
  readonly root: string;
  private currentDepth: number;
  private readonly cache: DiscoveryCache;
  private readonly walk: ProjectFinder;
  private discovered: Project[] = [];
  private adopted: Project[] = [];

  constructor(props: {
    root: string;
    depth: number;
    cache: DiscoveryCache;
    find?: ProjectFinder;
  }) {
    this.root = props.root;
    this.currentDepth = props.depth;
    this.cache = props.cache;
    this.walk = props.find ?? findProjectPaths;
  }

  get depth(): number {
    return this.currentDepth;
  }

  async load(): Promise<readonly Project[]> {
    const cached = await this.cache.read(this.root, this.currentDepth);
    if (cached === null) return this.refresh();

    this.discovered = await readProjects(cached);
    if (this.discovered.length !== cached.length) await this.save();

    return this.all();
  }

  async refresh(depth = this.currentDepth): Promise<readonly Project[]> {
    this.currentDepth = depth;
    this.discovered = await readProjects(await this.walk({ root: this.root, depth }));
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

  private async save(): Promise<void> {
    await this.cache.write(
      this.root,
      this.currentDepth,
      this.discovered.map((project) => project.path),
    );
  }
}
