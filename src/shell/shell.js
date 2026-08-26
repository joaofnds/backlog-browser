/**
 * @typedef {{ slug: string, name: string, path: string, hidden: boolean, added: boolean }} ProjectSummary
 * @typedef {"default" | "manual"} OrderMode
 * @typedef {{ root: string, depth: number, active: string | null, mode: OrderMode, projects: ProjectSummary[] }} Inventory
 * @typedef {{ status: string, url?: string, error?: string, stderr?: string }} Activation
 * @typedef {{ kind: "chosen", path: string } | { kind: "cancelled" }} ChosenFolder
 */

/** @param {string} id */
function must(id) {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`the shell document is missing #${id}`);

  return node;
}

const browseButton = /** @type {HTMLButtonElement} */ (must("browse-button"));
const contextMenu = must("context-menu");
const notice = /** @type {HTMLDialogElement} */ (must("notice"));
const noticeDetail = must("notice-detail");
const orderMode = must("order-mode");
const overflow = must("overflow");
const overflowList = must("overflow-list");
const overflowSummary = must("overflow-summary");
const picker = /** @type {HTMLDialogElement} */ (must("picker"));
const refreshDepth = /** @type {HTMLInputElement} */ (must("refresh-depth"));
const refreshDialog = /** @type {HTMLDialogElement} */ (must("refresh-dialog"));
const refreshNote = must("refresh-note");
const pickerInput = /** @type {HTMLInputElement} */ (must("picker-input"));
const pickerList = must("picker-list");
const placeholder = must("placeholder");
const projectList = must("project-list");
const showHidden = /** @type {HTMLInputElement} */ (must("show-hidden"));
const stage = /** @type {HTMLElement} */ (must("placeholder").parentElement);
const switcher = /** @type {HTMLElement} */ (must("project-list").parentElement);

const POLL_INTERVAL_MS = 400;
const STATUS_POLL_MS = 2_000;

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

/** @type {Map<string, HTMLIFrameElement>} */
const frames = new Map();

/* The list ----------------------------------------------------------------- */

function visible() {
  return inventory.projects.filter((project) => !project.hidden);
}

/**
 * @param {string} route
 * @param {unknown} body
 */
async function mutate(route, body) {
  const response = await fetch(route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => null);
  if (!response?.ok) return;

  inventory = await response.json();
  renderToolbar();
  renderPicker();
}

/** @param {ProjectSummary} project */
async function hideProject(project) {
  await mutate("/api/list/hidden", { path: project.path, hidden: true });

  if (project.slug !== activeSlug) return;

  const next = visible()[0];
  if (next) switchTo(next.slug);
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
  if (from < 0 || to < 0 || to >= order.length) return;

  const anchor = step > 0 ? order[to + 1] : order[to];
  await mutate("/api/list/order", { path: project.path, before: anchor?.path ?? null });

  focusPill(project.slug);
}

/** @param {string} slug */
function focusPill(slug) {
  const pill = document.querySelector(`.project[data-slug="${CSS.escape(slug)}"]`);
  if (pill instanceof HTMLElement) pill.focus();
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
  button.addEventListener("click", () => switchTo(project.slug));
  button.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openContextMenu(project, event);
  });
  button.addEventListener("keydown", (event) => {
    if (event.key === "h" || event.key === "H") {
      event.preventDefault();
      hideProject(project);
    } else if (event.altKey && event.key === "ArrowLeft") {
      event.preventDefault();
      nudge(project, -1);
    } else if (event.altKey && event.key === "ArrowRight") {
      event.preventDefault();
      nudge(project, 1);
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

/** @param {string} text */
function labelled(text) {
  const label = element("span", text);
  label.className = "visually-hidden";

  return label;
}

/**
 * Rebuilding under a live drag is what wedges the gesture: `settle` re-renders every 400 ms while
 * a child is starting, and `replaceChildren` would destroy the pill the pointer is holding.
 */
function renderToolbar() {
  if (dragging !== null) return;

  projectList.replaceChildren(...visible().map(projectButton));
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
      if (last === null) break;

      last.remove();
      spilled.unshift(last);
    }
    overflowList.replaceChildren(...spilled);

    const active = overflowList.querySelector('[aria-current="true"]');
    if (active !== null) overflowSummary.textContent = active.textContent;
  }

  setDraggable(projectList, true);
  setDraggable(overflowList, false);
}

/**
 * A pill keeps its listeners as `collapseOverflow` moves the node between the two lists, so the
 * drag affordance has to be revoked on the way in and restored on the way out.
 *
 * @param {Element} list
 * @param {boolean} draggable
 */
function setDraggable(list, draggable) {
  for (const pill of list.querySelectorAll(".project")) {
    if (pill instanceof HTMLElement) pill.draggable = draggable;
  }
}

function fitsOneRow() {
  return switcher.scrollWidth <= switcher.clientWidth;
}

/* Dragging ----------------------------------------------------------------- */

/**
 * The pill the dragged one should land in front of, or `null` for the end of the row.
 *
 * @param {number} x
 */
function anchorAt(x) {
  for (const pill of projectList.querySelectorAll(".project")) {
    if (!(pill instanceof HTMLElement) || pill.dataset.path === dragging) continue;

    const box = pill.getBoundingClientRect();
    if (x < box.left + box.width / 2) return pill;
  }

  return null;
}

/** @param {number} x */
function markDrop(x) {
  clearDropMarks();
  const anchor = anchorAt(x);

  if (anchor !== null) anchor.parentElement?.classList.add("drop-before");
  else projectList.lastElementChild?.classList.add("drop-after");
}

function clearDropMarks() {
  for (const item of projectList.children) item.classList.remove("drop-before", "drop-after");
}

/* Context menu ------------------------------------------------------------- */

/**
 * @param {ProjectSummary} project
 * @param {MouseEvent} event
 */
function openContextMenu(project, event) {
  const items = [menuItem(`Hide ${project.name}`, () => hideProject(project))];
  if (project.added) {
    items.push(menuItem(`Remove ${project.name} from the list`, () => removeProject(project)));
  }
  const [item] = items;

  contextMenu.replaceChildren(...items);
  contextMenu.hidden = false;
  contextMenu.style.left = `${event.clientX}px`;
  contextMenu.style.top = `${event.clientY}px`;
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
  if (inventory.projects.length === 0) return showEmptyRoot();
  if (activation === null) {
    return showMessage("Pick a project", "Choose a project from the toolbar above.");
  }

  if (activation.status === "ready" && activation.url && activeSlug !== null) {
    return showBoard(activeSlug, activation.url);
  }
  if (activation.status === "failed") return showFailure(activation);
  if (activation.status === "idle") {
    return showDeadChild(`${nameOf(activeSlug)} stopped`, "The hub stopped it to free resources.");
  }

  return showMessage("Starting…", `Waiting for ${nameOf(activeSlug)} to come up.`);
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
  frames.delete(slug);
  frames.set(slug, frame);

  if (frame.dataset.loaded === "yes") reveal(slug);
}

/** @param {string} slug */
function reveal(slug) {
  for (const [other, otherFrame] of frames) otherFrame.hidden = other !== slug;
  placeholder.hidden = true;
}

/**
 * @param {string} slug
 * @param {string} url
 */
function frameFor(slug, url) {
  const existing = frames.get(slug);
  if (existing && existing.src === url) return existing;

  existing?.remove();

  const frame = document.createElement("iframe");
  frame.className = "board";
  frame.title = `${nameOf(slug)} board`;
  frame.hidden = true;
  frame.addEventListener("load", () => {
    frame.dataset.loaded = "yes";
    if (activeSlug === slug) reveal(slug);
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
  for (const slug of [...frames.keys()]) {
    if (statuses.get(slug) !== "ready") dropFrame(slug);
  }
}

function hideBoards() {
  for (const frame of frames.values()) frame.hidden = true;
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
 * @param {string} [stderr]
 */
function showDeadChild(heading, detail, stderr) {
  hideBoards();
  if (activeSlug !== null) dropFrame(activeSlug);
  placeholder.hidden = false;

  const retry = element("button", "Retry");
  retry.className = "action";
  retry.addEventListener("click", () => switchTo(activeSlug, { force: true }));

  const children = [element("h1", heading), element("p", detail)];
  if (stderr) children.push(element("pre", stderr));
  children.push(retry);

  placeholder.replaceChildren(...children);
}

/**
 * @param {string} tag
 * @param {string} text
 */
function element(tag, text) {
  const node = document.createElement(tag);
  node.textContent = text;

  return node;
}

/** @param {string | null} slug */
function nameOf(slug) {
  return inventory.projects.find((project) => project.slug === slug)?.name ?? slug ?? "the project";
}

/* Status ------------------------------------------------------------------- */

async function loadStatuses() {
  statuses = new Map(Object.entries(await (await fetch("/api/status")).json()));
}

/** Without the catch, one refused tick would end the chain: nothing re-arms after a rejection. */
async function pollStatus() {
  await loadStatuses().catch(() => {});

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
  if (activeSlug === null || activation === null) return;
  if (statuses.get(activeSlug) === activation.status) return;

  restage(activeSlug);
}

/** The `hidden` guard catches the tick already in flight when the tab went away. */
function scheduleStatusPoll() {
  if (document.hidden) return;

  statusTimer = setTimeout(pollStatus, STATUS_POLL_MS);
}

/**
 * A tick must never call `renderToolbar`: the rebuild drops keyboard focus to `<body>` and would
 * tear the pill out from under a live drag. Writing the dot in place touches no structure, so it
 * needs no `dragging` guard of its own.
 */
function patchDots() {
  for (const pill of document.querySelectorAll(".project")) {
    if (!(pill instanceof HTMLElement) || pill.dataset.slug === undefined) continue;

    patchDot(pill.querySelector(".status"), statuses.get(pill.dataset.slug) ?? "idle");
  }
}

/**
 * @param {Element | null} dot
 * @param {string} status
 */
function patchDot(dot, status) {
  if (!(dot instanceof HTMLElement) || dot.dataset.status === status) return;

  dot.dataset.status = status;
  const label = dot.querySelector(".visually-hidden");
  if (label !== null) label.textContent = status;
}

/* Activation --------------------------------------------------------------- */

/**
 * @param {string | null} slug
 * @param {{ force?: boolean, replace?: boolean }} [options]
 */
async function switchTo(slug, options = {}) {
  if (slug === null) return;
  if (slug === activeSlug && !options.force) return;

  activeSlug = slug;
  activation = null;
  overflow.removeAttribute("open");
  clearTimeout(pollTimer);
  renderToolbar();
  renderStage();

  const url = `/?project=${encodeURIComponent(slug)}`;
  if (options.replace) history.replaceState({ slug }, "", url);
  else history.pushState({ slug }, "", url);

  await settle(slug, `/api/projects/${encodeURIComponent(slug)}/activate`, { method: "POST" });
}

/**
 * @param {string} slug
 * @param {string} path
 * @param {RequestInit} [init]
 */
async function settle(slug, path, init) {
  const response = await fetch(path, init).catch(() => null);
  if (slug !== activeSlug) return;

  /** @type {Activation} */
  const settled = response?.ok
    ? await response.json()
    : { status: "failed", error: `The hub could not start ${nameOf(slug)}.` };

  activation = settled;
  statuses.set(slug, settled.status);
  patchDots();
  renderStage();

  if (settled.status === "starting") {
    pollTimer = setTimeout(
      () => settle(slug, `/api/projects/${encodeURIComponent(slug)}`),
      POLL_INTERVAL_MS,
    );
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
  if (!response?.ok || slug !== activeSlug) return;

  activation = await response.json();
  renderStage();
}

/* Discovery ---------------------------------------------------------------- */

/**
 * @param {string} path
 * @param {RequestInit} [init]
 */
async function load(path, init) {
  const response = await fetch(path, init).catch(() => null);
  if (!response?.ok) return;

  inventory = await response.json();
  await loadStatuses();
  renderToolbar();
  renderStage();
}

/** @param {number} [depth] */
async function refresh(depth) {
  await load("/api/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(depth === undefined ? {} : { depth }),
  });

  for (const slug of [...frames.keys()]) {
    if (!inventory.projects.some((project) => project.slug === slug)) dropFrame(slug);
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
  if (slugs.length === 0) return;

  const next = (slugs.indexOf(activeSlug ?? "") + step + slugs.length) % slugs.length;
  switchTo(slugs[next] ?? null);
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
    if (!response?.ok) return showNotice(await reasonFrom(response));

    /** @type {ChosenFolder} */
    const chosen = await response.json();
    if (chosen.kind === "chosen") await addFolder(chosen.path);
  } finally {
    browseButton.disabled = false;
  }
}

/** @param {Response | null} response */
async function reasonFrom(response) {
  if (response === null) return "The hub did not answer.";

  const body = await response.json().catch(() => null);

  return body?.error ?? "The folder chooser failed.";
}

/** @param {string} path */
async function addFolder(path) {
  const response = await fetch("/api/list/added", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, added: true }),
  }).catch(() => null);
  if (!response?.ok) return showNotice(`No backlog/config.yml in ${path}.`);

  inventory = await response.json();
  await loadStatuses();
  renderToolbar();
  renderPicker();

  const added = inventory.projects.find((project) => project.path === path);
  if (added) switchTo(added.slug);
}

/** @param {ProjectSummary} project */
async function removeProject(project) {
  await mutate("/api/list/added", { path: project.path, added: false });

  dropFrame(project.slug);
  if (project.slug !== activeSlug) return;

  activeSlug = null;
  activation = null;
  renderToolbar();
  renderStage();
}

/** @param {string} detail */
function showNotice(detail) {
  noticeDetail.textContent = detail;
  notice.showModal();
}

/* Picker ------------------------------------------------------------------- */

/** @param {string} query */
function matching(query) {
  const needle = query.trim().toLowerCase();
  if (needle === "") return inventory.projects;

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
    rows.push(separator("Hidden"));
    rows.push(...concealed.map((project, index) => pickerRow(project, listed.length + index)));
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
    switchTo(project.slug);
  });

  const item = document.createElement("li");
  item.className = "picker-row";
  item.append(option);

  if (project.hidden) item.append(unhideButton(project));

  return item;
}

/** @param {ProjectSummary} project */
function unhideButton(project) {
  const unhide = document.createElement("button");
  unhide.className = "action";
  unhide.type = "button";
  unhide.textContent = "Unhide";
  unhide.addEventListener("click", () => showProject(project));

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
  if (count === 0) return;

  highlighted = (highlighted + step + count) % count;
  renderPicker();
  highlightedOption()?.scrollIntoView({ block: "nearest" });
}

/* Wiring ------------------------------------------------------------------- */

must("refresh-button").addEventListener("click", openRefreshDialog);
must("picker-button").addEventListener("click", openPicker);
browseButton.addEventListener("click", chooseFolder);

must("refresh-form").addEventListener("submit", () => refresh(Number(refreshDepth.value)));

for (const button of document.querySelectorAll("[data-close]")) {
  button.addEventListener("click", () => button.closest("dialog")?.close());
}
must("reset-order").addEventListener("click", () => mutate("/api/list/reset", {}));

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
  if (dragging === null) return;

  event.preventDefault();
  markDrop(event.clientX);
});

projectList.addEventListener("drop", (event) => {
  if (dragging === null) return;

  event.preventDefault();
  const anchor = anchorAt(event.clientX);
  mutate("/api/list/order", { path: dragging, before: anchor?.dataset.path ?? null });
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) clearTimeout(statusTimer);
  else pollStatus();
});

document.addEventListener("pointerdown", (event) => {
  if (contextMenu.hidden) return;
  if (event.target instanceof Node && contextMenu.contains(event.target)) return;

  closeContextMenu();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !contextMenu.hidden) {
    closeContextMenu();
    return;
  }

  if (!(event.metaKey || event.ctrlKey)) return;

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

window.addEventListener("popstate", (event) => {
  const slug = event.state?.slug ?? new URL(location.href).searchParams.get("project");
  if (slug) switchTo(slug, { replace: true });
});

new ResizeObserver(collapseOverflow).observe(switcher);

await load("/api/projects");

const remembered = inventory.projects.some((project) => project.slug === inventory.active)
  ? inventory.active
  : null;
const opening = new URL(location.href).searchParams.get("project") ?? remembered;

if (opening !== null) await switchTo(opening, { replace: true });

scheduleStatusPoll();

export {};
