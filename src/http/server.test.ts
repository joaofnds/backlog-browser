import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { type HubDriver, HubHarness, type Inventory } from "./hub.harness.ts";

let harness: HubHarness;
let driver: HubDriver;

async function addAndDiscover(name: string): Promise<string> {
  const path = await harness.addProject(name, name.toLowerCase());
  const inventory = await driver.refresh();
  const project = inventory.projects.find((candidate) => candidate.path === path);

  return project?.slug ?? "";
}

async function addProjects(...names: string[]): Promise<void> {
  for (const name of names) await harness.addProject(name, name.toLowerCase());
  await driver.refresh();
}

function pathTo(name: string): string {
  return join(harness.root, name.toLowerCase());
}

function pathsOf(inventory: Inventory, filter: { hidden: boolean }): string[] {
  return inventory.projects
    .filter((project) => project.hidden === filter.hidden)
    .map((project) => project.path);
}

function slugAt(inventory: Inventory, path: string): string {
  return inventory.projects.find((project) => project.path === path)?.slug ?? "";
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
      expect(await response.text()).toContain('<main class="stage">');
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

  describe("across hub runs", () => {
    test("gives a project back the port it had", async () => {
      await addProjects("Alpha", "Beta");
      const inventory = await driver.projects();
      const beta = slugAt(inventory, pathTo("Beta"));
      await driver.activate(slugAt(inventory, pathTo("Alpha")));
      await driver.activate(beta);
      const before = harness.backlog.childFor(pathTo("Beta")).spec.port;

      harness = await harness.restart();
      driver = harness.driver();
      await driver.activate(beta);

      expect(harness.backlog.childFor(pathTo("Beta")).spec.port).toEqual(before);
    });

    test("starts the project anyway when that port is taken", async () => {
      const slug = await addAndDiscover("Alpha");
      await driver.activate(slug);
      const before = harness.backlog.childFor(pathTo("Alpha")).spec.port;

      harness = await harness.restart();
      driver = harness.driver();
      harness.backlog.occupy(before);
      await driver.activate(slug);
      await readyUp(slug);

      expect(await (await driver.status(slug)).json()).toMatchObject({ status: "ready" });
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

  describe("GET /api/status", () => {
    test("reports a project nobody activated as idle", async () => {
      const slug = await addAndDiscover("Alpha");

      expect(await driver.statuses()).toEqual({ [slug]: "idle" });
    });

    test("reports a child that answered as ready", async () => {
      const slug = await addAndDiscover("Alpha");
      await driver.activate(slug);
      await readyUp(slug);

      expect(await driver.statuses()).toEqual({ [slug]: "ready" });
    });

    test("reports a child that exited on its own as failed", async () => {
      const slug = await addAndDiscover("Alpha");
      await driver.activate(slug);
      await readyUp(slug);

      const child = harness.backlog.childFor(harness.projectFor(slug).path);
      child.crash("boom", 9);
      await child.exited;

      expect(await driver.statuses()).toEqual({ [slug]: "failed" });
    });
  });

  describe("POST /api/list/hidden", () => {
    test("flags the project as hidden", async () => {
      await addProjects("Alpha", "Beta");

      const inventory = await driver.hide(pathTo("Alpha"));

      expect(pathsOf(inventory, { hidden: true })).toEqual([pathTo("Alpha")]);
    });

    test("sinks the hidden project below the visible ones", async () => {
      await addProjects("Alpha", "Beta");

      const inventory = await driver.hide(pathTo("Alpha"));

      expect(inventory.projects.map((project) => project.path)).toEqual([
        pathTo("Beta"),
        pathTo("Alpha"),
      ]);
    });

    test("keeps the hidden project reachable by slug", async () => {
      await addProjects("Alpha");
      const slug = slugAt(await driver.projects(), pathTo("Alpha"));

      await driver.hide(pathTo("Alpha"));

      expect((await driver.status(slug)).status).toBe(200);
    });

    test("keeps the hidden project activatable", async () => {
      await addProjects("Alpha");
      const slug = slugAt(await driver.projects(), pathTo("Alpha"));

      await driver.hide(pathTo("Alpha"));

      expect((await driver.activate(slug)).status).toBe(200);
    });

    test("unhides the project again", async () => {
      await addProjects("Alpha", "Beta");
      await driver.hide(pathTo("Alpha"));

      const inventory = await driver.show(pathTo("Alpha"));

      expect(pathsOf(inventory, { hidden: true })).toEqual([]);
    });

    test("drops an unhidden project at the end of a manual order", async () => {
      await addProjects("Alpha", "Beta", "Gamma");
      await driver.move(pathTo("Gamma"), pathTo("Alpha"));
      await driver.hide(pathTo("Alpha"));

      const inventory = await driver.show(pathTo("Alpha"));

      expect(pathsOf(inventory, { hidden: false })).toEqual([
        pathTo("Gamma"),
        pathTo("Beta"),
        pathTo("Alpha"),
      ]);
    });

    describe("when the body is malformed", () => {
      test("responds 400", async () => {
        const response = await driver.post("/api/list/hidden", { path: 7 });

        expect(response.status).toBe(400);
      });
    });
  });

  describe("POST /api/list/order", () => {
    test("moves the project in front of another", async () => {
      await addProjects("Alpha", "Beta", "Gamma");

      const inventory = await driver.move(pathTo("Gamma"), pathTo("Alpha"));

      expect(pathsOf(inventory, { hidden: false })).toEqual([
        pathTo("Gamma"),
        pathTo("Alpha"),
        pathTo("Beta"),
      ]);
    });

    test("switches the order mode to manual", async () => {
      await addProjects("Alpha", "Beta", "Gamma");

      expect((await driver.move(pathTo("Gamma"), pathTo("Alpha"))).mode).toEqual("manual");
    });

    test("puts the project last when no anchor is named", async () => {
      await addProjects("Alpha", "Beta", "Gamma");

      const inventory = await driver.move(pathTo("Alpha"), null);

      expect(pathsOf(inventory, { hidden: false })).toEqual([
        pathTo("Beta"),
        pathTo("Gamma"),
        pathTo("Alpha"),
      ]);
    });

    test("appends a project discovered after the order was set", async () => {
      await addProjects("Alpha", "Beta", "Gamma");
      await driver.move(pathTo("Gamma"), pathTo("Alpha"));
      await harness.addProject("Aardvark", "aardvark");

      const inventory = await driver.refresh();

      expect(pathsOf(inventory, { hidden: false })).toEqual([
        pathTo("Gamma"),
        pathTo("Alpha"),
        pathTo("Beta"),
        pathTo("Aardvark"),
      ]);
    });

    describe("when the body is malformed", () => {
      test("responds 400", async () => {
        const response = await driver.post("/api/list/order", { before: null });

        expect(response.status).toBe(400);
      });
    });
  });

  describe("POST /api/list/reset", () => {
    test("returns the order mode to default", async () => {
      await addProjects("Alpha", "Beta", "Gamma");
      await driver.move(pathTo("Gamma"), pathTo("Alpha"));

      expect((await driver.resetOrder()).mode).toEqual("default");
    });

    test("restores the name order", async () => {
      await addProjects("Alpha", "Beta", "Gamma");
      await driver.move(pathTo("Gamma"), pathTo("Alpha"));

      expect(pathsOf(await driver.resetOrder(), { hidden: false })).toEqual([
        pathTo("Alpha"),
        pathTo("Beta"),
        pathTo("Gamma"),
      ]);
    });

    test("keeps hidden projects hidden", async () => {
      await addProjects("Alpha", "Beta", "Gamma");
      await driver.move(pathTo("Gamma"), pathTo("Alpha"));
      await driver.hide(pathTo("Alpha"));

      expect(pathsOf(await driver.resetOrder(), { hidden: true })).toEqual([pathTo("Alpha")]);
    });

    test("slots a newly discovered project by name again", async () => {
      await addProjects("Alpha", "Beta", "Gamma");
      await driver.move(pathTo("Gamma"), pathTo("Alpha"));
      await driver.resetOrder();
      await harness.addProject("Aardvark", "aardvark");

      const inventory = await driver.refresh();

      expect(pathsOf(inventory, { hidden: false })).toEqual([
        pathTo("Aardvark"),
        pathTo("Alpha"),
        pathTo("Beta"),
        pathTo("Gamma"),
      ]);
    });
  });

  describe("an unknown path", () => {
    test("responds 404", async () => {
      const response = await driver.get("/nope");

      expect(response.status).toBe(404);
    });
  });
});
