import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { type HubDriver, HubHarness } from "./hub.harness.ts";

let harness: HubHarness;
let driver: HubDriver;

async function addAndDiscover(name: string): Promise<string> {
  const path = await harness.addProject(name, name.toLowerCase());
  const inventory = await driver.refresh();
  const project = inventory.projects.find((candidate) => candidate.path === path);

  return project?.slug ?? "";
}

async function readyUp(slug: string): Promise<void> {
  const project = harness.projectFor(slug);
  harness.backlog.answerOn(harness.backlog.childFor(project.path).spec.port);
  await harness.supervisor.settled(project);
}

beforeEach(async () => {
  harness = await HubHarness.start();
  driver = harness.driver();
});

afterEach(async () => {
  await harness.stop();
});

describe("hub server", () => {
  test("binds the loopback interface only", () => {
    expect(driver.origin).toStartWith("http://127.0.0.1:");
  });

  describe("GET /", () => {
    test("serves the shell document", async () => {
      const response = await driver.get("/");

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toStartWith("text/html");
      expect(await response.text()).toContain('<iframe class="board"');
    });

    test("serves the shell for a project deep link", async () => {
      const response = await driver.get("/?project=anything");

      expect(response.status).toBe(200);
    });
  });

  describe("GET /shell.css", () => {
    test("serves the stylesheet", async () => {
      const response = await driver.get("/shell.css");

      expect(response.headers.get("content-type")).toStartWith("text/css");
      expect(await response.text()).toContain(".toolbar");
    });
  });

  describe("GET /shell.js", () => {
    test("serves the script", async () => {
      const response = await driver.get("/shell.js");

      expect(response.headers.get("content-type")).toStartWith("text/javascript");
    });
  });

  describe("GET /api/projects", () => {
    test("reports the searched root and depth", async () => {
      const inventory = await driver.projects();

      expect(inventory).toMatchObject({ root: harness.root, depth: 3 });
    });

    test("lists nothing when the root holds no project", async () => {
      expect((await driver.projects()).projects).toEqual([]);
    });

    test("reports no remembered project on a fresh install", async () => {
      expect((await driver.projects()).active).toBeNull();
    });

    test("reports the project remembered by an earlier hub run", async () => {
      await harness.store.remember(harness.root, "remembered-0badcafe");

      expect((await driver.projects()).active).toEqual("remembered-0badcafe");
    });

    test("describes each project by slug, name and path", async () => {
      const path = await harness.addProject("Alpha", "alpha");
      await driver.refresh();

      const [project] = (await driver.projects()).projects;

      expect(project).toMatchObject({ name: "Alpha", path });
      expect(project?.slug).toStartWith("alpha-");
    });
  });

  describe("POST /api/refresh", () => {
    test("picks up a project added after startup", async () => {
      await harness.addProject("Latecomer", "latecomer");

      const inventory = await driver.refresh();

      expect(inventory.projects.map((project) => project.name)).toEqual(["Latecomer"]);
    });
  });

  describe("POST /api/projects/:slug/activate", () => {
    test("reports the project as starting", async () => {
      const slug = await addAndDiscover("Alpha");

      const response = await driver.activate(slug);

      expect(await response.json()).toEqual({ status: "starting" });
    });

    test("remembers the project for the next hub run", async () => {
      const slug = await addAndDiscover("Alpha");

      await driver.activate(slug);

      expect(await harness.store.lastActive(harness.root)).toEqual(slug);
    });

    describe("when the slug is unknown", () => {
      test("responds 404", async () => {
        expect((await driver.activate("ghost-00000000")).status).toBe(404);
      });
    });
  });

  describe("GET /api/projects/:slug", () => {
    test("reports the child's url once it answers", async () => {
      const slug = await addAndDiscover("Alpha");
      await driver.activate(slug);
      await readyUp(slug);

      const activation = (await (await driver.status(slug)).json()) as { url: string };

      expect(activation).toMatchObject({ status: "ready" });
      expect(activation.url).toStartWith("http://127.0.0.1:");
    });

    test("reports a project nobody activated as idle", async () => {
      const slug = await addAndDiscover("Alpha");

      expect(await (await driver.status(slug)).json()).toEqual({ status: "idle" });
    });

    describe("when the slug is unknown", () => {
      test("responds 404", async () => {
        expect((await driver.status("ghost-00000000")).status).toBe(404);
      });
    });
  });

  describe("an unknown path", () => {
    test("responds 404", async () => {
      const response = await driver.get("/nope");

      expect(response.status).toBe(404);
    });
  });
});
