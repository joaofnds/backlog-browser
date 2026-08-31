import type { PortAllocator } from "../supervisor/supervisor.ts";
import type { StateStore } from "./store.ts";

/**
 * Binds each project to the port it had last time, so its board keeps one origin and the
 * `localStorage` behind it. The port is written before the child binds it, so a child that dies on
 * a collision leaves the fallback port stored rather than the one that failed.
 */
export function rememberedPorts(props: {
	readonly store: StateStore;
	readonly allocate: (preferred: number) => Promise<number>;
}): PortAllocator {
	return async ({ path, reuse }) => {
		const remembered = reuse ? await props.store.portFor(path) : null;
		const port = await props.allocate(remembered ?? 0);

		await props.store.rememberPort(path, port);

		return port;
	};
}
