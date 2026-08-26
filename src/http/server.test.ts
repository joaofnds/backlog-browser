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

    test("describes a project without its activation status", async () => {
      await addAndDiscover("Alpha");

      const [project] = (await driver.projects()).projects;

      expect(project).not.toHaveProperty("status");
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

    test("walks at the depth the request names", async () => {
      await harness.addProject("Buried", join("a", "b", "c", "d"));

      const inventory = await driver.refresh(5);

      expect(inventory.projects.map((project) => project.name)).toEqual(["Buried"]);
    });

    test("reports the depth it walked at", async () => {
      expect((await driver.refresh(7)).depth).toBe(7);
    });

    test("keeps the startup depth when the request names none", async () => {
      expect((await driver.refresh()).depth).toBe(3);
    });

    test("walks at the remembered depth on the next hub run", async () => {
      await harness.addProject("Buried", join("a", "b", "c", "d"));
      await driver.refresh(5);

      harness = await harness.restart();
      driver = harness.driver();

      expect((await driver.projects()).projects.map((project) => project.name)).toEqual(["Buried"]);
    });

    describe("when the depth is out of range", () => {
      test("responds 400", async () => {
        expect((await driver.refreshing(0)).status).toBe(400);
      });

      test("leaves the depth alone", async () => {
        await driver.refreshing(0);

        expect((await driver.projects()).depth).toBe(3);
      });
    });
  });

  describe("POST /api/pick-folder", () => {
    test("opens the picker at the hub's root", async () => {
      await driver.pickFolder();

      expect(harness.picker.openedAt).toEqual([harness.root]);
    });

    test("reports the folder the user chose", async () => {
      harness.picker.chooses(join(harness.root, "somewhere"));

      expect(await (await driver.pickFolder()).json()).toEqual({
        kind: "chosen",
        path: join(harness.root, "somewhere"),
      });
    });

    test("reports a dismissed picker as cancelled", async () => {
      harness.picker.cancels();

      expect(await (await driver.pickFolder()).json()).toEqual({ kind: "cancelled" });
    });

    describe("when the picker itself fails", () => {
      test("responds 500 rather than calling the platform unsupported", async () => {
        harness.picker.fails("The folder picker closed without answering.");

        expect((await driver.pickFolder()).status).toBe(500);
      });
    });

    describe("when the host has no picker", () => {
      test("responds 501 naming the reason", async () => {
        harness.picker.breaks("No folder picker on linux.");

        const response = await driver.pickFolder();

        expect(response.status).toBe(501);
        expect(await response.json()).toEqual({ error: "No folder picker on linux." });
      });
    });
  });

  describe("POST /api/list/added", () => {
    test("lists a project nested below the discovery depth", async () => {
      const path = await harness.addProject("Buried", join("a", "b", "c", "d"));

      const inventory = (await (await driver.addPath(path)).json()) as Inventory;

      expect(inventory.projects.map((project) => project.name)).toEqual(["Buried"]);
    });

    test("keeps it through a walk that would never find it", async () => {
      const path = await harness.addProject("Buried", join("a", "b", "c", "d"));
      await driver.addPath(path);

      const inventory = await driver.refresh();

      expect(inventory.projects.map((project) => project.name)).toEqual(["Buried"]);
    });

    test("keeps it for the next hub run", async () => {
      const path = await harness.addProject("Buried", join("a", "b", "c", "d"));
      await driver.addPath(path);

      harness = await harness.restart();
      driver = harness.driver();

      expect((await driver.projects()).projects.map((project) => project.name)).toEqual(["Buried"]);
    });

    test("lists it once when a later walk finds it too", async () => {
      const path = await harness.addProject("Buried", join("a", "b"));
      await driver.addPath(path);

      const inventory = await driver.refresh();

      expect(inventory.projects.map((project) => project.name)).toEqual(["Buried"]);
    });

    test("marks it as added so the shell can offer to remove it", async () => {
      const path = await harness.addProject("Buried", join("a", "b", "c", "d"));

      const inventory = (await (await driver.addPath(path)).json()) as Inventory;

      expect(inventory.projects[0]).toMatchObject({ added: true });
    });

    test("stops marking it as added once a walk reaches it too", async () => {
      const path = await harness.addProject("Shallow", "shallow");
      await driver.addPath(path);

      const inventory = await driver.refresh();

      expect(inventory.projects[0]).toMatchObject({ name: "Shallow", added: false });
    });

    test("leaves a walked project unmarked", async () => {
      await addProjects("Alpha");

      expect((await driver.projects()).projects[0]).toMatchObject({ added: false });
    });

    test("drops it again on request", async () => {
      const path = await harness.addProject("Buried", join("a", "b", "c", "d"));
      await driver.addPath(path);

      const inventory = (await (await driver.dropPath(path)).json()) as Inventory;

      expect(inventory.projects).toEqual([]);
    });

    describe("when the folder holds no board", () => {
      test("responds 400", async () => {
        expect((await driver.addPath(harness.root)).status).toBe(400);
      });

      test("lists nothing new", async () => {
        await driver.addPath(harness.root);

        expect((await driver.projects()).projects).toEqual([]);
      });
    });
  });

  describe("POST /api/settings", () => {
    test("reports the cap it now holds", async () => {
      expect(await (await driver.resize(2)).json()).toMatchObject({ maxChildren: 2 });
    });

    test("stops the children that no longer fit", async () => {
      await addProjects("Alpha", "Beta");
      const inventory = await driver.projects();
      await driver.activate(slugAt(inventory, pathTo("Alpha")));
      await driver.activate(slugAt(inventory, pathTo("Beta")));

      await driver.resize(1);

      expect(harness.backlog.childFor(pathTo("Alpha")).killed).toBe(true);
      expect(harness.backlog.childFor(pathTo("Beta")).killed).toBe(false);
    });

    test("keeps the cap for the next hub run", async () => {
      await driver.resize(7);

      harness = await harness.restart();
      driver = harness.driver();

      expect((await driver.projects()).maxChildren).toBe(7);
    });

    describe("when the cap is out of range", () => {
      test("responds 400", async () => {
        expect((await driver.resize(0)).status).toBe(400);
      });

      test("leaves the cap alone", async () => {
        await driver.resize(0);

        expect((await driver.projects()).maxChildren).toBe(4);
      });
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

    test("answers no-store, because the shell polls it", async () => {
      const response = await driver.get("/api/status");

      expect(response.headers.get("cache-control")).toEqual("no-store");
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
