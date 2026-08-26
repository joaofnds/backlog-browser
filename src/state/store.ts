import { ProjectList } from "../list/list.ts";
import { readJsonObject, stateFile, writeJson } from "./json-store.ts";
import { PortBook } from "./port-book.ts";
import { HubSettings } from "./settings.ts";

type RootState = {
  readonly active: string | null;
  readonly list: ProjectList;
  readonly ports: PortBook;
  readonly settings: HubSettings;
};

export class StateStore {
  private readonly file: string;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(props: { file: string }) {
    this.file = props.file;
  }

  static default(): StateStore {
    return new StateStore({ file: stateFile("state.json") });
  }

  async lastActive(root: string): Promise<string | null> {
    return (await this.stateOf(root)).active;
  }

  async list(root: string): Promise<ProjectList> {
    return (await this.stateOf(root)).list;
  }

  async ports(root: string): Promise<PortBook> {
    return (await this.stateOf(root)).ports;
  }

  async settings(root: string): Promise<HubSettings> {
    return (await this.stateOf(root)).settings;
  }

  async remember(root: string, slug: string): Promise<void> {
    await this.update(root, (current) => ({ ...current, active: slug }));
  }

  async updateList(root: string, change: (list: ProjectList) => ProjectList): Promise<ProjectList> {
    return (await this.update(root, (current) => ({ ...current, list: change(current.list) })))
      .list;
  }

  async updateSettings(
    root: string,
    change: (settings: HubSettings) => HubSettings,
  ): Promise<HubSettings> {
    return (
      await this.update(root, (current) => ({ ...current, settings: change(current.settings) }))
    ).settings;
  }

  async rememberPort(root: string, path: string, port: number): Promise<void> {
    await this.update(root, (current) => ({ ...current, ports: current.ports.assign(path, port) }));
  }

  private async stateOf(root: string): Promise<RootState> {
    return readRoot((await this.roots())[root]);
  }

  /**
   * Every write is a read-modify-write of the whole file, so two of them in flight at once lose
   * one update. Activating a project, reordering the list and claiming a port are separate writers,
   * so queue them, and read the current state inside the queue rather than before joining it.
   */
  private update(root: string, change: (current: RootState) => RootState): Promise<RootState> {
    const done = this.writes.then(() => this.apply(root, change));
    this.writes = done.catch(() => {});

    return done;
  }

  private async apply(root: string, change: (current: RootState) => RootState): Promise<RootState> {
    const roots = await this.roots();
    const next = change(readRoot(roots[root]));

    await writeJson(this.file, {
      roots: {
        ...roots,
        [root]: {
          active: next.active,
          ...next.list.toJSON(),
          ports: next.ports.toJSON(),
          settings: next.settings.toJSON(),
        },
      },
    });

    return next;
  }

  private async roots(): Promise<Record<string, unknown>> {
    const roots = (await readJsonObject(this.file)).roots;

    return typeof roots === "object" && roots !== null && !Array.isArray(roots)
      ? (roots as Record<string, unknown>)
      : {};
  }
}

function readRoot(stored: unknown): RootState {
  return {
    active: activeOf(stored),
    list: ProjectList.from(stored),
    ports: PortBook.from(stored),
    settings: HubSettings.from(stored),
  };
}

function activeOf(stored: unknown): string | null {
  if (typeof stored === "string") return stored === "" ? null : stored;
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return null;

  const active = (stored as Record<string, unknown>).active;

  return typeof active === "string" && active !== "" ? active : null;
}
