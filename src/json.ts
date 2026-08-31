export function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}

	return value as Record<string, unknown>;
}

export function fieldOf(value: unknown, key: string): unknown {
	return asRecord(value)?.[key];
}
