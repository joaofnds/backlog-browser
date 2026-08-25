#!/usr/bin/env bun
import { DiscoveryCache } from "./discovery/cache.ts";
import { ProjectRegistry } from "./discovery/registry.ts";
import { startHub } from "./http/server.ts";
import { type HubOptions, parseOptions, USAGE, UsageError, wantsHelp } from "./options.ts";
import { StateStore } from "./state/store.ts";
import { BacklogUnavailable, locateBacklog } from "./supervisor/backlog-cli.ts";
import { allocatePort, backlogLauncher, LOOPBACK, probeBacklogConfig } from "./supervisor/child.ts";
import { Supervisor } from "./supervisor/supervisor.ts";

const READY_TIMEOUT_MS = 15_000;
const IDLE_SWEEP_MS = 60_000;

await main(Bun.argv.slice(2));

async function main(argv: string[]): Promise<void> {
  if (wantsHelp(argv)) return console.log(USAGE);

  let options: HubOptions;
  try {
    options = parseOptions(argv);
  } catch (error) {
    return die(error instanceof UsageError ? error.message : String(error));
  }

  let backlog: { binary: string; version: string };
  try {
    backlog = await locateBacklog();
  } catch (error) {
    return die(error instanceof BacklogUnavailable ? error.message : String(error));
  }

  const registry = new ProjectRegistry({
    root: options.root,
    depth: options.depth,
    cache: DiscoveryCache.default(),
  });
  await (options.rescan ? registry.refresh() : registry.load());

  const supervisor = new Supervisor({
    launch: backlogLauncher(backlog.binary),
    probe: probeBacklogConfig,
    allocatePort,
    maxChildren: options.maxChildren,
    idleTimeoutMs: options.idleTimeoutMs,
    readyTimeoutMs: READY_TIMEOUT_MS,
  });

  const server = listen({ registry, store: StateStore.default(), supervisor, port: options.port });
  if (server === null) return;

  const sweep = setInterval(() => supervisor.stopIdle(), IDLE_SWEEP_MS);
  sweep.unref?.();

  installShutdown({
    stop: async () => {
      clearInterval(sweep);
      await supervisor.shutdown();
      await server.stop(true);
    },
    force: () => supervisor.terminate(),
  });

  announce(server.url.href, registry, options);
  if (options.open) openBrowser(server.url.href);
}

function listen(deps: Parameters<typeof startHub>[0]): Bun.Server<undefined> | null {
  try {
    return startHub(deps);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    die(
      `Could not bind ${LOOPBACK}:${deps.port} (${reason}).\n` +
        "Another process is already using it. Free the port, or pass --port <n>.",
    );

    return null;
  }
}

function announce(url: string, registry: ProjectRegistry, options: HubOptions): void {
  const count = registry.all().length;
  const noun = count === 1 ? "project" : "projects";
  console.log(`backlog-hub → ${url}`);
  console.log(`${count} ${noun} under ${options.root} (depth ${options.depth})`);
}

function installShutdown(handlers: { stop: () => Promise<void>; force: () => void }): void {
  let stopping = false;

  const onSignal = (signal: NodeJS.Signals) => {
    process.on(signal, () => {
      if (stopping) {
        handlers.force();
        process.exit(130);
      }

      stopping = true;
      handlers.stop().then(
        () => process.exit(0),
        () => process.exit(1),
      );
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

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];

  try {
    Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
  } catch {
    console.log(`Open ${url} in your browser.`);
  }
}

function die(message: string): void {
  console.error(message);
  process.exit(1);
}
