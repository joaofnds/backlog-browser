export const BINARY = "backlog";
export const REQUIRED_FLAGS = ["--port", "--non-interactive"] as const;

export type CommandRunner = (
	command: readonly string[],
) => Promise<{ readonly ok: boolean; readonly stdout: string }>;

export interface BacklogCli {
	binary: string;
}

const PREFLIGHT_TIMEOUT_MS = 10_000;

export class BacklogUnavailableError extends Error {
	public override readonly name = "BacklogUnavailableError";
}

export async function locateBacklog(
	options: { readonly run?: CommandRunner } = {},
): Promise<BacklogCli> {
	const run = options.run ?? spawnCommand;

	const version = await run([BINARY, "--version"]);
	if (!version.ok) {
		throw new BacklogUnavailableError(
			`Could not run \`${BINARY} --version\`. Install Backlog.md and make \`${BINARY}\` available on PATH.`,
		);
	}

	const help = await run([BINARY, "browser", "--help"]);
	if (!help.ok) {
		throw new BacklogUnavailableError(
			`Could not run \`${BINARY} browser --help\`.`,
		);
	}

	const missing = REQUIRED_FLAGS.filter((flag) => !help.stdout.includes(flag));
	if (missing.length > 0) {
		throw new BacklogUnavailableError(
			`\`${BINARY} browser\` (version ${version.stdout.trim()}) does not accept ${missing.join(" or ")}. ` +
				`backlog-browser needs ${REQUIRED_FLAGS.join(" and ")} to run one server per project.`,
		);
	}

	return { binary: BINARY };
}

/** A wrapper that hangs would otherwise hang startup with no output at all. */
export async function spawnCommand(
	command: string[],
	timeoutMs = PREFLIGHT_TIMEOUT_MS,
): Promise<{ readonly ok: boolean; readonly stdout: string }> {
	try {
		const child = Bun.spawn(command, {
			stdout: "pipe",
			stderr: "ignore",
			timeout: timeoutMs,
		});
		const stdout = await new Response(child.stdout).text();

		return { ok: (await child.exited) === 0, stdout };
	} catch {
		return { ok: false, stdout: "" };
	}
}
