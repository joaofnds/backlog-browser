import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { symlink } from "node:fs/promises";
import { join } from "node:path";

import { DEFAULTS } from "../options.ts";
import { HubHarness } from "./hub.harness.ts";
import type { HubDriver, Inventory } from "./hub.harness.ts";

const FOUR_LEVELS_DOWN = join("a", "b", "c", "d");
const BELOW_DEFAULT_DEPTH = join("a", "b", "c", "d", "e", "f");

let harness: HubHarness;
let driver: HubDriver;

async function addAndDiscover(name: string): Promise<string> {
	const path = await harness.addProject(name, name.toLowerCase());
	const inventory = await driver.refresh();
	const project = inventory.projects.find(
		(candidate) => candidate.path === path,
	);
	if (!project) {
		throw new Error(`discovery did not produce a project at ${path}`);
	}

	return project.slug;
}

async function addProjects(...names: string[]): Promise<void> {
	for (const name of names) {
		await harness.addProject(name, name.toLowerCase());
	}
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
	const slug = inventory.projects.find(
		(project) => project.path === path,
	)?.slug;
	if (!slug) {
		throw new Error(`no listed project at ${path}`);
	}

	return slug;
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

			expect(response.headers.get("content-type")).toStartWith(
				"text/javascript",
			);
		});
	});

	describe("GET /api/projects", () => {
		test("reports the searched root and depth", async () => {
			const inventory = await driver.projects();

			expect(inventory).toMatchObject({
				root: harness.root,
				depth: DEFAULTS.depth,
			});
		});

		test("lists nothing when the root holds no project", async () => {
			const inventory = await driver.projects();

			expect(inventory.projects).toEqual([]);
		});

		test("reports no remembered project on a fresh install", async () => {
			const inventory = await driver.projects();

			expect(inventory.active).toBeNull();
		});

		test("reports the project remembered by an earlier hub run", async () => {
			await harness.store.remember("remembered-0badcafe");

			const inventory = await driver.projects();

			expect(inventory.active).toEqual("remembered-0badcafe");
		});

		test("describes each project by slug, name and path", async () => {
			const path = await harness.addProject("Alpha", "alpha");
			await driver.refresh();

			const inventory = await driver.projects();
			const [project] = inventory.projects;

			expect(project).toMatchObject({ name: "Alpha", path });
			expect(project?.slug).toStartWith("alpha-");
		});
	});

	describe("GET /api/status?active=…", () => {
		test("answers the statuses when the shell names its on-screen project", async () => {
			const slug = await addAndDiscover("Alpha");
			await driver.activate(slug);

			const response = await driver.get(`/api/status?active=${slug}`);

			expect(await response.json()).toMatchObject({ [slug]: "starting" });
		});

		test("tolerates a slug it does not know", async () => {
			await addAndDiscover("Alpha");

			const response = await driver.get("/api/status?active=gone-12345678");

			expect(response.status).toBe(200);
		});
	});

	describe("the idle sweep", () => {
		test("spares only the child the shell reports on screen", async () => {
			harness = await harness.restart({ idleTimeoutMs: 1000 });
			driver = harness.driver();
			const alpha = await addAndDiscover("Alpha");
			const beta = await addAndDiscover("Beta");
			await driver.activate(alpha);
			await readyUp(alpha);
			await driver.activate(beta);
			await readyUp(beta);

			harness.clock.now += 1001;
			await driver.get(`/api/status?active=${alpha}`);
			harness.supervisor.stopIdle();

			expect(await driver.statuses()).toMatchObject({
				[alpha]: "ready",
				[beta]: "idle",
			});
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

			expect(harness.backlog.childFor(pathTo("Beta")).spec.port).toEqual(
				before,
			);
		});

		test("starts the project anyway when that port is taken", async () => {
			const slug = await addAndDiscover("Alpha");
			await driver.activate(slug);
			const before = harness.backlog.childFor(pathTo("Alpha")).spec.port;

			harness = await harness.restart();
			driver = harness.driver();
			harness.backlog.occupy(before);
			harness.backlog.answersAnywhere();
			await driver.activate(slug);
			await harness.supervisor.settled(harness.projectFor(slug));

			const response = await driver.status(slug);

			expect(await response.json()).toMatchObject({ status: "ready" });
		});
	});

	describe("POST /api/refresh", () => {
		test("picks up a project added after startup", async () => {
			await harness.addProject("Latecomer", "latecomer");

			const inventory = await driver.refresh();

			expect(inventory.projects.map((project) => project.name)).toEqual([
				"Latecomer",
			]);
		});

		test("misses a project below the depth the request names", async () => {
			await harness.addProject("Buried", FOUR_LEVELS_DOWN);

			const inventory = await driver.refresh(3);

			expect(inventory.projects).toEqual([]);
		});

		test("finds it once the request names a depth that reaches it", async () => {
			await harness.addProject("Buried", FOUR_LEVELS_DOWN);

			const inventory = await driver.refresh(4);

			expect(inventory.projects.map((project) => project.name)).toEqual([
				"Buried",
			]);
		});

		test("reports the depth it walked at", async () => {
			const inventory = await driver.refresh(7);

			expect(inventory.depth).toBe(7);
		});

		test("keeps the startup depth when the request names none", async () => {
			const inventory = await driver.refresh();

			expect(inventory.depth).toBe(DEFAULTS.depth);
		});

		test("walks at the remembered depth on the next hub run", async () => {
			await driver.refresh(7);

			harness = await harness.restart();
			driver = harness.driver();

			const inventory = await driver.projects();

			expect(inventory.depth).toBe(7);
		});

		describe("when the depth is out of range", () => {
			test("responds 400", async () => {
				const response = await driver.refreshing(0);

				expect(response.status).toBe(400);
			});

			test("leaves the depth alone", async () => {
				await driver.refreshing(0);

				const inventory = await driver.projects();

				expect(inventory.depth).toBe(DEFAULTS.depth);
			});
		});
	});

	describe("startup", () => {
		test("prefers the depth flag over the remembered depth", async () => {
			await driver.refresh(7);

			harness = await harness.restart({ depth: 2 });
			driver = harness.driver();

			const inventory = await driver.projects();

			expect(inventory.depth).toBe(2);
		});

		test("serves the cached walk instead of walking again", async () => {
			await harness.addProject("Latecomer");

			harness = await harness.restart();
			driver = harness.driver();

			const inventory = await driver.projects();

			expect(inventory.projects).toEqual([]);
		});

		test("walks again when started with --rescan", async () => {
			await harness.addProject("Latecomer");

			harness = await harness.restart({ rescan: true });
			driver = harness.driver();

			const inventory = await driver.projects();

			expect(inventory.projects.map((project) => project.name)).toEqual([
				"Latecomer",
			]);
		});
	});

	describe("POST /api/choose-folder", () => {
		test("opens the chooser at the hub's root", async () => {
			await driver.chooseFolder();

			expect(harness.chooser.openedAt).toEqual([harness.root]);
		});

		test("reports the folder the user chose", async () => {
			harness.chooser.chooses(join(harness.root, "somewhere"));

			const response = await driver.chooseFolder();

			expect(await response.json()).toEqual({
				kind: "chosen",
				path: join(harness.root, "somewhere"),
			});
		});

		test("reports a dismissed chooser as cancelled", async () => {
			harness.chooser.cancels();

			const response = await driver.chooseFolder();

			expect(await response.json()).toEqual({ kind: "cancelled" });
		});

		describe("when the chooser itself fails", () => {
			test("responds 500 rather than calling the platform unsupported", async () => {
				harness.chooser.fails("The chooser closed without answering.");

				const response = await driver.chooseFolder();

				expect(response.status).toBe(500);
			});
		});

		describe("when the host has no chooser", () => {
			test("responds 501 naming the reason", async () => {
				harness.chooser.breaks("No folder chooser on linux.");

				const response = await driver.chooseFolder();

				expect(response.status).toBe(501);
				expect(await response.json()).toEqual({
					error: "No folder chooser on linux.",
				});
			});
		});
	});

	describe("POST /api/list/added", () => {
		test("lists a project nested below the discovery depth", async () => {
			const path = await harness.addProject("Buried", BELOW_DEFAULT_DEPTH);

			const inventory = await driver.adding(path);

			expect(inventory.projects.map((project) => project.name)).toEqual([
				"Buried",
			]);
		});

		test("keeps it through a walk that would never find it", async () => {
			const path = await harness.addProject("Buried", BELOW_DEFAULT_DEPTH);
			await driver.addPath(path);

			const inventory = await driver.refresh();

			expect(inventory.projects.map((project) => project.name)).toEqual([
				"Buried",
			]);
		});

		test("keeps it for the next hub run", async () => {
			const path = await harness.addProject("Buried", BELOW_DEFAULT_DEPTH);
			await driver.addPath(path);

			harness = await harness.restart();
			driver = harness.driver();

			const inventory = await driver.projects();

			expect(inventory.projects.map((project) => project.name)).toEqual([
				"Buried",
			]);
		});

		test("lists it once when a later walk finds it too", async () => {
			const path = await harness.addProject("Buried", join("a", "b"));
			await driver.addPath(path);

			const inventory = await driver.refresh();

			expect(inventory.projects.map((project) => project.name)).toEqual([
				"Buried",
			]);
		});

		test("marks it as added so the shell can offer to remove it", async () => {
			const path = await harness.addProject("Buried", BELOW_DEFAULT_DEPTH);

			const inventory = await driver.adding(path);

			expect(inventory.projects[0]).toMatchObject({ added: true });
		});

		test("stops marking it as added once a walk reaches it too", async () => {
			const path = await harness.addProject("Shallow", "shallow");
			await driver.addPath(path);

			const inventory = await driver.refresh();

			expect(inventory.projects[0]).toMatchObject({
				name: "Shallow",
				added: false,
			});
		});

		test("leaves a walked project unmarked", async () => {
			await addProjects("Alpha");

			const inventory = await driver.projects();

			expect(inventory.projects[0]).toMatchObject({
				added: false,
			});
		});

		test("drops it again on request", async () => {
			const path = await harness.addProject("Buried", BELOW_DEFAULT_DEPTH);
			await driver.addPath(path);

			const inventory = await driver.dropping(path);

			expect(inventory.projects).toEqual([]);
		});

		describe("when the folder holds no board", () => {
			test("responds 400", async () => {
				const response = await driver.addPath(harness.root);

				expect(response.status).toBe(400);
			});

			test("lists nothing new", async () => {
				await driver.addPath(harness.root);

				const inventory = await driver.projects();

				expect(inventory.projects).toEqual([]);
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

			expect(await harness.store.lastActive()).toEqual(slug);
		});

		describe("when the slug is unknown", () => {
			test("responds 404", async () => {
				const response = await driver.activate("ghost-00000000");

				expect(response.status).toBe(404);
			});
		});
	});

	describe("GET /api/projects/:slug", () => {
		test("reports the child's url once it answers", async () => {
			const slug = await addAndDiscover("Alpha");
			await driver.activate(slug);
			await readyUp(slug);

			const response = await driver.status(slug);
			const activation = (await response.json()) as { url: string };

			expect(activation).toMatchObject({ status: "ready" });
			expect(activation.url).toStartWith("http://127.0.0.1:");
		});

		test("reports a project nobody activated as idle", async () => {
			const slug = await addAndDiscover("Alpha");

			const response = await driver.status(slug);

			expect(await response.json()).toEqual({
				status: "idle",
			});
		});

		describe("when the slug is unknown", () => {
			test("responds 404", async () => {
				const response = await driver.status("ghost-00000000");

				expect(response.status).toBe(404);
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

		test("keeps the hidden project reachable by slug", async () => {
			await addProjects("Alpha");
			const slug = slugAt(await driver.projects(), pathTo("Alpha"));

			await driver.hide(pathTo("Alpha"));

			const response = await driver.status(slug);

			expect(response.status).toBe(200);
		});

		test("keeps the hidden project activatable", async () => {
			await addProjects("Alpha");
			const slug = slugAt(await driver.projects(), pathTo("Alpha"));

			await driver.hide(pathTo("Alpha"));

			const response = await driver.activate(slug);

			expect(response.status).toBe(200);
		});

		test("unhides the project again", async () => {
			await addProjects("Alpha", "Beta");
			await driver.hide(pathTo("Alpha"));

			const inventory = await driver.show(pathTo("Alpha"));

			expect(pathsOf(inventory, { hidden: true })).toEqual([]);
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

		describe("when the body is malformed", () => {
			test("responds 400", async () => {
				const response = await driver.post("/api/list/order", { before: null });

				expect(response.status).toBe(400);
			});
		});
	});

	describe("POST /api/list/reset", () => {
		test("restores the name order", async () => {
			await addProjects("Alpha", "Beta", "Gamma");
			await driver.move(pathTo("Gamma"), pathTo("Alpha"));

			expect(pathsOf(await driver.resetOrder(), { hidden: false })).toEqual([
				pathTo("Alpha"),
				pathTo("Beta"),
				pathTo("Gamma"),
			]);
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

	/**
	 * The hub is a long-lived server on a known loopback port, so any page the user visits can post
	 * to it. Only the shell it serves may drive it.
	 */
	describe("a request from another site", () => {
		const ELSEWHERE = "https://evil.example.com";

		test("cannot change the project list", async () => {
			const path = await addAndDiscover("Alpha").then(() => pathTo("Alpha"));

			const response = await driver.postFrom(ELSEWHERE, "/api/list/hidden", {
				path,
				hidden: true,
			});

			expect(response.status).toBe(403);
			expect(pathsOf(await driver.projects(), { hidden: true })).toEqual([]);
		});

		test("cannot open the host's folder chooser", async () => {
			harness.chooser.chooses(join(harness.root, "anywhere"));

			const response = await driver.postFrom(
				ELSEWHERE,
				"/api/choose-folder",
				{},
			);

			expect(response.status).toBe(403);
			expect(harness.chooser.openedAt).toEqual([]);
		});

		test("cannot start a child", async () => {
			const slug = await addAndDiscover("Alpha");

			const response = await driver.postFrom(
				ELSEWHERE,
				`/api/projects/${slug}/activate`,
				{},
			);

			expect(response.status).toBe(403);
			expect(harness.backlog.launches).toEqual([]);
		});

		test("cannot walk the tree again", async () => {
			const response = await driver.postFrom(ELSEWHERE, "/api/refresh", {
				depth: 2,
			});

			expect(response.status).toBe(403);
		});

		test("but the shell opened at localhost is not another site", async () => {
			const { port } = new URL(driver.origin);

			const response = await driver.postFrom(
				`http://localhost:${port}`,
				"/api/refresh",
				{},
			);

			expect(response.status).toBe(200);
		});

		/** The hub speaks http, so the same name over https is somebody else. */
		test("cannot borrow the hub's own name under another scheme", async () => {
			const { port } = new URL(driver.origin);

			const response = await driver.postFrom(
				`https://localhost:${port}`,
				"/api/refresh",
				{},
			);

			expect(response.status).toBe(403);
		});
	});

	/**
	 * A name an attacker points back at 127.0.0.1 is same-origin to the browser, which would turn
	 * the block above into a channel they can also read the answers from.
	 */
	describe("a request arriving under another name", () => {
		test("is refused", async () => {
			const response = await driver.getAs(
				"attacker.example.com",
				"/api/projects",
			);

			expect(response.status).toBe(403);
		});

		test("is refused before it can report a project's path", async () => {
			await addAndDiscover("Alpha");

			const response = await driver.getAs(
				"attacker.example.com",
				"/api/projects",
			);

			expect(await response.text()).not.toContain(harness.root);
		});

		test("still answers the hub's own host", async () => {
			const response = await driver.getAs(
				new URL(driver.origin).host,
				"/api/projects",
			);

			expect(response.status).toBe(200);
		});

		test("still answers localhost, which is what a user types", async () => {
			const response = await driver.getAs(
				`localhost:${new URL(driver.origin).port}`,
				"/",
			);

			expect(response.status).toBe(200);
		});

		test("refuses localhost on another port", async () => {
			const response = await driver.getAs("localhost:1", "/api/projects");

			expect(response.status).toBe(403);
		});

		/** Host names are case-insensitive, so a client that keeps the case is still the hub's own. */
		test("answers its own name whatever the case", async () => {
			const response = await driver.getAs(
				`LOCALHOST:${new URL(driver.origin).port}`,
				"/",
			);

			expect(response.status).toBe(200);
		});

		/**
		 * A raw client can leave the header out altogether, and treating "absent" as "mine" let one
		 * through: the answer names every project's path, and the same request opened the chooser.
		 */
		test("refuses a request that names no host at all", async () => {
			const response = await driver.hostless("/api/projects");

			expect(response.status).toBe(403);
			expect(await response.text()).not.toContain(harness.root);
		});
	});

	/**
	 * Two spellings of one directory are one project: the slug is derived from the path, so an
	 * unresolved `..` would list the same board twice and remove only one of them.
	 */
	describe("a path spelled with a traversal", () => {
		test("adds the same project once", async () => {
			const path = await harness.addProject("Outside", "outside");
			const detour = `${harness.root}/elsewhere/../outside`;

			await driver.addPath(path);
			await driver.addPath(detour);

			const inventory = await driver.projects();
			const listed = inventory.projects.filter(
				(project) => project.path === path || project.path === detour,
			);
			expect(listed).toHaveLength(1);
		});

		test("is removed by its plain spelling", async () => {
			const path = await harness.addProject("Outside", "outside");
			await driver.addPath(`${harness.root}/elsewhere/../outside`);

			await driver.dropPath(path);

			const inventory = await driver.projects();

			expect(inventory.projects.map((project) => project.path)).not.toContain(
				path,
			);
		});

		/** A link to a project folder is that folder, not a second board sitting beside it. */
		test("adds a symlinked directory once", async () => {
			const path = await harness.addProject("Outside", "outside");
			const link = join(harness.root, "shortcut");
			await symlink(path, link);

			await driver.addPath(path);
			await driver.addPath(link);

			const inventory = await driver.projects();
			const listed = inventory.projects.filter(
				(project) => project.path === path || project.path === link,
			);
			expect(listed).toHaveLength(1);
		});
	});
});
