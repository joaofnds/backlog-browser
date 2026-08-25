import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DiscoveryCache } from "./cache.ts";
import type { ProjectFinder } from "./discovery.ts";
import { ProjectRegistry } from "./registry.ts";

const DEPTH = 5;

let root: string;
let cache: DiscoveryCache;
let scans: number;

function countingFinder(): ProjectFinder {
  return async () => {
    scans += 1;

    return listProjectDirectories();
  };
}

async function listProjectDirectories(): Promise<string[]> {
  const { findProjectPaths } = await import("./discovery.ts");

  return findProjectPaths({ root, depth: DEPTH });
}

async function makeProject(directory: string, name: string) {
  const path = join(root, directory);
  await Bun.write(join(path, "backlog", "config.yml"), `project_name: "${name}"\n`);

  return path;
}

function registry() {
  return new ProjectRegistry({ root, depth: DEPTH, cache, find: countingFinder() });
}

function namesOf(projects: readonly { name: string }[]) {
  return projects.map((project) => project.name);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "backlog-hub-registry-"));
  cache = new DiscoveryCache({ file: join(root, ".cache", "discovery.json") });
  scans = 0;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ProjectRegistry", () => {
  describe("load", () => {
    test("scans when the cache is cold", async () => {
      await makeProject("alpha", "Alpha");

      expect(namesOf(await registry().load())).toEqual(["Alpha"]);
    });

    test("saves the scan for the next run", async () => {
      const path = await makeProject("alpha", "Alpha");

      await registry().load();

      expect(await cache.read(root, DEPTH)).toEqual([path]);
    });

    test("reuses the cached paths without walking again", async () => {
      await makeProject("alpha", "Alpha");
      await registry().load();
      scans = 0;

      await registry().load();

      expect(scans).toBe(0);
    });

    test("shows a project renamed since the scan", async () => {
      await makeProject("alpha", "Alpha");
      await registry().load();

      await makeProject("alpha", "Renamed");

      expect(namesOf(await registry().load())).toEqual(["Renamed"]);
    });

    describe("when a cached project is gone", () => {
      test("drops it without walking again", async () => {
        await makeProject("alpha", "Alpha");
        await makeProject("beta", "Beta");
        await registry().load();
        await rm(join(root, "alpha"), { recursive: true });
        scans = 0;

        const loaded = await registry().load();

        expect(namesOf(loaded)).toEqual(["Beta"]);
        expect(scans).toBe(0);
      });

      test("forgets it in the cache", async () => {
        const beta = await makeProject("beta", "Beta");
        await makeProject("alpha", "Alpha");
        await registry().load();
        await rm(join(root, "alpha"), { recursive: true });

        await registry().load();

        expect(await cache.read(root, DEPTH)).toEqual([beta]);
      });
    });
  });

  describe("refresh", () => {
    test("walks again even when the cache is warm", async () => {
      await makeProject("alpha", "Alpha");
      await registry().load();
      scans = 0;

      await registry().refresh();

      expect(scans).toBe(1);
    });

    test("finds a project added since the scan", async () => {
      await makeProject("alpha", "Alpha");
      const subject = registry();
      await subject.load();

      await makeProject("beta", "Beta");

      expect(namesOf(await subject.refresh())).toEqual(["Alpha", "Beta"]);
    });

    test("rewrites the cache", async () => {
      await makeProject("alpha", "Alpha");
      const subject = registry();
      await subject.load();
      const beta = await makeProject("beta", "Beta");

      await subject.refresh();

      expect(await cache.read(root, DEPTH)).toContain(beta);
    });
  });
});
