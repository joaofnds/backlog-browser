import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectList } from "../list/list.ts";
import { PortBook } from "./port-book.ts";
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

  describe("the project list", () => {
    test("starts empty for a root that was never opened", async () => {
      expect(await new StateStore({ file }).list(ROOT)).toEqual(ProjectList.empty());
    });

    test("carries the list across hub restarts", async () => {
      const list = ProjectList.empty().hide("/code/alpha");

      await new StateStore({ file }).updateList(ROOT, () => list);

      expect(await new StateStore({ file }).list(ROOT)).toEqual(list);
    });

    test("keeps one list per root", async () => {
      const store = new StateStore({ file });

      await store.updateList(ROOT, (list) => list.hide("/code/alpha"));

      expect(await store.list(OTHER_ROOT)).toEqual(ProjectList.empty());
    });

    test("survives activating a project", async () => {
      const store = new StateStore({ file });
      const list = ProjectList.empty().hide("/code/alpha");

      await store.updateList(ROOT, () => list);
      await store.remember(ROOT, "beta-5678efgh");

      expect(await store.list(ROOT)).toEqual(list);
    });

    test("leaves the remembered project alone", async () => {
      const store = new StateStore({ file });

      await store.remember(ROOT, "alpha-1234abcd");
      await store.updateList(ROOT, (list) => list.hide("/code/alpha"));

      expect(await store.lastActive(ROOT)).toEqual("alpha-1234abcd");
    });

    test("loses neither write when both land at once", async () => {
      const store = new StateStore({ file });
      const list = ProjectList.empty().hide("/code/alpha");

      await Promise.all([
        store.remember(ROOT, "alpha-1234abcd"),
        store.updateList(ROOT, () => list),
      ]);

      expect(await store.lastActive(ROOT)).toEqual("alpha-1234abcd");
      expect(await store.list(ROOT)).toEqual(list);
    });
  });

  describe("remembered ports", () => {
    test("starts empty for a root that was never opened", async () => {
      expect(await new StateStore({ file }).ports(ROOT)).toEqual(PortBook.empty());
    });

    test("hands back the port a project was given", async () => {
      const store = new StateStore({ file });

      await store.rememberPort(ROOT, "/code/alpha", 40_001);

      expect((await store.ports(ROOT)).portFor("/code/alpha")).toEqual(40_001);
    });

    test("carries the ports across hub restarts", async () => {
      await new StateStore({ file }).rememberPort(ROOT, "/code/alpha", 40_001);

      expect((await new StateStore({ file }).ports(ROOT)).portFor("/code/alpha")).toEqual(40_001);
    });

    test("keeps one set of ports per root", async () => {
      const store = new StateStore({ file });

      await store.rememberPort(ROOT, "/code/alpha", 40_001);

      expect(await store.ports(OTHER_ROOT)).toEqual(PortBook.empty());
    });

    test("survives activating a project", async () => {
      const store = new StateStore({ file });

      await store.rememberPort(ROOT, "/code/alpha", 40_001);
      await store.remember(ROOT, "beta-5678efgh");

      expect((await store.ports(ROOT)).portFor("/code/alpha")).toEqual(40_001);
    });

    test("survives hiding a project", async () => {
      const store = new StateStore({ file });

      await store.rememberPort(ROOT, "/code/alpha", 40_001);
      await store.updateList(ROOT, (list) => list.hide("/code/alpha"));

      expect((await store.ports(ROOT)).portFor("/code/alpha")).toEqual(40_001);
    });

    test("leaves the list alone", async () => {
      const store = new StateStore({ file });
      const list = ProjectList.empty().hide("/code/alpha");

      await store.updateList(ROOT, () => list);
      await store.rememberPort(ROOT, "/code/beta", 40_002);

      expect(await store.list(ROOT)).toEqual(list);
    });

    test("loses neither write when both land at once", async () => {
      const store = new StateStore({ file });

      await Promise.all([
        store.rememberPort(ROOT, "/code/alpha", 40_001),
        store.rememberPort(ROOT, "/code/beta", 40_002),
      ]);

      const ports = await store.ports(ROOT);
      expect(ports.portFor("/code/alpha")).toEqual(40_001);
      expect(ports.portFor("/code/beta")).toEqual(40_002);
    });
  });

  describe("when the root was stored before lists existed", () => {
    test("still reads the remembered project", async () => {
      await Bun.write(file, JSON.stringify({ roots: { [ROOT]: "alpha-1234abcd" } }));

      expect(await new StateStore({ file }).lastActive(ROOT)).toEqual("alpha-1234abcd");
    });

    test("reads an empty list", async () => {
      await Bun.write(file, JSON.stringify({ roots: { [ROOT]: "alpha-1234abcd" } }));

      expect(await new StateStore({ file }).list(ROOT)).toEqual(ProjectList.empty());
    });

    test("reads an empty set of ports", async () => {
      await Bun.write(file, JSON.stringify({ roots: { [ROOT]: "alpha-1234abcd" } }));

      expect(await new StateStore({ file }).ports(ROOT)).toEqual(PortBook.empty());
    });

    test("keeps the remembered project once a list is saved", async () => {
      await Bun.write(file, JSON.stringify({ roots: { [ROOT]: "alpha-1234abcd" } }));
      const store = new StateStore({ file });

      await store.updateList(ROOT, (list) => list.hide("/code/alpha"));

      expect(await store.lastActive(ROOT)).toEqual("alpha-1234abcd");
    });
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
