export const BINARY = "backlog";
export const REQUIRED_FLAGS = ["--port", "--non-interactive"] as const;

export type CommandRunner = (command: string[]) => Promise<{ ok: boolean; stdout: string }>;

export type BacklogCli = { binary: string; version: string };

export class BacklogUnavailable extends Error {}

export async function locateBacklog(options: { run?: CommandRunner } = {}): Promise<BacklogCli> {
  const run = options.run ?? spawnCommand;

  const version = await run([BINARY, "--version"]);
  if (!version.ok) {
    throw new BacklogUnavailable(
      `Could not run \`${BINARY} --version\`. Install Backlog.md and make \`${BINARY}\` available on PATH.`,
    );
  }

  const help = await run([BINARY, "browser", "--help"]);
  if (!help.ok) {
    throw new BacklogUnavailable(`Could not run \`${BINARY} browser --help\`.`);
  }

  const missing = REQUIRED_FLAGS.filter((flag) => !help.stdout.includes(flag));
  if (missing.length > 0) {
    throw new BacklogUnavailable(
      `\`${BINARY} browser\` (version ${version.stdout.trim()}) does not accept ${missing.join(" or ")}. ` +
        `backlog-hub needs ${REQUIRED_FLAGS.join(" and ")} to run one server per project.`,
    );
  }

  return { binary: BINARY, version: version.stdout.trim() };
}

async function spawnCommand(command: string[]): Promise<{ ok: boolean; stdout: string }> {
  try {
    const child = Bun.spawn(command, { stdout: "pipe", stderr: "ignore" });
    const stdout = await new Response(child.stdout).text();

    return { ok: (await child.exited) === 0, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}
