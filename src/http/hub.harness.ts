import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type App, startApp } from "../app.ts";
import type { ChosenFolder } from "../discovery/choose-folder.ts";
import type { Project } from "../discovery/project.ts";
import { StateStore } from "../state/store.ts";
import { FakeBacklog } from "../supervisor/fake-backlog.ts";
import type { Supervisor } from "../supervisor/supervisor.ts";

/** Stands in for the host's chooser: the tests say what the user chose, no window involved. */
export class FakeChooser {
  readonly openedAt: string[] = [];
  private answer: ChosenFolder = { kind: "cancelled" };

  chooses(path: string): void {
    this.answer = { kind: "chosen", path };
  }

  cancels(): void {
    this.answer = { kind: "cancelled" };
  }

  breaks(reason: string): void {
    this.answer = { kind: "unavailable", reason };
  }

  fails(reason: string): void {
    this.answer = { kind: "failed", reason };
  }

  choose = async ({ startAt }: { startAt: string }): Promise<ChosenFolder> => {
    this.openedAt.push(startAt);

    return this.answer;
  };
}

export class HubHarness {
  private constructor(
    readonly root: string,
    private readonly app: App,
    readonly backlog: FakeBacklog,
    readonly chooser: FakeChooser,
    readonly clock: { now: number },
  ) {}

  /** Boots through `startApp`, the same composition root the CLI uses, with the Fakes as deps. */
  static async start(
    options: { depth?: number; root?: string; rescan?: boolean; idleTimeoutMs?: number } = {},
  ): Promise<HubHarness> {
    const root = options.root ?? (await mkdtemp(join(tmpdir(), "backlog-browser-")));
    const backlog = new FakeBacklog();
    const chooser = new FakeChooser();
    const clock = { now: 0 };

    const app = await startApp(
      {
        root,
        port: 0,
        depth: options.depth ?? null,
        idleTimeoutMs: options.idleTimeoutMs ?? 0,
        rescan: options.rescan ?? false,
      },
      {
        launch: backlog.launch,
        probe: backlog.probe,
        allocate: backlog.allocatePort,
        chooseFolder: chooser.choose,
        store: new StateStore({ file: join(root, ".state", "state.json"), root }),
        cacheFile: join(root, ".state", "discovery.json"),
        readyTimeoutMs: 1_000,
        pollIntervalMs: 0,
        now: () => clock.now,
      },
    );

    return new HubHarness(root, app, backlog, chooser, clock);
  }

  get store(): StateStore {
    return this.app.store;
  }

  get supervisor(): Supervisor {
    return this.app.supervisor;
  }

  projectFor(slug: string): Project {
    const project = this.app.registry.find(slug);
    if (!project) throw new Error(`no discovered project with slug ${slug}`);

    return project;
  }

  driver(): HubDriver {
    return new HubDriver(this.app.server.url.origin);
  }

  async addProject(name: string, directory = name): Promise<string> {
    const path = join(this.root, directory);
    await Bun.write(join(path, "backlog", "config.yml"), `project_name: "${name}"\n`);

    return path;
  }

  /**
   * A second hub over the same root, so the same `state.json` and discovery cache carry over. The
   * child ports do not: a fresh `FakeBacklog` counts from the bottom again, which is what makes a
   * project landing on its old port evidence that the port was remembered rather than re-derived.
   */
  async restart(
    options: { depth?: number; rescan?: boolean; idleTimeoutMs?: number } = {},
  ): Promise<HubHarness> {
    await this.app.stop();

    return HubHarness.start({ ...options, root: this.root });
  }

  async stop(): Promise<void> {
    await this.app.stop();
    await rm(this.root, { recursive: true, force: true });
  }
}

export type ProjectSummary = {
  slug: string;
  name: string;
  path: string;
  hidden: boolean;
  added: boolean;
};
export type Inventory = {
  root: string;
  depth: number;
  active: string | null;
  mode: "default" | "manual";
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

  async refresh(depth?: number): Promise<Inventory> {
    return (await this.refreshing(depth)).json() as Promise<Inventory>;
  }

  async refreshing(depth?: number): Promise<Response> {
    return this.post("/api/refresh", depth === undefined ? {} : { depth });
  }

  async chooseFolder(): Promise<Response> {
    return this.post("/api/choose-folder", {});
  }

  async addPath(path: string): Promise<Response> {
    return this.post("/api/list/added", { path, added: true });
  }

  async dropPath(path: string): Promise<Response> {
    return this.post("/api/list/added", { path, added: false });
  }

  async activate(slug: string): Promise<Response> {
    return fetch(`${this.origin}/api/projects/${slug}/activate`, { method: "POST" });
  }

  async statuses(): Promise<Record<string, string>> {
    return (await this.get("/api/status")).json() as Promise<Record<string, string>>;
  }

  async status(slug: string): Promise<Response> {
    return this.get(`/api/projects/${slug}`);
  }

  async post(path: string, body: unknown): Promise<Response> {
    return fetch(`${this.origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** A request as another site's page would send it: the browser stamps its own origin on. */
  async postFrom(origin: string, path: string, body: unknown): Promise<Response> {
    return fetch(`${this.origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify(body),
    });
  }

  /** A request reaching the hub under a rebound name rather than its own loopback host. */
  async getAs(host: string, path: string): Promise<Response> {
    return fetch(`${this.origin}${path}`, { headers: { host } });
  }

  /**
   * A request naming no host at all, which `fetch` cannot express: it always sends one. Only a
   * raw client can, so this speaks HTTP/1.0 down a socket and reads the status line back.
   */
  async hostless(path: string): Promise<Response> {
    const url = new URL(this.origin);
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: url.hostname, port: Number(url.port) }, () => {
        socket.write(`GET ${path} HTTP/1.0\r\n\r\n`);
      });
      let answer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        answer += chunk;
      });
      socket.on("end", () => resolve(answer));
      socket.on("error", reject);
    });

    const [head, body = ""] = raw.split("\r\n\r\n");
    const status = Number(head?.split(" ")[1] ?? 0);

    return new Response(body, { status });
  }

  async hide(path: string): Promise<Inventory> {
    return (
      await this.post("/api/list/hidden", { path, hidden: true })
    ).json() as Promise<Inventory>;
  }

  async show(path: string): Promise<Inventory> {
    return (
      await this.post("/api/list/hidden", { path, hidden: false })
    ).json() as Promise<Inventory>;
  }

  async move(path: string, before: string | null): Promise<Inventory> {
    return (await this.post("/api/list/order", { path, before })).json() as Promise<Inventory>;
  }

  async resetOrder(): Promise<Inventory> {
    return (await this.post("/api/list/reset", {})).json() as Promise<Inventory>;
  }
}
