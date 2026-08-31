import { describe, expect, test } from "bun:test";

import {
	BacklogUnavailableError,
	locateBacklog,
	spawnCommand,
} from "./backlog-cli.ts";
import type { CommandRunner } from "./backlog-cli.ts";

const REAL_HELP = `Usage: backlog browser [options]

Options:
  -p, --port <port>  port to run server on
  --no-open          don't automatically open browser
  --non-interactive  automatically use next free port without asking
  -h, --help         display help for command
`;

function runnerFor(
	replies: Readonly<
		Record<string, { readonly ok: boolean; readonly stdout: string }>
	>,
): CommandRunner {
	return (command) =>
		Promise.resolve(replies[command.join(" ")] ?? { ok: false, stdout: "" });
}

const workingBacklog = runnerFor({
	"backlog --version": { ok: true, stdout: "1.50.1\n" },
	"backlog browser --help": { ok: true, stdout: REAL_HELP },
});

describe("locateBacklog", () => {
	test("reports the binary to run", async () => {
		const backlog = await locateBacklog({ run: workingBacklog });

		expect(backlog).toEqual({ binary: "backlog" });
	});

	describe("when backlog is not on PATH", () => {
		test("rejects with the name it looked for", async () => {
			const attempt = locateBacklog({ run: runnerFor({}) });

			expect(attempt).rejects.toBeInstanceOf(BacklogUnavailableError);
		});
	});

	describe("when browser --help omits a required flag", () => {
		test("rejects naming the missing flag", async () => {
			const run = runnerFor({
				"backlog --version": { ok: true, stdout: "2.0.0\n" },
				"backlog browser --help": {
					ok: true,
					stdout: "Options:\n  --port <port>\n",
				},
			});

			expect(locateBacklog({ run })).rejects.toThrow(/--non-interactive/u);
		});

		test("rejects naming the version it found", async () => {
			const run = runnerFor({
				"backlog --version": { ok: true, stdout: "2.0.0\n" },
				"backlog browser --help": {
					ok: true,
					stdout: "Options:\n  --port <port>\n",
				},
			});

			expect(locateBacklog({ run })).rejects.toThrow(/2\.0\.0/u);
		});
	});
});

describe("spawnCommand", () => {
	test("gives up on a command that hangs", async () => {
		const outcome = await spawnCommand(["sleep", "10"], 50);

		expect(outcome).toEqual({ ok: false, stdout: "" });
	});
});
