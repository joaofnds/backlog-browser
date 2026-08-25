import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DiscoveryCache } from "./cache.ts";

const ROOT = "/code";
const OTHER_ROOT = "/work";
const DEPTH = 5;

let directory: string;
let file: string;
let cache: DiscoveryCache;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "backlog-browser-cache-"));
  file = join(directory, "nested", "discovery.json");
  cache = new DiscoveryCache({ file });
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("DiscoveryCache", () => {
  test("misses for a root that was never scanned", async () => {
    expect(await cache.read(ROOT, DEPTH)).toBeNull();
  });

  test("returns the paths saved for a root", async () => {
    await cache.write(ROOT, DEPTH, ["/code/alpha", "/code/beta"]);

    expect(await cache.read(ROOT, DEPTH)).toEqual(["/code/alpha", "/code/beta"]);
  });

  test("survives a hub restart", async () => {
    await cache.write(ROOT, DEPTH, ["/code/alpha"]);

    expect(await new DiscoveryCache({ file }).read(ROOT, DEPTH)).toEqual(["/code/alpha"]);
  });

  test("keeps one entry per root", async () => {
    await cache.write(ROOT, DEPTH, ["/code/alpha"]);
    await cache.write(OTHER_ROOT, DEPTH, ["/work/beta"]);

    expect(await cache.read(ROOT, DEPTH)).toEqual(["/code/alpha"]);
  });

  test("replaces the entry for a root that is scanned again", async () => {
    await cache.write(ROOT, DEPTH, ["/code/alpha"]);
    await cache.write(ROOT, DEPTH, ["/code/beta"]);

    expect(await cache.read(ROOT, DEPTH)).toEqual(["/code/beta"]);
  });

  test("stores an empty scan as a hit, not a miss", async () => {
    await cache.write(ROOT, DEPTH, []);

    expect(await cache.read(ROOT, DEPTH)).toEqual([]);
  });

  describe("when the depth differs from the saved scan", () => {
    test("misses, because a deeper walk reaches more", async () => {
      await cache.write(ROOT, 3, ["/code/alpha"]);

      expect(await cache.read(ROOT, 5)).toBeNull();
    });
  });

  describe("when the cache file is corrupt", () => {
    test("misses", async () => {
      await Bun.write(file, "{ not json");

      expect(await cache.read(ROOT, DEPTH)).toBeNull();
    });

    test("recovers on the next write", async () => {
      await Bun.write(file, "{ not json");

      await cache.write(ROOT, DEPTH, ["/code/alpha"]);

      expect(await cache.read(ROOT, DEPTH)).toEqual(["/code/alpha"]);
    });
  });
});
