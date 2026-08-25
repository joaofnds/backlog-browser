import type { DiscoveryCache } from "./cache.ts";
import { findProjectPaths, type ProjectFinder, readProjects } from "./discovery.ts";
import type { Project } from "./project.ts";

export class ProjectRegistry {
  readonly root: string;
  readonly depth: number;
  private readonly cache: DiscoveryCache;
  private readonly walk: ProjectFinder;
  private discovered: Project[] = [];

  constructor(props: {
    root: string;
    depth: number;
    cache: DiscoveryCache;
    find?: ProjectFinder;
  }) {
    this.root = props.root;
    this.depth = props.depth;
    this.cache = props.cache;
    this.walk = props.find ?? findProjectPaths;
  }

  async load(): Promise<readonly Project[]> {
    const cached = await this.cache.read(this.root, this.depth);
    if (cached === null) return this.refresh();

    this.discovered = await readProjects(cached);
    if (this.discovered.length !== cached.length) await this.save();

    return this.discovered;
  }

  async refresh(): Promise<readonly Project[]> {
    this.discovered = await readProjects(await this.walk({ root: this.root, depth: this.depth }));
    await this.save();

    return this.discovered;
  }

  all(): readonly Project[] {
    return this.discovered;
  }

  find(slug: string): Project | undefined {
    return this.discovered.find((project) => project.slug === slug);
  }

  private async save(): Promise<void> {
    await this.cache.write(
      this.root,
      this.depth,
      this.discovered.map((project) => project.path),
    );
  }
}
