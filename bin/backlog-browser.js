#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * The tool itself is TypeScript run by Bun, which is what lets it track its source with no build
 * step. That works from a clone, where `bun` is on the PATH. Installed from npm it need not be,
 * and the bare shebang would fail as `env: bun: No such file or directory`, naming neither the
 * tool nor the fix. Node is what npm can always run, so it hands over to Bun from here.
 */
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const hub = spawn("bun", [cli, ...process.argv.slice(2)], { stdio: "inherit" });

/** @param {NodeJS.ErrnoException} error */
const onSpawnError = (error) => {
	if (error.code === "ENOENT") {
		console.error(
			"backlog-browser needs Bun to run, and there is no `bun` on your PATH.",
		);
		console.error(
			"Install it from https://bun.sh, then run backlog-browser again.",
		);
		process.exit(127);
	}

	console.error(error.message);
	process.exit(1);
};

hub.on("error", onSpawnError);

// The hub stops its children on the way down, so it has to receive the signal rather than be
// killed with the wrapper. Ctrl+C reaches both through the process group; a signal sent to this
// process alone would otherwise leave the hub running and its port held.
/** @type {NodeJS.Signals[]} */
const forwarded = ["SIGINT", "SIGTERM", "SIGHUP"];
for (const signal of forwarded) {
	process.on(signal, () => hub.kill(signal));
}

hub.on("exit", (status, signal) => {
	process.exit(
		signal === null ? (status ?? 0) : 128 + (constants.signals[signal] ?? 0),
	);
});
