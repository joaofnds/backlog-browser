import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StateStore } from "./store.ts";

const ROOT = "/code";
const OTHER_ROOT = "/work";

let directory: string;
let file: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "backlog-browser-state-"));
  file = join(directory, "nested", "state.json");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("StateStore", () => {
  test("remembers nothing before a project is activated", async () => {
    expect(await new StateStore({ file }).lastActive(ROOT)).toBeNull();
  });

  test("returns the last remembered project", async () => {
    const store = new StateStore({ file });

    await store.remember(ROOT, "alpha-1234abcd");

    expect(await store.lastActive(ROOT)).toEqual("alpha-1234abcd");
  });

  test("keeps only the most recent project", async () => {
    const store = new StateStore({ file });

    await store.remember(ROOT, "alpha-1234abcd");
    await store.remember(ROOT, "beta-5678efgh");

    expect(await store.lastActive(ROOT)).toEqual("beta-5678efgh");
  });

  test("carries the project across hub restarts", async () => {
    await new StateStore({ file }).remember(ROOT, "alpha-1234abcd");

    expect(await new StateStore({ file }).lastActive(ROOT)).toEqual("alpha-1234abcd");
  });

  test("keeps one project per root", async () => {
    const store = new StateStore({ file });

    await store.remember(ROOT, "alpha-1234abcd");
    await store.remember(OTHER_ROOT, "beta-5678efgh");

    expect(await store.lastActive(ROOT)).toEqual("alpha-1234abcd");
  });

  test("remembers nothing for a root that was never opened", async () => {
    const store = new StateStore({ file });

    await store.remember(ROOT, "alpha-1234abcd");

    expect(await store.lastActive(OTHER_ROOT)).toBeNull();
  });

  describe("when the state file is corrupt", () => {
    test("remembers nothing", async () => {
      await Bun.write(file, "{ not json");

      expect(await new StateStore({ file }).lastActive(ROOT)).toBeNull();
    });

    test("recovers on the next write", async () => {
      await Bun.write(file, "{ not json");
      const store = new StateStore({ file });

      await store.remember(ROOT, "alpha-1234abcd");

      expect(await store.lastActive(ROOT)).toEqual("alpha-1234abcd");
    });
  });
});
