import { readJsonObject, stateFile, writeJson } from "./json-store.ts";

export class StateStore {
  private readonly file: string;

  constructor(props: { file: string }) {
    this.file = props.file;
  }

  static default(): StateStore {
    return new StateStore({ file: stateFile("state.json") });
  }

  async lastActive(root: string): Promise<string | null> {
    const slug = (await this.roots())[root];

    return typeof slug === "string" && slug !== "" ? slug : null;
  }

  async remember(root: string, slug: string): Promise<void> {
    const roots = { ...(await this.roots()), [root]: slug };

    await writeJson(this.file, { roots });
  }

  private async roots(): Promise<Record<string, unknown>> {
    const roots = (await readJsonObject(this.file)).roots;

    return typeof roots === "object" && roots !== null && !Array.isArray(roots)
      ? (roots as Record<string, unknown>)
      : {};
  }
}
