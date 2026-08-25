import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DiscoveryCache } from "../discovery/cache.ts";
import type { Project } from "../discovery/project.ts";
import { ProjectRegistry } from "../discovery/registry.ts";
import { StateStore } from "../state/store.ts";
import { FakeBacklog } from "../supervisor/fake-backlog.ts";
import { Supervisor } from "../supervisor/supervisor.ts";
import { startHub } from "./server.ts";

export class HubHarness {
  private constructor(
    readonly root: string,
    private readonly registry: ProjectRegistry,
    readonly store: StateStore,
    readonly backlog: FakeBacklog,
    readonly supervisor: Supervisor,
    private readonly server: Bun.Server<undefined>,
  ) {}

  static async start(options: { depth?: number } = {}): Promise<HubHarness> {
    const root = await mkdtemp(join(tmpdir(), "backlog-browser-"));
    const cache = new DiscoveryCache({ file: join(root, ".state", "discovery.json") });
    const registry = new ProjectRegistry({ root, depth: options.depth ?? 3, cache });
    await registry.load();
    const store = new StateStore({ file: join(root, ".state", "state.json") });
    const backlog = new FakeBacklog();
    const supervisor = new Supervisor({
      launch: backlog.launch,
      probe: backlog.probe,
      allocatePort: backlog.allocatePort,
      maxChildren: 4,
      idleTimeoutMs: 0,
      readyTimeoutMs: 1_000,
      pollIntervalMs: 0,
    });

    return new HubHarness(
      root,
      registry,
      store,
      backlog,
      supervisor,
      startHub({ registry, store, supervisor, port: 0 }),
    );
  }

  projectFor(slug: string): Project {
    const project = this.registry.find(slug);
    if (!project) throw new Error(`no discovered project with slug ${slug}`);

    return project;
  }

  driver(): HubDriver {
    return new HubDriver(this.server.url.origin);
  }

  async addProject(name: string, directory = name): Promise<string> {
    const path = join(this.root, directory);
    await Bun.write(join(path, "backlog", "config.yml"), `project_name: "${name}"\n`);

    return path;
  }

  async stop(): Promise<void> {
    await this.supervisor.shutdown();
    await this.server.stop(true);
    await rm(this.root, { recursive: true, force: true });
  }
}

export type ProjectSummary = { slug: string; name: string; path: string; status: string };
export type Inventory = {
  root: string;
  depth: number;
  active: string | null;
  projects: ProjectSummary[];
};

export class HubDriver {
  constructor(readonly origin: string) {}

  async get(path: string): Promise<Response> {
    return fetch(`${this.origin}${path}`);
  }

  async projects(): Promise<Inventory> {
    return (await this.get("/api/projects")).json() as Promise<Inventory>;
  }

  async refresh(): Promise<Inventory> {
    const response = await fetch(`${this.origin}/api/refresh`, { method: "POST" });

    return response.json() as Promise<Inventory>;
  }

  async activate(slug: string): Promise<Response> {
    return fetch(`${this.origin}/api/projects/${slug}/activate`, { method: "POST" });
  }

  async status(slug: string): Promise<Response> {
    return this.get(`/api/projects/${slug}`);
  }
}
