export const SETTING_BOUNDS = {
  depth: { minimum: 1, maximum: 20 },
} as const;

export type SettingBounds = { minimum: number; maximum: number };

/**
 * What the user chose in the shell, per root. A `null` field is a choice never made, which is what
 * lets a command-line flag win over a default without overwriting a value the shell holds.
 */
export class HubSettings {
  readonly depth: number | null;

  constructor(props: { depth: number | null }) {
    this.depth = props.depth;
  }

  static empty(): HubSettings {
    return new HubSettings({ depth: null });
  }

  static from(value: unknown): HubSettings {
    const stored = fieldOf(value, "settings");

    return new HubSettings({ depth: within(fieldOf(stored, "depth"), SETTING_BOUNDS.depth) });
  }

  withDepth(depth: number): HubSettings {
    return new HubSettings({ depth });
  }

  toJSON(): { depth: number | null } {
    return { depth: this.depth };
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
