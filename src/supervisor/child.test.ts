import { afterEach, describe, expect, test } from "bun:test";

import { allocatePort, LOOPBACK } from "./child.ts";

let squatter: Bun.Server<undefined> | null = null;

async function occupy(port: number): Promise<void> {
  squatter = Bun.serve({
    hostname: LOOPBACK,
    port,
    fetch: () => new Response(null, { status: 404 }),
  });
}

afterEach(async () => {
  await squatter?.stop(true);
  squatter = null;
});

describe("allocatePort", () => {
  test("hands out a port the kernel chose", async () => {
    const port = await allocatePort();

    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65_535);
  });

  test("hands out the preferred port when it is free", async () => {
    const preferred = await allocatePort();

    expect(await allocatePort(preferred)).toEqual(preferred);
  });

  test("falls back to a fresh port when the preferred one is taken", async () => {
    const preferred = await allocatePort();
    await occupy(preferred);

    expect(await allocatePort(preferred)).not.toEqual(preferred);
  });
});
