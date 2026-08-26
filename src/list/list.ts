import type { Project } from "../discovery/project.ts";

export type OrderMode = "default" | "manual";

export type ListedProject = {
  readonly project: Project;
  readonly hidden: boolean;
};

export class ProjectList {
  readonly mode: OrderMode;
  readonly order: readonly string[];
  readonly hidden: readonly string[];

  constructor(props: { mode: OrderMode; order: readonly string[]; hidden: readonly string[] }) {
    this.mode = props.mode;
    this.order = props.order;
    this.hidden = props.hidden;
  }

  static empty(): ProjectList {
    return new ProjectList({ mode: "default", order: [], hidden: [] });
  }

  static from(value: unknown): ProjectList {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return ProjectList.empty();
    }

    const stored = value as Record<string, unknown>;

    return new ProjectList({
      mode: stored.mode === "manual" ? "manual" : "default",
      order: strings(stored.order),
      hidden: strings(stored.hidden),
    });
  }

  arrange(discovered: readonly Project[]): ListedProject[] {
    const hidden = new Set(this.hidden);
    const visible = discovered.filter((project) => !hidden.has(project.path));
    const concealed = discovered.filter((project) => hidden.has(project.path));

    return [
      ...this.sequence(visible).map((project) => ({ project, hidden: false })),
      ...concealed.map((project) => ({ project, hidden: true })),
    ];
  }

  hide(path: string): ProjectList {
    return new ProjectList({
      mode: this.mode,
      order: this.order.filter((stored) => stored !== path),
      hidden: this.hidden.includes(path) ? this.hidden : [...this.hidden, path],
    });
  }

  show(path: string): ProjectList {
    return new ProjectList({
      mode: this.mode,
      order: this.order,
      hidden: this.hidden.filter((stored) => stored !== path),
    });
  }

  /**
   * `before` names the project the moved one lands in front of; `null` means the end. Anchoring on
   * a neighbour rather than an index is what lets a stored path the walk did not find keep its
   * slot: it is never named, so it rides along with whichever neighbour it sits behind.
   */
  move(props: {
    path: string;
    before: string | null;
    discovered: readonly Project[];
  }): ProjectList {
    if (this.hidden.includes(props.path)) return this;

    const seeded = this.mode === "manual" ? this.order : this.defaultOrder(props.discovered);
    if (!seeded.includes(props.path)) return this;
    if (props.before !== null && !seeded.includes(props.before)) return this;

    const rest = seeded.filter((stored) => stored !== props.path);
    const at = props.before === null ? rest.length : rest.indexOf(props.before);

    return new ProjectList({
      mode: "manual",
      order: [...rest.slice(0, at), props.path, ...rest.slice(at)],
      hidden: this.hidden,
    });
  }

  reset(): ProjectList {
    return new ProjectList({ mode: "default", order: [], hidden: this.hidden });
  }

  toJSON(): { mode: OrderMode; order: readonly string[]; hidden: readonly string[] } {
    return { mode: this.mode, order: this.order, hidden: this.hidden };
  }

  private sequence(visible: readonly Project[]): Project[] {
    if (this.mode === "default") return [...visible];

    const byPath = new Map(visible.map((project) => [project.path, project]));
    const ordered = new Set(this.order);

    return [
      ...this.order.map((path) => byPath.get(path)).filter((project) => project !== undefined),
      ...visible.filter((project) => !ordered.has(project.path)),
    ];
  }

  private defaultOrder(discovered: readonly Project[]): string[] {
    const hidden = new Set(this.hidden);

    return discovered.filter((project) => !hidden.has(project.path)).map((project) => project.path);
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}
