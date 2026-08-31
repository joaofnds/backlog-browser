/**
 * @typedef {Readonly<{ slug: string, name: string, path: string, hidden: boolean, added: boolean }>} ProjectSummary
 * @typedef {"default" | "manual"} OrderMode
 * @typedef {Readonly<{ root: string, depth: number, active: string | null, mode: OrderMode, projects: readonly ProjectSummary[] }>} Inventory
 * @typedef {Readonly<{ status: string, url: string | null, error: string | null, stderr: string | null }>} Activation
 * @typedef {Readonly<{ kind: "chosen", path: string } | { kind: "cancelled" }>} ChosenFolder
 * @typedef {Readonly<{ method: "POST", headers?: Readonly<Record<string, string>>, body?: string }>} JsonPost
 */

/**
 * The brand `Object.prototype.toString` gives a value, which is the one classification the shell
 * can make without a `typeof` on an unparsed reply. It is also stricter than `typeof` where it
 * matters: an array and a `Date` are both `"object"` to `typeof`, and neither is a hub reply.
 *
 * @param {unknown} value
 * @returns {string}
 */
function brandOf(value) {
  return Object.prototype.toString.call(value);
}

/**
 * The hub's replies, checked before they are believed. The shell has no build step and so no
 * schema library, but an answer that is not the shape this file expects is a bug worth failing on
 * here, where it can be named, rather than three renders later.
 *
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function fields(value) {
  const held = fieldsOrNull(value);
  if (held === null) {
    throw new TypeError("the hub answered with something that is not an object");
  }

  return held;
}

/**
 * The same parse where absence is an answer rather than a fault: `history.state` is whatever some
 * earlier page put there, and a foreign shape is a miss, not a bug to fail on.
 *
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function fieldsOrNull(value) {
  if (value === null || brandOf(value) !== "[object Object]") {
    return null;
  }

  return { ...value };
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function stringOrNull(value) {
  return brandOf(value) === "[object String]" ? String(value) : null;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string}
 */
function text(value, name) {
  const parsed = stringOrNull(value);
  if (parsed === null) {
    throw new TypeError(`the hub's ${name} is not a string`);
  }

  return parsed;
}

/**
 * @param {Response} response
 * @returns {Promise<Inventory>}
 */
async function inventoryFrom(response) {
  const body = fields(await response.json());
  const { root, depth, active, mode, projects } = body;

  return {
    root: text(root, "root"),
    depth: Number(depth),
    active: active === null ? null : text(active, "active"),
    mode: mode === "manual" ? "manual" : "default",
    projects: Array.isArray(projects) ? projects.map((entry) => projectFrom(entry)) : [],
  };
}

/**
 * @param {unknown} value
 * @returns {ProjectSummary}
 */
function projectFrom(value) {
  const { slug, name, path, hidden, added } = fields(value);

  return {
    slug: text(slug, "slug"),
    name: text(name, "name"),
    path: text(path, "path"),
    hidden: hidden === true,
    added: added === true,
  };
}

/**
 * @param {Response} response
 * @returns {Promise<Activation>}
 */
async function activationFrom(response) {
  const body = fields(await response.json());
  const { url, error, stderr } = body;

  return {
    status: text(body.status, "status"),
    url: stringOrNull(url),
    error: stringOrNull(error),
    stderr: stringOrNull(stderr),
  };
}

/**
 * The element the shell document promises under this id, as the kind the caller needs. It is a
 * programming error for one to be missing or to be the wrong element, so this throws rather than
 * returning null and leaving every caller to check. The `instanceof` is what earns the return
 * type: no caller has to be trusted about what the document holds.
 *
 * @template {HTMLElement} T
 * @param {string} id
 * @param {new () => T} type the element the caller expects
 * @returns {T}
 */
function mustBe(id, type) {
  const node = document.querySelector(`#${CSS.escape(id)}`);
  if (node === null) {
    throw new Error(`the shell document is missing #${id}`);
  }
  if (!(node instanceof type)) {
    throw new Error(`#${id} is not a ${type.name}`);
  }

  return node;
}

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
function must(id) {
  return mustBe(id, HTMLElement);
}

/**
 * The element a required one sits inside. The lookup stays here rather than taking the child as
 * an argument so the enclosing element is found and checked in one place, the same way `mustBe`
 * finds and checks the child.
 *
 * @param {string} id
 * @returns {HTMLElement}
 */
function mustContain(id) {
  const parent = document.querySelector(`#${CSS.escape(id)}`)?.parentElement ?? null;
  if (!(parent instanceof HTMLElement)) {
    throw new Error(`the shell document has no element around #${id}`);
  }

  return parent;
}

const browseButton = mustBe("browse-button", HTMLButtonElement);
const contextMenu = must("context-menu");
const notice = mustBe("notice", HTMLDialogElement);
const noticeDetail = must("notice-detail");
const noticeHeading = must("notice-heading");
const orderMode = must("order-mode");
const overflow = must("overflow");
const overflowList = must("overflow-list");
const overflowSummary = must("overflow-summary");
const picker = mustBe("picker", HTMLDialogElement);
const refreshDepth = mustBe("refresh-depth", HTMLInputElement);
const refreshDialog = mustBe("refresh-dialog", HTMLDialogElement);
const refreshNote = must("refresh-note");
const pickerInput = mustBe("picker-input", HTMLInputElement);
const pickerList = must("picker-list");
const placeholder = must("placeholder");
const projectList = must("project-list");
const showHidden = mustBe("show-hidden", HTMLInputElement);
const stage = mustContain("placeholder");
const switcher = mustContain("project-list");

const POLL_INTERVAL_MS = 400;
const STATUS_POLL_MS = 2000;
/** Browsers throttle a hidden tab's timers to about a minute, so ask for well under the sweep. */
const KEEP_WARM_MS = 30_000;

/** @type {Inventory} */
let inventory = { root: "", depth: 0, active: null, mode: "default", projects: [] };
/** @type {string | null} */
let activeSlug = null;
/** @type {Activation | null} */
let activation = null;
/** @type {Map<string, string>} */
let statuses = new Map();
/** @type {ReturnType<typeof setTimeout> | undefined} */
let pollTimer;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let statusTimer;
let highlighted = 0;
/** @type {string | null} */
let dragging = null;
let activationEpoch = 0;

/** @type {Map<string, HTMLIFrameElement>} */
const frames = new Map();

/* The list ----------------------------------------------------------------- */

function visible() {
  return inventory.projects.filter((project) => !project.hidden);
}

/** @param {string} slug */
function projectRoute(slug) {
  return `/api/projects/${encodeURIComponent(slug)}`;
}

/**
 * @param {unknown} body
 * @returns {JsonPost}
 */
function postJson(body) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

/**
 * The caller must stop on `false`: a failed write already showed the notice, and acting as if
 * it landed (dropping a frame, switching away) leaves the shell lying about the hub's state.
 *
 * @param {string} route
 * @param {unknown} body
 */
async function mutate(route, body) {
  const response = await fetch(route, postJson(body)).catch(() => null);
  if (response?.ok !== true) {
    showNotice("Could not update the project list", await reasonFrom(response));

    return false;
  }

  inventory = await inventoryFrom(response);
  renderToolbar();
  renderPicker();

  return true;
}

/** @param {ProjectSummary} project */
async function hideProject(project) {
  const hidden = await mutate("/api/list/hidden", { path: project.path, hidden: true });

  if (!hidden || project.slug !== activeSlug) {
    return;
  }

  const [next] = visible();
  if (next) {
    void switchTo(next.slug);
  }
}

/** @param {ProjectSummary} project */
async function showProject(project) {
  await mutate("/api/list/hidden", { path: project.path, hidden: false });
}

/**
 * @param {ProjectSummary} project
 * @param {number} step
 */
async function nudge(project, step) {
  const order = visible();
  const from = order.findIndex((candidate) => candidate.path === project.path);
  const to = from + step;
  if (from === -1 || to < 0 || to >= order.length) {
    return;
  }

  const anchor = step > 0 ? order[to + 1] : order[to];
  await mutate("/api/list/order", { path: project.path, before: anchor?.path ?? null });

  focusPill(project.slug);
}

/** @param {string} slug */
function focusPill(slug) {
  const pill = document.querySelector(`.project[data-slug="${CSS.escape(slug)}"]`);
  if (pill instanceof HTMLElement) {
    pill.focus();
  }
}

/* Rendering ---------------------------------------------------------------- */

/** @param {ProjectSummary} project */
function projectButton(project) {
  const button = document.createElement("button");
  button.className = "project";
  button.type = "button";
  button.title = project.path;
  button.draggable = true;
  button.dataset.slug = project.slug;
  button.dataset.path = project.path;
  button.setAttribute("aria-current", String(project.slug === activeSlug));
  button.append(statusDot(project), document.createTextNode(project.name));
  button.addEventListener("click", () => {
    void switchTo(project.slug);
  });
  button.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openContextMenu(project, event);
  });
  button.addEventListener("keydown", (event) => {
    if (event.key === "h" || event.key === "H") {
      event.preventDefault();
      void hideProject(project);
    } else if (event.altKey && event.key === "ArrowLeft") {
      event.preventDefault();
      void nudge(project, -1);
    } else if (event.altKey && event.key === "ArrowRight") {
      event.preventDefault();
      void nudge(project, 1);
    }
  });
  button.addEventListener("dragstart", (event) => {
    dragging = project.path;
    button.classList.add("dragging");
    event.dataTransfer?.setData("text/plain", project.path);
  });
  button.addEventListener("dragend", () => {
    dragging = null;
    button.classList.remove("dragging");
    clearDropMarks();
    renderToolbar();
  });

  const item = document.createElement("li");
  item.append(button);

  return item;
}

/** @param {ProjectSummary} project */
function statusDot(project) {
  const status = statuses.get(project.slug) ?? "idle";

  const dot = document.createElement("span");
  dot.className = "status";
  dot.dataset.status = status;
  dot.append(labelled(status));

  return dot;
}

/** @param {string} caption */
function labelled(caption) {
  const label = element("span", caption);
  label.className = "visually-hidden";

  return label;
}

/**
 * Rebuilding under a live drag is what wedges the gesture: `settle` re-renders every 400 ms while
 * a child is starting, and `replaceChildren` would destroy the pill the pointer is holding.
 */
function renderToolbar() {
  if (dragging !== null) {
    return;
  }

  projectList.replaceChildren(...visible().map((project) => projectButton(project)));
  collapseOverflow();
}

function collapseOverflow() {
  projectList.append(...overflowList.children);
  overflow.hidden = true;
  overflowSummary.textContent = "More";

  if (!fitsOneRow()) {
    overflow.hidden = false;
    const spilled = [];
    while (!fitsOneRow() && projectList.children.length > 1) {
      const last = projectList.lastElementChild;
      if (last === null) {
        break;
      }

      last.remove();
      spilled.unshift(last);
    }
    overflowList.replaceChildren(...spilled);

    const active = overflowList.querySelector('[aria-current="true"]');
    if (active !== null) {
      overflowSummary.textContent = active.textContent;
    }
  }

  setDraggable(projectList, true);
  setDraggable(overflowList, false);
}

/**
 * A pill keeps its listeners as `collapseOverflow` moves the node between the two lists, so the
 * drag affordance has to be revoked on the way in and restored on the way out.
 *
 * @param {Readonly<{ querySelectorAll: (selectors: string) => Iterable<Element> }>} list
 * @param {boolean} draggable
 */
function setDraggable(list, draggable) {
  for (const pill of list.querySelectorAll(".project")) {
    if (pill instanceof HTMLElement) {
      pill.draggable = draggable;
    }
  }
}

function fitsOneRow() {
  return switcher.scrollWidth <= switcher.clientWidth;
}

/* Dragging ----------------------------------------------------------------- */

/**
 * The pill the dragged one should land in front of, or `null` for the end of the row.
 *
 * @param {number} edge the viewport x the pointer is at
 */
function anchorAt(edge) {
  for (const pill of projectList.querySelectorAll(".project")) {
    if (!(pill instanceof HTMLElement) || pill.dataset.path === dragging) {
      continue;
    }

    const box = pill.getBoundingClientRect();
    if (edge < box.left + box.width / 2) {
      return pill;
    }
  }

  return null;
}

/** @param {number} edge the viewport x the pointer is at */
function markDrop(edge) {
  clearDropMarks();
  const anchor = anchorAt(edge);

  if (anchor === null) {
    projectList.lastElementChild?.classList.add("drop-after");
  } else {
    anchor.parentElement?.classList.add("drop-before");
  }
}

function clearDropMarks() {
  for (const item of projectList.children) {
    item.classList.remove("drop-before", "drop-after");
  }
}

/* Context menu ------------------------------------------------------------- */

/**
 * @param {ProjectSummary} project
 * @param {Readonly<{ clientX: number, clientY: number }>} at where the pointer opened the menu
 */
function openContextMenu(project, at) {
  const items = [
    menuItem(`Hide ${project.name}`, () => {
      void hideProject(project);
    }),
  ];
  if (project.added) {
    items.push(
      menuItem(`Remove ${project.name} from the list`, () => {
        void removeProject(project);
      }),
    );
  }
  const [item] = items;

  contextMenu.replaceChildren(...items);
  contextMenu.hidden = false;
  contextMenu.style.left = `${at.clientX}px`;
  contextMenu.style.top = `${at.clientY}px`;
  item?.focus();
}

/**
 * @param {string} label
 * @param {() => void} act
 */
function menuItem(label, act) {
  const item = document.createElement("button");
  item.className = "menu-item";
  item.type = "button";
  item.textContent = label;
  item.addEventListener("click", () => {
    closeContextMenu();
    act();
  });

  return item;
}

function closeContextMenu() {
  contextMenu.hidden = true;
  contextMenu.replaceChildren();
}

function renderStage() {
  if (inventory.projects.length === 0) {
    showEmptyRoot();
    return;
  }
  if (activation === null) {
    showMessage("Pick a project", "Choose a project from the toolbar above.");
    return;
  }

  if (
    activation.status === "ready" &&
    activation.url !== null &&
    activation.url !== "" &&
    activeSlug !== null
  ) {
    showBoard(activeSlug, activation.url);
    return;
  }
  if (activation.status === "failed") {
    showFailure(activation);
    return;
  }
  if (activation.status === "idle") {
    showDeadChild(`${nameOf(activeSlug)} stopped`, "The hub stopped it to free resources.");
    return;
  }

  showMessage("Starting…", `Waiting for ${nameOf(activeSlug)} to come up.`);
}

/**
 * Each project keeps its own frame, shown and hidden rather than reloaded. Reassigning `src`
 * makes the embedded document repaint from its own white canvas, which no styling on this side
 * can cover, and it throws away the board's scroll and filter state.
 *
 * @param {string} slug
 * @param {string} url
 */
function showBoard(slug, url) {
  const frame = frameFor(slug, url);

  if (frame.dataset.loaded === "yes") {
    reveal(slug);
  }
}

/** @param {string} slug */
function reveal(slug) {
  for (const [other, otherFrame] of frames) {
    otherFrame.hidden = other !== slug;
  }
  placeholder.hidden = true;
}

/**
 * @param {string} slug
 * @param {string} url
 */
function frameFor(slug, url) {
  const existing = frames.get(slug);
  if (existing && existing.src === url) {
    return existing;
  }

  existing?.remove();

  const frame = document.createElement("iframe");
  frame.className = "board";
  frame.title = `${nameOf(slug)} board`;
  frame.hidden = true;
  frame.addEventListener("load", () => {
    frame.dataset.loaded = "yes";
    if (activeSlug === slug) {
      reveal(slug);
    }
  });
  frame.src = url;
  stage.append(frame);
  frames.set(slug, frame);

  return frame;
}

/**
 * A frame outlives its child unless something drops it: the hub gives a restarted child the port it
 * had, so `frameFor` would match on `src` and re-reveal the document the stopped child served.
 */
function dropStoppedFrames() {
  const stopped = [...frames.keys()].filter((slug) => statuses.get(slug) !== "ready");

  for (const slug of stopped) {
    dropFrame(slug);
  }
}

function hideBoards() {
  for (const frame of frames.values()) {
    frame.hidden = true;
  }
}

/** @param {string} slug */
function dropFrame(slug) {
  frames.get(slug)?.remove();
  frames.delete(slug);
}

/**
 * @param {string} heading
 * @param {string} detail
 */
function showMessage(heading, detail) {
  hideBoards();
  placeholder.hidden = false;
  placeholder.replaceChildren(element("h1", heading), element("p", detail));
}

function showEmptyRoot() {
  hideBoards();
  placeholder.hidden = false;

  const detail = element("p", "Looked for a ");
  detail.append(element("code", "backlog/config.yml"), ` under ${inventory.root}, `);
  detail.append(`up to ${inventory.depth} levels deep. Create one with `);
  detail.append(element("code", "backlog init"), ", then press Refresh.");

  placeholder.replaceChildren(element("h1", "No Backlog.md projects found"), detail);
}

/** @param {Activation} failure */
function showFailure(failure) {
  showDeadChild(
    `${nameOf(activeSlug)} failed to start`,
    failure.error ?? "The backlog browser process exited.",
    failure.stderr,
  );
}

/**
 * The frame goes with the screen. Retry respawns the child on its remembered port, so a kept
 * frame would match on `src` and be re-revealed showing the document the dead child served.
 *
 * @param {string} heading
 * @param {string} detail
 * @param {string | null} [stderr]
 */
function showDeadChild(heading, detail, stderr) {
  hideBoards();
  if (activeSlug !== null) {
    dropFrame(activeSlug);
  }
  placeholder.hidden = false;

  const retry = element("button", "Retry");
  retry.className = "action";
  retry.addEventListener("click", () => {
    void switchTo(activeSlug, { force: true });
  });

  const children = [element("h1", heading), element("p", detail)];
  if (stderr !== undefined && stderr !== null && stderr !== "") {
    children.push(element("pre", stderr));
  }
  children.push(retry);

  placeholder.replaceChildren(...children);
}

/**
 * @param {string} tag
 * @param {string} content
 */
function element(tag, content) {
  const node = document.createElement(tag);
  node.textContent = content;

  return node;
}

/** @param {string | null} slug */
function nameOf(slug) {
  return inventory.projects.find((project) => project.slug === slug)?.name ?? slug ?? "the project";
}

/* Status ------------------------------------------------------------------- */

/** Naming the on-screen project is what keeps its child warm past the hub's idle sweep. */
async function loadStatuses() {
  const route =
    activeSlug === null ? "/api/status" : `/api/status?active=${encodeURIComponent(activeSlug)}`;
  const response = await fetch(route);
  const reported = fields(await response.json());
  statuses = new Map(
    Object.entries(reported).map(([slug, status]) => [slug, text(status, "status")]),
  );
}

/**
 * A refused tick is not news: the hub is local, the next tick is 2 s away, and the statuses on
 * screen are simply left as they were. What the catch is really for is the chain, which nothing
 * re-arms after a rejection, so the failure is absorbed here and the tick still ends in a
 * reschedule.
 */
async function pollStatus() {
  await loadStatuses().catch(keepLastKnownStatuses);

  patchDots();
  restageIfChanged();
  dropStoppedFrames();
  scheduleStatusPoll();
}

/**
 * `activation` is `null` between a switch and its response, and the stage must not be re-driven
 * then: a tick would paint a dead-child screen over a project that is still booting.
 */
function restageIfChanged() {
  if (activeSlug === null || activation === null) {
    return;
  }
  if (statuses.get(activeSlug) === activation.status) {
    return;
  }

  void restage(activeSlug);
}

/**
 * A hidden tab still holds a board on screen, and coming back to a stopped one is the whole
 * complaint the idle sweep would otherwise cause. So hiding drops the rendering work and keeps
 * the report that stays the sweep, at a period the browser's background throttle allows.
 */
async function keepWarm() {
  if (activeSlug !== null) {
    await fetch(`/api/status?active=${encodeURIComponent(activeSlug)}`).catch(
      keepLastKnownStatuses,
    );
  }

  scheduleStatusPoll();
}

/**
 * The answer to a status request that did not arrive. `statuses` already holds the last report
 * the hub gave, and leaving it standing is the whole handling a background tick needs: the
 * alternative, clearing it, would paint every pill grey over a hub that is merely slow.
 */
function keepLastKnownStatuses() {
  return undefined;
}

/**
 * The clear keeps a tick resumed beside a fresh visibilitychange chain from forking the poll,
 * and re-arming on the tab's own state is what hands the chain between the two tick kinds.
 */
function scheduleStatusPoll() {
  clearTimeout(statusTimer);

  statusTimer = document.hidden
    ? setTimeout(keepWarm, KEEP_WARM_MS)
    : setTimeout(pollStatus, STATUS_POLL_MS);
}

/**
 * A tick must never call `renderToolbar`: the rebuild drops keyboard focus to `<body>` and would
 * tear the pill out from under a live drag. Writing the dot in place touches no structure, so it
 * needs no `dragging` guard of its own.
 */
function patchDots() {
  for (const pill of document.querySelectorAll(".project")) {
    if (!(pill instanceof HTMLElement) || pill.dataset.slug === undefined) {
      continue;
    }

    const status = statuses.get(pill.dataset.slug) ?? "idle";
    const dot = pill.querySelector(".status");
    if (!(dot instanceof HTMLElement) || dot.dataset.status === status) {
      continue;
    }

    dot.dataset.status = status;
    const label = dot.querySelector(".visually-hidden");
    if (label !== null) {
      label.textContent = status;
    }
  }
}

/* Activation --------------------------------------------------------------- */

/**
 * @param {string | null} slug
 * @param {Readonly<{ force?: boolean, replace?: boolean }>} [options]
 */
async function switchTo(slug, options = {}) {
  if (slug === null) {
    return;
  }
  if (slug === activeSlug && options.force !== true) {
    return;
  }

  activeSlug = slug;
  activation = null;
  activationEpoch += 1;
  overflow.removeAttribute("open");
  clearTimeout(pollTimer);
  renderToolbar();
  renderStage();

  const url = `/?project=${encodeURIComponent(slug)}`;
  if (options.replace === true) {
    history.replaceState({ slug }, "", url);
  } else {
    history.pushState({ slug }, "", url);
  }

  await settle(slug, `${projectRoute(slug)}/activate`, activationEpoch, { method: "POST" });
}

/**
 * The epoch retires the whole poll chain on a switch: a response landing after another
 * `switchTo` must neither drive the stage nor re-arm a second chain beside the new one.
 *
 * @param {string} slug
 * @param {string} path
 * @param {number} epoch
 * @param {JsonPost} [init]
 */
async function settle(slug, path, epoch, init) {
  const response = await fetch(path, init).catch(() => null);
  if (epoch !== activationEpoch) {
    return;
  }

  const answer =
    response?.ok === true ? await activationFrom(response).catch(() => null) : null;
  if (epoch !== activationEpoch) {
    return;
  }

  const settled = answer ?? {
    status: "failed",
    url: null,
    error: `The hub could not start ${nameOf(slug)}.`,
    stderr: null,
  };

  activation = settled;
  statuses.set(slug, settled.status);
  patchDots();
  dropStoppedFrames();
  renderStage();

  if (settled.status === "starting") {
    pollTimer = setTimeout(() => settle(slug, projectRoute(slug), epoch), POLL_INTERVAL_MS);
  }
}

/**
 * A failed fetch is not a death. `settle` answers one by fabricating a start failure, which is
 * right for an activation the user asked for and wrong for a background tick: a hiccup would flip
 * a healthy stage to a failure screen.
 *
 * @param {string} slug
 */
async function restage(slug) {
  const response = await fetch(`/api/projects/${encodeURIComponent(slug)}`).catch(() => null);
  if (response?.ok !== true || slug !== activeSlug) {
    return;
  }

  activation = await activationFrom(response);
  renderStage();
}

/* Discovery ---------------------------------------------------------------- */

/**
 * @param {string} path
 * @param {JsonPost} [init]
 */
async function load(path, init) {
  const response = await fetch(path, init).catch(() => null);
  if (response?.ok !== true) {
    return;
  }

  inventory = await inventoryFrom(response);
  await loadStatuses();
  renderToolbar();
  renderStage();
}

/** @param {number} [depth] */
async function refresh(depth) {
  await load("/api/refresh", postJson(depth === undefined ? {} : { depth }));

  const vanished = [...frames.keys()].filter(
    (slug) => !inventory.projects.some((project) => project.slug === slug),
  );

  for (const slug of vanished) {
    dropFrame(slug);
  }

  if (activeSlug !== null && !inventory.projects.some((it) => it.slug === activeSlug)) {
    activeSlug = null;
    activation = null;
    renderToolbar();
    renderStage();
  }
}

/** @param {number} step */
function cycle(step) {
  const slugs = visible().map((project) => project.slug);
  if (slugs.length === 0) {
    return;
  }

  const next = (slugs.indexOf(activeSlug ?? "") + step + slugs.length) % slugs.length;
  void switchTo(slugs[next] ?? null);
}

/* Settings ----------------------------------------------------------------- */

function openRefreshDialog() {
  refreshDepth.value = String(inventory.depth);
  refreshNote.textContent = `Under ${inventory.root}`;
  refreshDialog.showModal();
  refreshDepth.select();
}

/* Adding a project folder --------------------------------------------------- */

/**
 * The chooser is the host's, opened by the hub, because a page cannot learn an absolute path from
 * one of its own. The button stays disabled meanwhile: the dialog is modal on the desktop, so a
 * second click would queue a second one behind it.
 */
async function chooseFolder() {
  browseButton.disabled = true;
  try {
    const response = await fetch("/api/choose-folder", { method: "POST" }).catch(() => null);
    if (response?.ok !== true) {
      showNotice("Could not open the folder chooser", await reasonFrom(response));
      return;
    }

    const chosen = fields(await response.json());
    if (chosen.kind === "chosen") {
      await addFolder(text(chosen.path, "path"));
    }
  } finally {
    browseButton.disabled = false;
  }
}

/** @param {Response | null} response */
async function reasonFrom(response) {
  if (response === null) {
    return "The hub did not answer.";
  }

  const body = await response
    .json()
    .then((value) => fields(value))
    .catch(() => null);
  const reason = stringOrNull(body?.error);

  return reason ?? `The hub answered ${response.status}.`;
}

/** @param {string} path */
async function addFolder(path) {
  const response = await fetch("/api/list/added", postJson({ path, added: true })).catch(
    () => null,
  );
  if (response?.ok !== true) {
    showNotice("Could not add that folder", await reasonFrom(response));
    return;
  }

  inventory = await inventoryFrom(response);
  await loadStatuses();
  renderToolbar();
  renderPicker();

  const added = inventory.projects.find((project) => project.path === path);
  if (added) {
    void switchTo(added.slug);
  }
}

/** @param {ProjectSummary} project */
async function removeProject(project) {
  const removed = await mutate("/api/list/added", { path: project.path, added: false });
  if (!removed) {
    return;
  }

  dropFrame(project.slug);
  if (project.slug !== activeSlug) {
    return;
  }

  activeSlug = null;
  activation = null;
  renderToolbar();
  renderStage();
}

/**
 * @param {string} heading
 * @param {string} detail
 */
function showNotice(heading, detail) {
  noticeHeading.textContent = heading;
  noticeDetail.textContent = detail;
  notice.showModal();
}

/* Picker ------------------------------------------------------------------- */

/** @param {string} query */
function matching(query) {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return inventory.projects;
  }

  return inventory.projects.filter((project) =>
    `${project.name} ${project.path}`.toLowerCase().includes(needle),
  );
}

function renderPicker() {
  const found = matching(pickerInput.value);
  const listed = found.filter((project) => !project.hidden);
  const concealed = showHidden.checked ? found.filter((project) => project.hidden) : [];
  highlighted = Math.min(highlighted, Math.max(listed.length + concealed.length - 1, 0));

  const rows = listed.map((project, index) => pickerRow(project, index));
  if (concealed.length > 0) {
    rows.push(
      separator("Hidden"),
      ...concealed.map((project, index) => pickerRow(project, listed.length + index)),
    );
  }

  pickerList.replaceChildren(...rows);
  orderMode.textContent = inventory.mode;
}

/** @param {string} label */
function separator(label) {
  const item = document.createElement("li");
  item.className = "picker-separator";
  item.append(label);

  return item;
}

/**
 * @param {ProjectSummary} project
 * @param {number} index
 */
function pickerRow(project, index) {
  const path = element("span", project.path);
  path.className = "picker-path";

  const option = document.createElement("button");
  option.className = "picker-option";
  option.type = "button";
  option.setAttribute("aria-selected", String(index === highlighted));
  option.append(element("span", project.name), path);
  option.addEventListener("click", () => {
    picker.close();
    void switchTo(project.slug);
  });

  const item = document.createElement("li");
  item.className = "picker-row";
  item.append(option);

  if (project.hidden) {
    item.append(unhideButton(project));
  }

  return item;
}

/** @param {ProjectSummary} project */
function unhideButton(project) {
  const unhide = document.createElement("button");
  unhide.className = "action";
  unhide.type = "button";
  unhide.textContent = "Unhide";
  unhide.addEventListener("click", () => {
    void showProject(project);
  });

  return unhide;
}

function openPicker() {
  highlighted = 0;
  pickerInput.value = "";
  renderPicker();
  picker.showModal();
  pickerInput.focus();
}

function pickerOptions() {
  return [...pickerList.querySelectorAll(".picker-option")].filter(
    (node) => node instanceof HTMLElement,
  );
}

function highlightedOption() {
  return pickerOptions()[highlighted] ?? null;
}

/** @param {number} step */
function movePickerSelection(step) {
  const count = pickerOptions().length;
  if (count === 0) {
    return;
  }

  highlighted = (highlighted + step + count) % count;
  renderPicker();
  highlightedOption()?.scrollIntoView({ block: "nearest" });
}

/**
 * `history.state` is whatever a previous page in this tab pushed, so it is read as unknown and
 * narrowed here rather than trusted to hold the `{ slug }` this shell writes.
 *
 * @param {unknown} state
 * @returns {string | null}
 */
function slugFromHistory(state) {
  const held = fieldsOrNull(state);
  if (held === null) {
    return null;
  }

  const slug = stringOrNull(held.slug);

  return slug === "" ? null : slug;
}

/**
 * `PopStateEvent.state` is typed `any`, which would spread through every caller. Reading it here,
 * behind a check that the event is really a popstate, is what turns it back into `unknown` so the
 * parser above has to do its work.
 *
 * @param {Readonly<{ state: unknown }>} carrier
 * @returns {unknown}
 */
function restoredState(carrier) {
  const { state } = carrier;

  return state;
}

/** @returns {string | null} */
function openingParam() {
  return new URL(location.href).searchParams.get("project");
}

/* Wiring ------------------------------------------------------------------- */

must("refresh-button").addEventListener("click", openRefreshDialog);
must("picker-button").addEventListener("click", openPicker);
browseButton.addEventListener("click", () => {
  void chooseFolder();
});

must("refresh-form").addEventListener("submit", () => {
  void refresh(Number(refreshDepth.value));
});

for (const button of document.querySelectorAll("[data-close]")) {
  button.addEventListener("click", () => button.closest("dialog")?.close());
}
must("reset-order").addEventListener("click", () => {
  void mutate("/api/list/reset", {});
});

showHidden.addEventListener("change", () => {
  highlighted = 0;
  renderPicker();
});

pickerInput.addEventListener("input", () => {
  highlighted = 0;
  renderPicker();
});

pickerInput.addEventListener("keydown", (event) => {
  if ((event.key === "Backspace" || event.key === "Delete") && pickerInput.value === "") {
    event.preventDefault();
    picker.close();
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    movePickerSelection(1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    movePickerSelection(-1);
  } else if (event.key === "Enter") {
    event.preventDefault();
    highlightedOption()?.click();
  }
});

projectList.addEventListener("dragover", (event) => {
  if (dragging === null) {
    return;
  }

  event.preventDefault();
  markDrop(event.clientX);
});

projectList.addEventListener("drop", (event) => {
  if (dragging === null) {
    return;
  }

  event.preventDefault();
  const anchor = anchorAt(event.clientX);
  void mutate("/api/list/order", { path: dragging, before: anchor?.dataset.path ?? null });
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    scheduleStatusPoll();
  } else {
    void pollStatus();
  }
});

document.addEventListener("pointerdown", (event) => {
  if (contextMenu.hidden === true) {
    return;
  }
  if (event.target instanceof Node && contextMenu.contains(event.target)) {
    return;
  }

  closeContextMenu();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && contextMenu.hidden === false) {
    closeContextMenu();
    return;
  }

  if (!(event.metaKey || event.ctrlKey)) {
    return;
  }

  if (event.key === "k" || event.key === "K") {
    event.preventDefault();
    openPicker();
  } else if (event.key === "[") {
    event.preventDefault();
    cycle(-1);
  } else if (event.key === "]") {
    event.preventDefault();
    cycle(1);
  }
});

globalThis.addEventListener("popstate", (event) => {
  const restored = event instanceof PopStateEvent ? restoredState(event) : null;
  const slug = slugFromHistory(restored) ?? openingParam();
  if (slug !== null && slug !== "") {
    void switchTo(slug, { replace: true });
  }
});

new ResizeObserver(collapseOverflow).observe(switcher);

await load("/api/projects");

const remembered = inventory.projects.some((project) => project.slug === inventory.active)
  ? inventory.active
  : null;
const opening = new URL(location.href).searchParams.get("project") ?? remembered;

if (opening !== null) {
  await switchTo(opening, { replace: true });
}

scheduleStatusPoll();

/**
 * The shell is served as text and runs as the page's only module; it exports nothing anyone
 * imports. The marker is still load-bearing: without it the file is a script, and `frames` at the
 * top level would collide with `window.frames` instead of being this module's own binding.
 */
export const SHELL_IS_A_MODULE = true;
