# backlog-hub

One local URL for every [Backlog.md](https://backlog.md) project under a folder, with a skinny
toolbar to switch between them. Everything below the toolbar is the stock Backlog.md board.

```bash
cd ~/code && backlog-hub
```

With no argument the current directory is the root, so open a shell wherever your projects live
and run it.

## Install

`src/cli.ts` carries a `#!/usr/bin/env bun` shebang, so link it onto your `PATH` and it tracks the
source with no rebuild:

```bash
ln -sf "$PWD/src/cli.ts" ~/.local/bin/backlog-hub
```

For a standalone binary with no Bun on `PATH`, `bun run build` writes `dist/backlog-hub`; link
that instead and rebuild after each change.

## How it works

The hub is a supervisor plus a frame shell. It binds one fixed port and serves a shell page: a
toolbar and a full-height `<iframe>`. For the selected project it spawns
`backlog browser --port <free> --no-open --non-interactive` with the project directory as the
child's cwd, and points the iframe at the child's own origin. The child serves its own assets,
its `/api/*` calls and its WebSocket untouched, so upstream Backlog.md changes land for free.

The flip side: because each board renders in its own iframe origin, the hub cannot style or
script it.

A path-prefix reverse proxy (`/p/<slug>/`) was rejected and should stay rejected. Verified
against backlog.md 1.50.1: the served HTML sets `<base href="/">`, the client bundle requests
absolute `/api/...` paths, and it opens ``new WebSocket(`${proto}//${window.location.host}`)``.
Proxying under a prefix breaks all three unless the hub rewrites HTML and JS on the way through,
and the only thing that buys is a prettier URL. The child pages carry no `X-Frame-Options` and no
CSP `frame-ancestors`, which is what makes the iframe work.

## Usage

```
backlog-hub [root]
  --port <n>           hub port (default 6789)
  --depth <n>          discovery depth (default 5)
  --max-children <n>   warm child servers (default 4)
  --idle-timeout <m>   minutes before a child is stopped (default 30, 0 = never)
  --rescan             walk the tree at startup instead of using the cache
  --no-open            do not open the browser
```

A directory is a project when it holds `backlog/config.yml`. Discovery walks `root` to `--depth`
levels, skipping `node_modules`, `.git`, `target`, `dist`, `build`, `vendor`, `.venv` and any
dotted directory, and does not descend into a project once found. There is no filesystem watching.

## The discovery cache

The walk runs once and its result is cached, so startup does not pay for it again:

```
~/.local/state/backlog-hub/discovery.json   ($XDG_STATE_HOME when set)
```

The cache holds the project paths per root, keyed by the depth they were found at, so changing
`--depth` forces a fresh walk rather than serving a shallower answer. Project names are re-read
from each `backlog/config.yml` on every start, so a rename shows up without a rescan, and a path
whose project is gone is dropped from the cache silently.

Two ways to walk again: press **Refresh** in the toolbar, or start with `--rescan`. Both rewrite
the cache. Deleting the file works too.

Measured on this machine, `~` at depth 5: a cold walk takes 265 ms, a cached load takes under a
millisecond, and a forced `Refresh` takes 199 ms.

`fd` was benchmarked as an alternative walker and rejected: at depth 5 and 6 it ties the built-in
walk, it only pulls ahead past depth 8, and it needs `--no-ignore` to work at all when
`backlog/` appears in a `.gitignore`. The cache removes the repeat cost that the swap was meant
to buy.

## Keyboard

| Keys | Action |
| --- | --- |
| `Ctrl/Cmd+K` | filterable project picker, matching on name and path |
| `Ctrl/Cmd+[` | previous project |
| `Ctrl/Cmd+]` | next project |

**These only fire while focus is in the hub's own chrome.** Once you click into the board, focus
lives inside the iframe, and the child page does not forward key events to the parent, so the
shortcut goes to the board instead. Click the toolbar (or press `Escape` out of the board's own
inputs) first. Injecting a listener into the child is deliberately out of scope.

## Children

A child starts on the first switch to its project and stays warm afterwards, so switching back is
instant. A project is ready once its `/api/config` answers 200 within 15 s; until then the toolbar
shows "starting". Beyond `--max-children` the least recently used child is stopped, and any child
left untouched for `--idle-timeout` minutes is stopped too. If a child dies, the frame shows its
last stderr lines and a Retry button; the hub never restarts it on its own.

`backlog` on `PATH` may be a wrapper that runs the real server as a grandchild, so each child gets
its own process group and the hub signals the whole group. `Ctrl+C` leaves no `backlog browser`
behind, and a second `Ctrl+C` force-kills rather than exiting early.

The hub does not adopt a server left over from a previous run; it starts its own.

## Development

```bash
bun install
bun test
bun run check     # biome, both tsconfigs, tests
bun run build     # single binary into dist/
```

The shell is one HTML file, one CSS file and one JS file under `src/shell/`, served by the hub's
own handler with no build step. `src/shell/tsconfig.json` type-checks the browser script against
the DOM lib; the root `tsconfig.json` covers the server and excludes it.
