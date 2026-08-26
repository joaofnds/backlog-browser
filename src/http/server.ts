import type { FolderChooser } from "../discovery/choose-folder.ts";
import { readProject } from "../discovery/discovery.ts";
import type { ProjectRegistry } from "../discovery/registry.ts";
import type { ListedProject } from "../list/list.ts";
import shellHtml from "../shell/index.html" with { type: "text" };
import shellCss from "../shell/shell.css" with { type: "text" };
import shellJs from "../shell/shell.js" with { type: "text" };
import { SETTING_BOUNDS, type SettingBounds, within } from "../state/settings.ts";
import type { StateStore } from "../state/store.ts";
import type { Supervisor } from "../supervisor/supervisor.ts";

export const LOOPBACK = "127.0.0.1";

export function startHub(options: {
  registry: ProjectRegistry;
  store: StateStore;
  supervisor: Supervisor;
  chooseFolder: FolderChooser;
  port: number;
}): Bun.Server<undefined> {
  const { registry, store, supervisor, chooseFolder } = options;

  return Bun.serve({
    hostname: LOOPBACK,
    port: options.port,
    routes: {
      "/": asset(shellHtml, "text/html; charset=utf-8"),
      "/shell.css": asset(shellCss, "text/css; charset=utf-8"),
      "/shell.js": asset(shellJs, "text/javascript; charset=utf-8"),
      "/api/projects": async () => json(await inventoryOf(registry, store, supervisor)),
      "/api/projects/:slug": (request) => {
        const project = registry.find(request.params.slug);
        if (!project) return json({ error: "unknown project" }, 404);

        return json(supervisor.statusOf(project));
      },
      "/api/projects/:slug/activate": {
        POST: async (request) => {
          const project = registry.find(request.params.slug);
          if (!project) return json({ error: "unknown project" }, 404);

          const activation = await supervisor.activate(project);
          await store.remember(registry.root, project.slug);

          return json(activation);
        },
      },
      "/api/status": () => noStore(json(statusesOf(registry, supervisor))),
      "/api/refresh": {
        POST: async (request) => {
          const body = await bodyOf(request);
          const depth = within(body.depth, SETTING_BOUNDS.depth);
          if (body.depth !== undefined && depth === null) {
            return json({ error: outOfRange("depth", SETTING_BOUNDS.depth) }, 400);
          }

          if (depth !== null) {
            await store.updateSettings(registry.root, (settings) => settings.withDepth(depth));
          }
          await registry.refresh(depth ?? undefined);

          return json(await inventoryOf(registry, store, supervisor));
        },
      },
      "/api/settings": {
        POST: async (request) => {
          const body = await bodyOf(request);
          const maxChildren = within(body.maxChildren, SETTING_BOUNDS.maxChildren);
          if (maxChildren === null) {
            return json({ error: outOfRange("maxChildren", SETTING_BOUNDS.maxChildren) }, 400);
          }

          supervisor.resize(maxChildren);
          await store.updateSettings(registry.root, (settings) =>
            settings.withMaxChildren(maxChildren),
          );

          return json(await inventoryOf(registry, store, supervisor));
        },
      },
      "/api/choose-folder": {
        POST: async () => {
          const chosen = await chooseFolder({ startAt: registry.root });
          if (chosen.kind === "unavailable") return json({ error: chosen.reason }, 501);
          if (chosen.kind === "failed") return json({ error: chosen.reason }, 500);

          return noStore(json(chosen));
        },
      },
      "/api/list/added": {
        POST: async (request) => {
          const body = await bodyOf(request);
          const path = stringAt(body, "path");
          const added = booleanAt(body, "added");
          if (path === null || added === null) return json({ error: "path and added" }, 400);

          if (added && (await readProject(path)) === null) {
            return json({ error: "no backlog/config.yml in that folder" }, 400);
          }

          const list = await store.updateList(registry.root, (current) =>
            added ? current.add(path) : current.drop(path),
          );
          await registry.adopt(list.added);

          return json(await inventoryOf(registry, store, supervisor));
        },
      },
      "/api/list/hidden": {
        POST: async (request) => {
          const body = await bodyOf(request);
          const path = stringAt(body, "path");
          const hidden = booleanAt(body, "hidden");
          if (path === null || hidden === null) return json({ error: "path and hidden" }, 400);

          await store.updateList(registry.root, (list) =>
            hidden ? list.hide(path) : list.show(path),
          );

          return json(await inventoryOf(registry, store, supervisor));
        },
      },
      "/api/list/order": {
        POST: async (request) => {
          const body = await bodyOf(request);
          const path = stringAt(body, "path");
          const before = anchorAt(body, "before");
          if (path === null || before === undefined) return json({ error: "path and before" }, 400);

          await store.updateList(registry.root, (list) =>
            list.move({ path, before, discovered: registry.all() }),
          );

          return json(await inventoryOf(registry, store, supervisor));
        },
      },
      "/api/list/reset": {
        POST: async () => {
          await store.updateList(registry.root, (list) => list.reset());

          return json(await inventoryOf(registry, store, supervisor));
        },
      },
    },
    fetch: () => json({ error: "not found" }, 404),
  });
}

async function inventoryOf(registry: ProjectRegistry, store: StateStore, supervisor: Supervisor) {
  const list = await store.list(registry.root);
  const kept = keptByHand(list.added, registry.walked());

  return {
    root: registry.root,
    depth: registry.depth,
    maxChildren: supervisor.capacity,
    active: await store.lastActive(registry.root),
    mode: list.mode,
    projects: list.arrange(registry.all()).map((listed) => describe(listed, kept)),
  };
}

/**
 * A path the user added and a later walk then reached is an ordinary discovered project: dropping
 * it from the added set would not remove it, so the shell must not offer to.
 */
function keptByHand(added: readonly string[], walked: ReadonlySet<string>): ReadonlySet<string> {
  return new Set(added.filter((path) => !walked.has(path)));
}

function outOfRange(field: string, bounds: SettingBounds): string {
  return `${field} must be a whole number between ${bounds.minimum} and ${bounds.maximum}`;
}

function statusesOf(registry: ProjectRegistry, supervisor: Supervisor) {
  return Object.fromEntries(
    registry.all().map((project) => [project.slug, supervisor.statusOf(project).status]),
  );
}

function describe(listed: ListedProject, kept: ReadonlySet<string>) {
  return {
    slug: listed.project.slug,
    name: listed.project.name,
    path: listed.project.path,
    hidden: listed.hidden,
    added: kept.has(listed.project.path),
  };
}

async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null);

  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function stringAt(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];

  return typeof value === "string" && value !== "" ? value : null;
}

function booleanAt(body: Record<string, unknown>, key: string): boolean | null {
  const value = body[key];

  return typeof value === "boolean" ? value : null;
}

/** `undefined` is the parse failure here, because `null` is the anchor meaning "the end". */
function anchorAt(body: Record<string, unknown>, key: string): string | null | undefined {
  const value = body[key];
  if (value === null) return null;

  return typeof value === "string" && value !== "" ? value : undefined;
}

function asset(body: string, contentType: string): Response {
  return new Response(body, {
    headers: { "content-type": contentType, "cache-control": "no-store" },
  });
}

function noStore(response: Response): Response {
  response.headers.set("cache-control", "no-store");

  return response;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}
