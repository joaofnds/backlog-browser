import { describe, expect, test } from "bun:test";

import { BacklogUnavailable, type CommandRunner, locateBacklog } from "./backlog-cli.ts";

const REAL_HELP = `Usage: backlog browser [options]

Options:
  -p, --port <port>  port to run server on
  --no-open          don't automatically open browser
  --non-interactive  automatically use next free port without asking
  -h, --help         display help for command
`;

function runnerFor(replies: Record<string, { ok: boolean; stdout: string }>): CommandRunner {
  return async (command) => replies[command.join(" ")] ?? { ok: false, stdout: "" };
}

const workingBacklog = runnerFor({
  "backlog --version": { ok: true, stdout: "1.50.1\n" },
  "backlog browser --help": { ok: true, stdout: REAL_HELP },
});

describe("locateBacklog", () => {
  test("reports the binary and its version", async () => {
    const backlog = await locateBacklog({ run: workingBacklog });

    expect(backlog).toEqual({ binary: "backlog", version: "1.50.1" });
  });

  describe("when backlog is not on PATH", () => {
    test("rejects with the name it looked for", async () => {
      const attempt = locateBacklog({ run: runnerFor({}) });

      await expect(attempt).rejects.toBeInstanceOf(BacklogUnavailable);
    });
  });

  describe("when browser --help omits a required flag", () => {
    test("rejects naming the missing flag", async () => {
      const run = runnerFor({
        "backlog --version": { ok: true, stdout: "2.0.0\n" },
        "backlog browser --help": { ok: true, stdout: "Options:\n  --port <port>\n" },
      });

      await expect(locateBacklog({ run })).rejects.toThrow(/--non-interactive/);
    });

    test("rejects naming the version it found", async () => {
      const run = runnerFor({
        "backlog --version": { ok: true, stdout: "2.0.0\n" },
        "backlog browser --help": { ok: true, stdout: "Options:\n  --port <port>\n" },
      });

      await expect(locateBacklog({ run })).rejects.toThrow(/2\.0\.0/);
    });
  });

  describe("against the backlog installed on this machine", () => {
    test("accepts the browser command", async () => {
      const backlog = await locateBacklog();

      expect(backlog.version).toMatch(/^\d+\.\d+\.\d+/);
    });
  });
});
