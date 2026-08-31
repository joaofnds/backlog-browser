export const SETTING_BOUNDS = {
	depth: { minimum: 1, maximum: 20 },
} as const;

export interface SettingBounds {
	readonly minimum: number;
	readonly maximum: number;
}

export function within(value: unknown, bounds: SettingBounds): number | null {
	if (typeof value !== "number" || !Number.isInteger(value)) {
		return null;
	}

	return value >= bounds.minimum && value <= bounds.maximum ? value : null;
}
