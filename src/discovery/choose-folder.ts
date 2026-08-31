import { stat } from "node:fs/promises";

export type ChosenFolder =
	| { readonly kind: "chosen"; readonly path: string }
	| { readonly kind: "cancelled" }
	| { readonly kind: "unavailable"; readonly reason: string }
	| { readonly kind: "failed"; readonly reason: string };

export type FolderChooser = (options: {
	startAt: string;
}) => Promise<ChosenFolder>;

const PROMPT = "Choose a Backlog.md project folder";

/**
 * The host's own chooser, not the browser's: a page gets no absolute path out of
 * `webkitdirectory` or `showDirectoryPicker`, and an absolute path is the whole point.
 */
export const nativeFolderChooser: FolderChooser = async ({ startAt }) => {
	if (process.platform !== "darwin") {
		return {
			kind: "unavailable",
			reason: `No folder chooser on ${process.platform}.`,
		};
	}

	const script = await appleScript(startAt);
	const run = Bun.spawn(["osascript", "-e", script], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, error, code] = await Promise.all([
		new Response(run.stdout).text(),
		new Response(run.stderr).text(),
		run.exited,
	]);

	if (code === 0) {
		return { kind: "chosen", path: out.trim().replace(/\/$/, "") };
	}

	if (error.includes("-128")) {
		return { kind: "cancelled" };
	}

	return {
		kind: "failed",
		reason: error.trim() || "The chooser closed without answering.",
	};
};

/** `choose folder` errors on a `default location` that is gone, so it is offered only when it is there. */
async function appleScript(startAt: string): Promise<string> {
	const choose = `choose folder with prompt "${PROMPT}"`;
	const reachable = await stat(startAt).then(
		(found) => found.isDirectory(),
		() => false,
	);

	return reachable
		? `POSIX path of (${choose} default location POSIX file "${quote(startAt)}")`
		: `POSIX path of (${choose})`;
}

function quote(value: string): string {
	return value.replaceAll("\\", String.raw`\\`).replaceAll('"', String.raw`\"`);
}
