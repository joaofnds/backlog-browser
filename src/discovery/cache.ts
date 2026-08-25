import { readJsonObject, stateFile, writeJson } from "../state/json-store.ts";

type CachedScan = { depth: number; paths: string[] };

export class DiscoveryCache {
  private readonly file: string;

  constructor(props: { file: string }) {
    this.file = props.file;
  }

  static default(): DiscoveryCache {
    return new DiscoveryCache({ file: stateFile("discovery.json") });
  }

  async read(root: string, depth: number): Promise<string[] | null> {
    const scan = asScan((await this.roots())[root]);
    if (scan === null || scan.depth !== depth) return null;

    return scan.paths;
  }

  async write(root: string, depth: number, paths: readonly string[]): Promise<void> {
    const roots = { ...(await this.roots()), [root]: { depth, paths: [...paths] } };

    await writeJson(this.file, { roots });
  }

  private async roots(): Promise<Record<string, unknown>> {
    const stored = await readJsonObject(this.file);
    const roots = stored.roots;

    return typeof roots === "object" && roots !== null && !Array.isArray(roots)
      ? (roots as Record<string, unknown>)
      : {};
  }
}

function asScan(value: unknown): CachedScan | null {
  if (typeof value !== "object" || value === null) return null;

  const { depth, paths } = value as Record<string, unknown>;
  if (typeof depth !== "number") return null;
  if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string")) return null;

  return { depth, paths: paths as string[] };
}
