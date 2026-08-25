import type { Project } from "../discovery/project.ts";
import type { ProjectRegistry } from "../discovery/registry.ts";
import shellHtml from "../shell/index.html" with { type: "text" };
import shellCss from "../shell/shell.css" with { type: "text" };
import shellJs from "../shell/shell.js" with { type: "text" };
import type { StateStore } from "../state/store.ts";
import type { Supervisor } from "../supervisor/supervisor.ts";

export const LOOPBACK = "127.0.0.1";

export function startHub(options: {
  registry: ProjectRegistry;
  store: StateStore;
  supervisor: Supervisor;
  port: number;
}): Bun.Server<undefined> {
  const { registry, store, supervisor } = options;

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
      "/api/refresh": {
        POST: async () => {
          await registry.refresh();

          return json(await inventoryOf(registry, store, supervisor));
        },
      },
    },
    fetch: () => json({ error: "not found" }, 404),
  });
}

async function inventoryOf(registry: ProjectRegistry, store: StateStore, supervisor: Supervisor) {
  return {
    root: registry.root,
    depth: registry.depth,
    active: await store.lastActive(registry.root),
    projects: registry.all().map((project) => describe(project, supervisor)),
  };
}

function describe(project: Project, supervisor: Supervisor) {
  return {
    slug: project.slug,
    name: project.name,
    path: project.path,
    status: supervisor.statusOf(project).status,
  };
}

function asset(body: string, contentType: string): Response {
  return new Response(body, {
    headers: { "content-type": contentType, "cache-control": "no-store" },
  });
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}
