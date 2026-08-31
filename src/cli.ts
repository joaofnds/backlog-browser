#!/usr/bin/env bun
import { startApp } from "./app.ts";
import type { App } from "./app.ts";
import { nativeFolderChooser } from "./discovery/choose-folder.ts";
import { stateFile } from "./json-store.ts";
import { parseOptions, USAGE, UsageError, wantsHelp } from "./options.ts";
import type { HubOptions } from "./options.ts";
import { StateStore } from "./state/store.ts";
import {
	BacklogUnavailableError,
	locateBacklog,
} from "./supervisor/backlog-cli.ts";
import {
	allocatePort,
	backlogLauncher,
	probeBacklogConfig,
} from "./supervisor/child.ts";

const READY_TIMEOUT_MS = 15_000;

await main(Bun.argv.slice(2));

async function main(argv: readonly string[]): Promise<void> {
	if (wantsHelp(argv)) {
		return console.log(USAGE);
	}

	let options: HubOptions;
	try {
		options = parseOptions(argv);
	} catch (error) {
		return die(error instanceof UsageError ? error.message : String(error));
	}

	let backlog: { binary: string };
	try {
		backlog = await locateBacklog();
	} catch (error) {
		return die(
			error instanceof BacklogUnavailableError ? error.message : String(error),
		);
	}

	let app: App;
	try {
		app = await startApp(options, {
			launch: backlogLauncher(backlog.binary),
			probe: probeBacklogConfig,
			allocate: allocatePort,
			chooseFolder: nativeFolderChooser,
			store: StateStore.default(options.root),
			cacheFile: stateFile("discovery.json"),
			readyTimeoutMs: READY_TIMEOUT_MS,
		});
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);

		return die(
			`Could not start the hub (${reason}).\n` +
				`If port ${options.port} is taken, free it or pass --port <n>.`,
		);
	}

	installShutdown({
		stop: app.stop,
		force: () => app.supervisor.terminate(),
	});

	announce(app, options.root);
	if (options.open) {
		openBrowser(app.server.url.href);
	}
}

function announce(app: App, root: string): void {
	const count = app.registry.all().length;
	const noun = count === 1 ? "project" : "projects";
	console.log(`backlog-browser → ${app.server.url.href}`);
	console.log(`${count} ${noun} under ${root} (depth ${app.registry.depth})`);
}

function installShutdown(handlers: {
	readonly stop: () => Promise<void>;
	readonly force: () => void;
}): void {
	let stopping = false;

	const onSignal = (signal: NodeJS.Signals): void => {
		process.on(signal, async () => {
			if (stopping) {
				handlers.force();
				process.exit(130);
			}

			stopping = true;
			try {
				await handlers.stop();
				process.exit(0);
			} catch (error) {
				console.error(error);
				process.exit(1);
			}
		});
	};

	onSignal("SIGINT");
	onSignal("SIGTERM");

	process.on("uncaughtException", (error) => {
		console.error(error);
		handlers.force();
		process.exit(1);
	});

	process.on("exit", handlers.force);
}

function browserCommand(url: string): string[] {
	if (process.platform === "darwin") {
		return ["open", url];
	}
	if (process.platform === "win32") {
		return ["cmd", "/c", "start", "", url];
	}

	return ["xdg-open", url];
}

function openBrowser(url: string): void {
	const command = browserCommand(url);

	try {
		Bun.spawn(command, {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		}).unref();
	} catch {
		console.log(`Open ${url} in your browser.`);
	}
}

function die(message: string): never {
	console.error(message);
	process.exit(1);
}
