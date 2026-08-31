export const SETTING_BOUNDS = {
	depth: { minimum: 1, maximum: 20 },
} as const;

export interface SettingBounds {
	readonly minimum: number;
	readonly maximum: number;
}
