import { beforeEach, describe, expect, test } from "bun:test";

import { Project } from "../discovery/project.ts";
import { FakeBacklog } from "./fake-backlog.ts";
import { Supervisor } from "./supervisor.ts";

const alpha = new Project({ path: "/code/alpha", name: "Alpha" });
const beta = new Project({ path: "/code/beta", name: "Beta" });
const gamma = new Project({ path: "/code/gamma", name: "Gamma" });

let backlog: FakeBacklog;
let clock: number;

function supervisorWith(overrides: Partial<ConstructorParameters<typeof Supervisor>[0]> = {}) {
  return new Supervisor({
    launch: backlog.launch,
    probe: backlog.probe,
    portFor: backlog.portFor,
    maxChildren: 4,
    idleTimeoutMs: 30 * 60_000,
    readyTimeoutMs: 1_000,
    pollIntervalMs: 0,
    now: () => clock,
    ...overrides,
  });
}

async function activateReady(supervisor: Supervisor, project: Project) {
  await supervisor.activate(project);
  backlog.answerOn(backlog.childFor(project.path).spec.port);
  await supervisor.settled(project);

  return supervisor.statusOf(project);
}

beforeEach(() => {
  backlog = new FakeBacklog();
  clock = 0;
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
    expect(activation).toEqual({ status: "ready", port, url: `http://127.0.0.1:${port}/` });
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

  describe("the child cap", () => {
    test("stops the least recently used child beyond the cap", async () => {
      const supervisor = supervisorWith({ maxChildren: 2 });
      await activateReady(supervisor, alpha);
      clock += 1;
      await activateReady(supervisor, beta);

      clock += 1;
      await supervisor.activate(gamma);

      expect(backlog.childFor(alpha.path).killed).toBe(true);
      expect(backlog.childFor(beta.path).killed).toBe(false);
    });

    test("forgets the evicted project's status", async () => {
      const supervisor = supervisorWith({ maxChildren: 1 });
      await activateReady(supervisor, alpha);

      clock += 1;
      await supervisor.activate(beta);

      expect(supervisor.statusOf(alpha).status).toEqual("idle");
    });
  });

  describe("when the child exits before it is ready", () => {
    test("reports the failure", async () => {
      const supervisor = supervisorWith();
      await supervisor.activate(alpha);

      backlog.childFor(alpha.path).crash("Error: cannot read backlog/config.yml\n");
      await supervisor.settled(alpha);

      expect(supervisor.statusOf(alpha).status).toEqual("failed");
    });

    test("carries the child's last stderr lines", async () => {
      const supervisor = supervisorWith();
      await supervisor.activate(alpha);

      backlog.childFor(alpha.path).crash("Error: cannot read backlog/config.yml\n");
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
      backlog.occupy(40_001);
      const supervisor = supervisorWith();

      await supervisor.activate(alpha);
      backlog.answerOn(40_002);
      await supervisor.settled(alpha);

      expect(supervisor.statusOf(alpha).status).toEqual("ready");
    });

    test("gives up after a bounded number of attempts", async () => {
      backlog.occupy(40_001, 40_002, 40_003, 40_004, 40_005);
      const supervisor = supervisorWith();

      await supervisor.activate(alpha);
      await supervisor.settled(alpha);

      expect(supervisor.statusOf(alpha).status).toEqual("failed");
    });
  });

  describe("when a project has a remembered port", () => {
    test("binds the same port again", async () => {
      const supervisor = supervisorWith();
      await supervisor.activate(alpha);
      backlog.childFor(alpha.path).crash("bye");
      await supervisor.settled(alpha);

      await supervisor.activate(alpha);

      expect(backlog.childFor(alpha.path).spec.port).toEqual(40_001);
    });

    test("gives up on it once the child collides", async () => {
      const supervisor = supervisorWith();
      await supervisor.activate(alpha);
      backlog.childFor(alpha.path).crash("bye");
      await supervisor.settled(alpha);
      backlog.occupy(40_001);

      await supervisor.activate(alpha);
      backlog.answerOn(40_002);
      await supervisor.settled(alpha);

      expect(supervisor.statusOf(alpha).status).toEqual("ready");
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
      const supervisor = supervisorWith({ idleTimeoutMs: 1_000 });
      await activateReady(supervisor, alpha);
      await activateReady(supervisor, beta);

      clock += 1_001;
      supervisor.stopIdle();

      expect(backlog.childFor(alpha.path).killed).toBe(true);
    });

    test("forgets the swept project's status", async () => {
      const supervisor = supervisorWith({ idleTimeoutMs: 1_000 });
      await activateReady(supervisor, alpha);
      await activateReady(supervisor, beta);

      clock += 1_001;
      supervisor.stopIdle();

      expect(supervisor.statusOf(alpha).status).toEqual("idle");
    });

    test("spares the project being viewed", async () => {
      const supervisor = supervisorWith({ idleTimeoutMs: 1_000 });
      await activateReady(supervisor, alpha);
      await activateReady(supervisor, beta);

      clock += 1_001;
      supervisor.stopIdle();

      expect(backlog.childFor(beta.path).killed).toBe(false);
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
  });
});
