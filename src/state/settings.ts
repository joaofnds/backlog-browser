export const SETTING_BOUNDS = {
  depth: { minimum: 1, maximum: 20 },
  maxChildren: { minimum: 1, maximum: 32 },
} as const;

export type SettingBounds = { minimum: number; maximum: number };

/**
 * What the user chose in the shell, per root. A `null` field is a choice never made, which is what
 * lets a command-line flag win over a default without overwriting a value the shell holds.
 */
export class HubSettings {
  readonly depth: number | null;
  readonly maxChildren: number | null;

  constructor(props: { depth: number | null; maxChildren: number | null }) {
    this.depth = props.depth;
    this.maxChildren = props.maxChildren;
  }

  static empty(): HubSettings {
    return new HubSettings({ depth: null, maxChildren: null });
  }

  static from(value: unknown): HubSettings {
    const stored = fieldOf(value, "settings");

    return new HubSettings({
      depth: within(fieldOf(stored, "depth"), SETTING_BOUNDS.depth),
      maxChildren: within(fieldOf(stored, "maxChildren"), SETTING_BOUNDS.maxChildren),
    });
  }

  withDepth(depth: number): HubSettings {
    return new HubSettings({ depth, maxChildren: this.maxChildren });
  }

  withMaxChildren(maxChildren: number): HubSettings {
    return new HubSettings({ depth: this.depth, maxChildren });
  }

  toJSON(): { depth: number | null; maxChildren: number | null } {
    return { depth: this.depth, maxChildren: this.maxChildren };
  }
}

export function within(value: unknown, bounds: SettingBounds): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;

  return value >= bounds.minimum && value <= bounds.maximum ? value : null;
}

function fieldOf(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;

  return (value as Record<string, unknown>)[key];
}
