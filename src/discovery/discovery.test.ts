import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverProjects } from "./discovery.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "backlog-hub-discovery-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function makeProject(relativePath: string, config = 'project_name: "Named"\n') {
  const path = relativePath === "." ? root : join(root, relativePath);
  await Bun.write(join(path, "backlog", "config.yml"), config);
  return path;
}

async function makePlainDirectory(relativePath: string) {
  await Bun.write(join(root, relativePath, "README.md"), "placeholder\n");
}

function namesOf(projects: { name: string }[]) {
  return projects.map((project) => project.name);
}

describe("discoverProjects", () => {
  test("finds a project directly under the root", async () => {
    const path = await makeProject("alpha");

    const projects = await discoverProjects({ root });

    expect(projects.map((project) => project.path)).toEqual([path]);
  });

  test("reads the project name from backlog/config.yml", async () => {
    await makeProject("alpha", 'project_name: "Alpha Board"\n');

    const projects = await discoverProjects({ root });

    expect(namesOf(projects)).toEqual(["Alpha Board"]);
  });

  test("finds the root itself when the root is a project", async () => {
    await makeProject(".", 'project_name: "Root Project"\n');

    const projects = await discoverProjects({ root });

    expect(namesOf(projects)).toEqual(["Root Project"]);
  });

  test("does not descend into a project once found", async () => {
    await makeProject("outer");
    await makeProject("outer/inner");

    const projects = await discoverProjects({ root });

    expect(projects.map((project) => project.path)).toEqual([join(root, "outer")]);
  });

  test("skips ignored directory names", async () => {
    await makeProject("node_modules/ghost");
    await makeProject("vendor/ghost");
    await makeProject("target/ghost");

    const projects = await discoverProjects({ root });

    expect(projects).toEqual([]);
  });

  test("skips dotted directories", async () => {
    await makeProject(".cache/ghost");

    const projects = await discoverProjects({ root });

    expect(projects).toEqual([]);
  });

  test("sorts projects by name, case-insensitively", async () => {
    await makeProject("one", 'project_name: "banana"\n');
    await makeProject("two", 'project_name: "Apple"\n');
    await makeProject("three", 'project_name: "cherry"\n');

    const projects = await discoverProjects({ root });

    expect(namesOf(projects)).toEqual(["Apple", "banana", "cherry"]);
  });

  test("returns nothing when the root holds no project", async () => {
    await makePlainDirectory("just/some/files");

    const projects = await discoverProjects({ root });

    expect(projects).toEqual([]);
  });

  describe("depth", () => {
    test("finds a project at the depth limit", async () => {
      const path = await makeProject("a/b/c");

      const projects = await discoverProjects({ root, depth: 3 });

      expect(projects.map((project) => project.path)).toEqual([path]);
    });

    test("ignores a project below the depth limit", async () => {
      await makeProject("a/b/c/d");

      const projects = await discoverProjects({ root, depth: 3 });

      expect(projects).toEqual([]);
    });
  });

  describe("when project_name is missing", () => {
    test("falls back to the directory name", async () => {
      await makeProject("fallback-dir", "default_status: Todo\n");

      const projects = await discoverProjects({ root });

      expect(namesOf(projects)).toEqual(["fallback-dir"]);
    });
  });

  describe("when the config cannot be parsed", () => {
    test("falls back to the directory name", async () => {
      await makeProject("broken-dir", "project_name: [unclosed\n\t\tbad: :\n");

      const projects = await discoverProjects({ root });

      expect(namesOf(projects)).toEqual(["broken-dir"]);
    });
  });
});
