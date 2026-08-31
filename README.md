# backlog-browser

One local URL for every [Backlog.md](https://backlog.md) project under a folder, with a skinny
toolbar to switch between them. Everything below the toolbar is the stock Backlog.md board.

```bash
cd ~/code && backlog-browser
```

With no argument the current directory is the root, so open a shell wherever your projects live
and run it.

## Install

You need [Bun](https://bun.sh) to run it, and [Backlog.md](https://backlog.md) on your `PATH` to
have anything to serve: the hub spawns `backlog browser` per project and refuses to start without
it. `mise install` in a clone gets you both, at the versions `mise.toml` pins.

`src/cli.ts` carries a `#!/usr/bin/env bun` shebang, so link it onto your `PATH` and it tracks the
source with no rebuild:

```bash
ln -sf "$PWD/src/cli.ts" ~/.local/bin/backlog-browser
```

Installed as a package instead, the command is a small Node script that hands over to Bun, because
npm cannot run the TypeScript entry point itself. Bun still has to be there; without it the command
says so rather than failing as `env: bun: No such file or directory`.

For a standalone binary with no Bun on `PATH`, `bun run build` writes `dist/backlog-browser`; link
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
backlog-browser [root]
  --port <n>           hub port (default 6789)
  --depth <n>          discovery depth (default 5, remembered per root)
  --idle-timeout <m>   minutes before a child is stopped (default 5, 0 = never)
  --rescan             walk the tree at startup instead of using the cache
  --no-open            do not open the browser
```

A directory is a project when it holds `backlog/config.yml`. Discovery walks `root` to `--depth`
levels, skipping `node_modules`, `.git`, `target`, `dist`, `build`, `vendor`, `.venv` and any
dotted directory, and does not descend into a project once found. There is no filesystem watching.

`--depth` is a startup seed, not a fixed setting. It is editable from the toolbar and remembered per
root in `state.json`. Passing the flag replaces the remembered value for that root and for every run
after it; with no flag the remembered value wins, and with neither, the built-in default.

## The discovery cache

The walk runs once and its result is cached, so startup does not pay for it again:

```
~/.local/state/backlog-browser/discovery.json   ($XDG_STATE_HOME when set)
```

The cache holds the project paths per root, keyed by the depth they were found at, so changing
`--depth` forces a fresh walk rather than serving a shallower answer. Project names are re-read
from each `backlog/config.yml` on every start, so a rename shows up without a rescan, and a path
whose project is gone is dropped from the cache silently.

Two ways to walk again: press **Refresh** in the toolbar, or start with `--rescan`. Both rewrite
the cache. Deleting the file works too.

**Refresh** asks for the depth before it walks, preset to the depth in force. Confirming with a
different number walks at that depth and remembers it for later runs, which matters because the
cache is keyed by depth: a walk depth that is not remembered would miss the cache on every start
and pay for a cold walk each time.

## Adding a project by hand

A project nested below the discovery depth is unreachable no matter how often you Refresh, and
raising `--depth` to reach it slows every walk under that root. **Add** in the toolbar opens the
macOS folder chooser instead, starting at the root, and adds whatever you pick.

The dialog belongs to the hub, not the page: a browser hands a page no absolute filesystem path
from either `webkitdirectory` or `showDirectoryPicker`, so the hub shells out to
`osascript -e 'POSIX path of (choose folder ...)'` and the page receives the path it returns.
That also means the chooser only exists where the hub runs; on anything but macOS, Add reports that
the platform has no chooser.

Added projects live in `state.json` rather than the discovery cache, because a walk rewrites that
cache and nothing in a walk would put them back. They survive Refresh and restarts, they sit in
the list next to discovered projects, and a right-click on the pill offers to remove one again. A
folder with no `backlog/config.yml` is refused.

Adding a project a walk would have found anyway is harmless: it is listed once, and once a walk
reaches it the hub stops marking it added, so the remove option disappears rather than offering to
drop a project it cannot drop.

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
shows "starting". Nothing caps how many run at once: a child is stopped once it has gone
`--idle-timeout` minutes untouched. The shell's 2 s status poll names the project on screen, and
that report is what counts as touched, so a visible board is never swept, from any number of tabs.
A hidden tab stops polling, so its board can idle out like any other; switching back shows the
stopped screen with a Retry button. The sweep ticks once a minute, so a child outlives its timeout
by up to a minute.

Time is the only bound, so the memory in play is whatever you opened in the last few minutes.
Measured on this machine against backlog.md 1.50.1, one child is a `node` wrapper plus the real
server, about 140 MB together, so five warm boards cost roughly 700 MB. `--idle-timeout 0` still
means never, and nothing else holds the count down.

The shell keeps one iframe per warm child and drops it as soon as the 2s status poll sees that child
stop. The hub hands a restarted child the port it had, so a frame left behind would match on `src`
and be re-revealed showing the document the dead child served. If a child dies, the frame shows its
last stderr lines and a Retry button; the hub never restarts it on its own.

`backlog` on `PATH` may be a wrapper that runs the real server as a grandchild, so each child gets
its own process group and the hub signals the whole group. `Ctrl+C` leaves no `backlog browser`
behind, and a second `Ctrl+C` force-kills rather than exiting early.

The hub does not adopt a server left over from a previous run; it starts its own.

## Development

```bash
mise install      # bun, backlog.md and gitleaks, pinned in mise.toml
bun install
bun test
bun run check     # oxfmt, oxlint, all three tsconfigs, tests
bun run scan      # gitleaks over the working tree and every commit
bun run build     # single binary into dist/
```

Formatting is [oxfmt](https://oxc.rs) and linting is [oxlint](https://oxc.rs), with every rule
category an error and a set of vendored rules under `tools/oxlint/` on top. `check` runs the
type-aware pass, which is the whole of it.

No file, line or block is exempted, and no source file carries a disable comment. Four rules are
scoped to one file each in `.oxlintrc.json`, each where a rule and the code disagree for a reason
worth recording:

- `no-process-env`, for the one module whose job is reading the environment.
- `import/unambiguous`, for the declaration file that types Bun's text imports. Making it a module
  is what the rule asks for, and that stops its wildcard declarations applying at all.
- `import/default`, for the file that uses those imports. They are what embeds the shell into the
  compiled binary; reading the files at request time instead leaves the binary serving nothing.
- `no-known-value-widening`, for the route table. Another rule requires the return type it objects
  to, and the type it objects to is what keeps a path's `:slug` typed in the handler serving it.

The hub answers only requests carrying its own `Origin` and `Host`. It is a long-lived server on a
known loopback port, so without those checks any page the user visited could drive it: change the
stored list, spawn a child, or open the host's folder chooser. A rebound DNS name is same-origin to
a browser, which is why loopback binding alone does not cover it.

The shell is one HTML file, one CSS file and one JS file under `src/shell/`, served by the hub's
own handler with no build step. `src/shell/tsconfig.json` type-checks the browser script against
the DOM lib; the root `tsconfig.json` covers the server and excludes it, and `bin/tsconfig.json`
covers the npm launcher. `src/shell/shell.js` is left out of the formatter, which splits its JSDoc
type casts away from the expressions they annotate and silently drops the annotation.
