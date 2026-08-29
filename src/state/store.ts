import { asRecord, fieldOf } from "../json.ts";
import { readRoots, stateFile, writeJson } from "../json-store.ts";
import { ProjectList } from "../list/list.ts";
import { SETTING_BOUNDS, within } from "./settings.ts";

const LOWEST_PORT = 1;
const HIGHEST_PORT = 65_535;

type RootState = {
  readonly active: string | null;
  readonly list: ProjectList;
  readonly ports: Readonly<Record<string, number>>;
  readonly depth: number | null;
};

export class StateStore {
  private readonly file: string;
  private readonly root: string;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(props: { file: string; root: string }) {
    this.file = props.file;
    this.root = props.root;
  }

  static default(root: string): StateStore {
    return new StateStore({ file: stateFile("state.json"), root });
  }

  async lastActive(): Promise<string | null> {
    return (await this.state()).active;
  }

  async list(): Promise<ProjectList> {
    return (await this.state()).list;
  }

  /** `null` is a depth never chosen, which is what lets a flag win without erasing a choice. */
  async depth(): Promise<number | null> {
    return (await this.state()).depth;
  }

  async portFor(path: string): Promise<number | null> {
    return (await this.state()).ports[path] ?? null;
  }

  async remember(slug: string): Promise<void> {
    await this.update((current) => ({ ...current, active: slug }));
  }

  async rememberDepth(depth: number): Promise<void> {
    await this.update((current) => ({ ...current, depth }));
  }

  async rememberPort(path: string, port: number): Promise<void> {
    await this.update((current) => ({ ...current, ports: { ...current.ports, [path]: port } }));
  }

  async updateList(change: (list: ProjectList) => ProjectList): Promise<ProjectList> {
    return (await this.update((current) => ({ ...current, list: change(current.list) }))).list;
  }

  private async state(): Promise<RootState> {
    return readRoot((await readRoots(this.file))[this.root]);
  }

  /**
   * Every write is a read-modify-write of the whole file, so two of them in flight at once lose
   * one update. Activating a project, reordering the list and claiming a port are separate writers,
   * so queue them, and read the current state inside the queue rather than before joining it.
   */
  private update(change: (current: RootState) => RootState): Promise<RootState> {
    const done = this.writes.then(() => this.apply(change));
    this.writes = done.catch(() => {});

    return done;
  }

  private async apply(change: (current: RootState) => RootState): Promise<RootState> {
    const roots = await readRoots(this.file);
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

function readRoot(stored: unknown): RootState {
  return {
    active: activeOf(stored),
    list: ProjectList.from(stored),
    ports: portsOf(fieldOf(stored, "ports")),
    depth: within(fieldOf(fieldOf(stored, "settings"), "depth"), SETTING_BOUNDS.depth),
  };
}

function activeOf(stored: unknown): string | null {
  const active = fieldOf(stored, "active");

  return typeof active === "string" && active !== "" ? active : null;
}

function portsOf(value: unknown): Record<string, number> {
  const stored = asRecord(value);
  if (stored === null) return {};

  const ports: Record<string, number> = {};
  for (const [path, port] of Object.entries(stored)) {
    if (isPort(port)) ports[path] = port;
  }

  return ports;
}

function isPort(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= LOWEST_PORT &&
    value <= HIGHEST_PORT
  );
}
