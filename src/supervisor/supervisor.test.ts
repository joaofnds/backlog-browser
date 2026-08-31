import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Project } from "../discovery/project.ts";
import { FakeBacklog } from "./fake-backlog.ts";
import { MAX_PORT_ATTEMPTS, Supervisor } from "./supervisor.ts";
import type { Activation } from "./supervisor.ts";

const alpha = new Project({ path: "/code/alpha", name: "Alpha" });
const beta = new Project({ path: "/code/beta", name: "Beta" });

let backlog: FakeBacklog;
let clock: number;
let supervisors: Supervisor[];

function supervisorWith(
	overrides: Partial<ConstructorParameters<typeof Supervisor>[0]> = {},
): Supervisor {
	const supervisor = new Supervisor({
		launch: backlog.launch,
		probe: backlog.probe,
		portFor: backlog.portFor,
		idleTimeoutMs: 5 * 60_000,
		readyTimeoutMs: 1000,
		pollIntervalMs: 0,
		now: () => clock,
		...overrides,
	});
	supervisors.push(supervisor);

	return supervisor;
}

async function activateReady(
	supervisor: Supervisor,
	project: Project,
): Promise<Activation> {
	await supervisor.activate(project);
	backlog.answerOn(backlog.childFor(project.path).spec.port);
	await supervisor.settled(project);

	return supervisor.statusOf(project);
}

async function activateAllReady(
	supervisor: Supervisor,
	projects: readonly Project[],
): Promise<void> {
	for (const project of projects) {
		await activateReady(supervisor, project);
	}
}

beforeEach(() => {
	backlog = new FakeBacklog();
	clock = 0;
	supervisors = [];
});

/** Drains the supervise loop each test's activations left polling against the shared clock. */
afterEach(() => {
	for (const supervisor of supervisors) {
		supervisor.terminate();
	}
});

describe("Supervisor", () => {
	test("spawns nothing before a project is activated", () => {
		supervisorWith();

		expect(backlog.launches).toEqual([]);
	});

	test("spawns the child in the project directory", async () => {
		await supervisorWith().activate(alpha);

		expect(backlog.launches[0]?.cwd).toEqual("/code/alpha");
	});

	test("reports the project as starting before the child answers", async () => {
		const activation = await supervisorWith().activate(alpha);

		expect(activation).toEqual({ status: "starting" });
	});

	test("reports the child's url once it answers", async () => {
		const supervisor = supervisorWith();

		const activation = await activateReady(supervisor, alpha);

		const { port } = backlog.childFor(alpha.path).spec;
		expect(activation).toEqual({
			status: "ready",
			port,
			url: `http://127.0.0.1:${port}/`,
		});
	});

	test("gives each project its own port", async () => {
		const supervisor = supervisorWith();

		await supervisor.activate(alpha);
		await supervisor.activate(beta);

		expect(backlog.launches[0]?.port).not.toEqual(backlog.launches[1]?.port);
	});

	test("reuses the warm child on a second activation", async () => {
		const supervisor = supervisorWith();
		await activateReady(supervisor, alpha);

		await supervisor.activate(alpha);

		expect(backlog.launches).toHaveLength(1);
	});

	test("keeps a child warm after switching away", async () => {
		const supervisor = supervisorWith();
		await activateReady(supervisor, alpha);

		await activateReady(supervisor, beta);

		expect(supervisor.statusOf(alpha).status).toEqual("ready");
	});

	test("keeps every activated child warm, however many there are", async () => {
		const supervisor = supervisorWith();
		const projects = ["one", "two", "three", "four", "five", "six"].map(
			(name) => new Project({ path: `/code/${name}`, name }),
		);

		await activateAllReady(supervisor, projects);

		expect(backlog.live).toHaveLength(projects.length);
	});

	describe("when the child exits before it is ready", () => {
		test("reports the failure", async () => {
			const supervisor = supervisorWith();
			await supervisor.activate(alpha);

			backlog
				.childFor(alpha.path)
				.crash("Error: cannot read backlog/config.yml\n");
			await supervisor.settled(alpha);

			expect(supervisor.statusOf(alpha).status).toEqual("failed");
		});

		test("carries the child's last stderr lines", async () => {
			const supervisor = supervisorWith();
			await supervisor.activate(alpha);

			backlog
				.childFor(alpha.path)
				.crash("Error: cannot read backlog/config.yml\n");
			await supervisor.settled(alpha);

			expect(supervisor.statusOf(alpha)).toMatchObject({
				stderr: "Error: cannot read backlog/config.yml\n",
			});
		});

		test("does not spawn a replacement on its own", async () => {
			const supervisor = supervisorWith();
			await supervisor.activate(alpha);

			backlog.childFor(alpha.path).crash("boom");
			await supervisor.settled(alpha);

			expect(backlog.launches).toHaveLength(1);
		});

		test("spawns a replacement when the project is activated again", async () => {
			const supervisor = supervisorWith();
			await supervisor.activate(alpha);
			backlog.childFor(alpha.path).crash("boom");
			await supervisor.settled(alpha);

			await supervisor.activate(alpha);

			expect(backlog.launches).toHaveLength(2);
		});
	});

	describe("when the port is taken", () => {
		test("retries on a fresh port", async () => {
			backlog.occupyNext(1);
			backlog.answersAnywhere();
			const supervisor = supervisorWith();

			await supervisor.activate(alpha);
			await supervisor.settled(alpha);

			expect(supervisor.statusOf(alpha).status).toEqual("ready");
		});

		test("gives up after a bounded number of attempts", async () => {
			backlog.occupyNext(MAX_PORT_ATTEMPTS);
			const supervisor = supervisorWith();

			await supervisor.activate(alpha);
			await supervisor.settled(alpha);

			expect(supervisor.statusOf(alpha).status).toEqual("failed");
		});
	});

	describe("when a child is respawned", () => {
		test("asks for the port it had", async () => {
			const supervisor = supervisorWith();
			await supervisor.activate(alpha);
			const first = backlog.childFor(alpha.path).spec.port;
			backlog.childFor(alpha.path).crash("bye");
			await supervisor.settled(alpha);

			await supervisor.activate(alpha);

			expect(backlog.childFor(alpha.path).spec.port).toEqual(first);
		});

		test("gives that port up once the child collides", async () => {
			const supervisor = supervisorWith();
			await supervisor.activate(alpha);
			backlog.childFor(alpha.path).crash("bye");
			await supervisor.settled(alpha);
			backlog.occupy(backlog.childFor(alpha.path).spec.port);
			backlog.answersAnywhere();

			await supervisor.activate(alpha);
			await supervisor.settled(alpha);

			expect(supervisor.statusOf(alpha).status).toEqual("ready");
		});
	});

	describe("when no port can be had", () => {
		test("reports the failure", async () => {
			backlog.refusePorts("the state directory is not writable");
			const supervisor = supervisorWith();

			await supervisor.activate(alpha);

			expect(supervisor.statusOf(alpha)).toMatchObject({ status: "failed" });
		});

		test("spawns a replacement when the project is activated again", async () => {
			backlog.refusePorts("the state directory is not writable");
			const supervisor = supervisorWith();
			await supervisor.activate(alpha);

			backlog.grantPorts();
			const activation = await activateReady(supervisor, alpha);

			expect(activation.status).toEqual("ready");
		});

		test("reports the failure when the retry port is refused too", async () => {
			backlog.occupy(40_001);
			const supervisor = supervisorWith();

			await supervisor.activate(alpha);
			backlog.refusePorts("the state directory is not writable");
			await supervisor.settled(alpha);

			expect(supervisor.statusOf(alpha)).toMatchObject({ status: "failed" });
		});
	});

	describe("when the child never answers", () => {
		test("fails once the readiness timeout passes", async () => {
			const supervisor = supervisorWith({ readyTimeoutMs: 50 });

			await supervisor.activate(alpha);
			clock += 51;
			await supervisor.settled(alpha);

			expect(supervisor.statusOf(alpha)).toMatchObject({ status: "failed" });
		});
	});

	describe("idle shutdown", () => {
		test("stops a child left untouched past the idle timeout", async () => {
			const supervisor = supervisorWith({ idleTimeoutMs: 1000 });
			await activateReady(supervisor, alpha);
			await activateReady(supervisor, beta);

			clock += 1001;
			supervisor.stopIdle();

			expect(backlog.childFor(alpha.path).killed).toBe(true);
		});

		test("forgets the swept project's status", async () => {
			const supervisor = supervisorWith({ idleTimeoutMs: 1000 });
			await activateReady(supervisor, alpha);
			await activateReady(supervisor, beta);

			clock += 1001;
			supervisor.stopIdle();

			expect(supervisor.statusOf(alpha).status).toEqual("idle");
		});

		test("spares the project the shell reports on screen", async () => {
			const supervisor = supervisorWith({ idleTimeoutMs: 1000 });
			await activateReady(supervisor, alpha);
			await activateReady(supervisor, beta);

			clock += 1001;
			supervisor.touch(beta);
			supervisor.stopIdle();

			expect(backlog.childFor(beta.path).killed).toBe(false);
		});

		test("sweeps the last-activated project once nothing reports it", async () => {
			const supervisor = supervisorWith({ idleTimeoutMs: 1000 });
			await activateReady(supervisor, alpha);

			clock += 1001;
			supervisor.stopIdle();

			expect(backlog.childFor(alpha.path).killed).toBe(true);
		});

		test("ignores a touch for a project with no child", () => {
			const supervisor = supervisorWith();

			supervisor.touch(alpha);

			expect(supervisor.statusOf(alpha).status).toEqual("idle");
		});

		test("keeps every child when the timeout is disabled", async () => {
			const supervisor = supervisorWith({ idleTimeoutMs: 0 });
			await activateReady(supervisor, alpha);
			await activateReady(supervisor, beta);

			clock += 10 * 60_000;
			supervisor.stopIdle();

			expect(backlog.live).toHaveLength(2);
		});
	});

	describe("shutdown", () => {
		test("kills every child", async () => {
			const supervisor = supervisorWith();
			await activateReady(supervisor, alpha);
			await activateReady(supervisor, beta);

			await supervisor.shutdown();

			expect(backlog.live).toEqual([]);
		});

		test("leaves nothing behind when called twice", async () => {
			const supervisor = supervisorWith();
			await activateReady(supervisor, alpha);

			await supervisor.shutdown();
			await supervisor.shutdown();

			expect(backlog.live).toEqual([]);
		});

		test("kills every child when forced", async () => {
			const supervisor = supervisorWith();
			await activateReady(supervisor, alpha);
			await activateReady(supervisor, beta);

			supervisor.terminate();

			expect(backlog.live).toEqual([]);
		});

		test("refuses to spawn after being forced", async () => {
			const supervisor = supervisorWith();
			supervisor.terminate();

			await supervisor.activate(alpha);

			expect(backlog.launches).toEqual([]);
		});

		test("refuses to spawn after shutdown", async () => {
			const supervisor = supervisorWith();
			await supervisor.shutdown();

			await supervisor.activate(alpha);

			expect(backlog.launches).toEqual([]);
		});

		test("launches nothing when shutdown lands during port allocation", async () => {
			let grant!: (port: number) => void;
			const supervisor = supervisorWith({
				portFor: () =>
					new Promise((resolve) => {
						grant = resolve;
					}),
			});

			const activating = supervisor.activate(alpha);
			await supervisor.shutdown();
			grant(40_123);
			await activating;

			expect(backlog.launches).toEqual([]);
		});

		test("force-kills a child that survives shutdown", async () => {
			const supervisor = supervisorWith();
			await activateReady(supervisor, alpha);
			backlog.childFor(alpha.path).ignoresTermination();

			const stopping = supervisor.shutdown();
			supervisor.terminate();
			await stopping;

			expect(backlog.live).toEqual([]);
		});
	});
});
