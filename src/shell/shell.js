/**
 * @typedef {{ slug: string, name: string, path: string, status: string }} ProjectSummary
 * @typedef {{ root: string, depth: number, active: string | null, projects: ProjectSummary[] }} Inventory
 * @typedef {{ status: string, url?: string, error?: string, stderr?: string }} Activation
 */

/** @param {string} id */
function must(id) {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`the shell document is missing #${id}`);

  return node;
}

const overflow = must("overflow");
const overflowList = must("overflow-list");
const overflowSummary = must("overflow-summary");
const picker = /** @type {HTMLDialogElement} */ (must("picker"));
const pickerInput = /** @type {HTMLInputElement} */ (must("picker-input"));
const pickerList = must("picker-list");
const placeholder = must("placeholder");
const projectList = must("project-list");
const stage = /** @type {HTMLElement} */ (must("placeholder").parentElement);
const switcher = /** @type {HTMLElement} */ (must("project-list").parentElement);

const POLL_INTERVAL_MS = 400;
const MAX_FRAMES = 4;

/** @type {Inventory} */
let inventory = { root: "", depth: 0, active: null, projects: [] };
/** @type {string | null} */
let activeSlug = null;
/** @type {Activation | null} */
let activation = null;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let pollTimer;
let highlighted = 0;

/** @type {Map<string, HTMLIFrameElement>} */
const frames = new Map();

/* Rendering ---------------------------------------------------------------- */

/** @param {ProjectSummary} project */
function projectButton(project) {
  const button = document.createElement("button");
  button.className = "project";
  button.type = "button";
  button.title = project.path;
  button.setAttribute("aria-current", String(project.slug === activeSlug));
  button.append(statusDot(project), document.createTextNode(project.name));
  button.addEventListener("click", () => switchTo(project.slug));

  const item = document.createElement("li");
  item.append(button);

  return item;
}

/** @param {ProjectSummary} project */
function statusDot(project) {
  const status =
    project.slug === activeSlug && activation ? activation.status : (project.status ?? "idle");

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

function renderToolbar() {
  projectList.replaceChildren(...inventory.projects.map(projectButton));
  collapseOverflow();
}

function collapseOverflow() {
  projectList.append(...overflowList.children);
  overflow.hidden = true;
  overflowSummary.textContent = "More";

  if (fitsOneRow()) return;

  overflow.hidden = false;
  const hidden = [];
  while (!fitsOneRow() && projectList.children.length > 1) {
    const last = projectList.lastElementChild;
    if (last === null) break;

    last.remove();
    hidden.unshift(last);
  }
  overflowList.replaceChildren(...hidden);

  const active = overflowList.querySelector('[aria-current="true"]');
  if (active !== null) overflowSummary.textContent = active.textContent;
}

function fitsOneRow() {
  return switcher.scrollWidth <= switcher.clientWidth;
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
  evictFrames();
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

function evictFrames() {
  while (frames.size > MAX_FRAMES) {
    const [oldest, frame] = /** @type {[string, HTMLIFrameElement]} */ ([...frames][0]);
    frame.remove();
    frames.delete(oldest);
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
  hideBoards();
  placeholder.hidden = false;

  const retry = element("button", "Retry");
  retry.className = "action";
  retry.addEventListener("click", () => switchTo(activeSlug, { force: true }));

  const children = [
    element("h1", `${nameOf(activeSlug)} failed to start`),
    element("p", failure.error ?? "The backlog browser process exited."),
  ];
  if (failure.stderr) children.push(element("pre", failure.stderr));
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

  activation = response?.ok
    ? await response.json()
    : { status: "failed", error: `The hub could not start ${nameOf(slug)}.` };

  renderToolbar();
  renderStage();

  if (activation?.status === "starting") {
    pollTimer = setTimeout(
      () => settle(slug, `/api/projects/${encodeURIComponent(slug)}`),
      POLL_INTERVAL_MS,
    );
  }
}

/* Discovery ---------------------------------------------------------------- */

/**
 * @param {string} path
 * @param {RequestInit} [init]
 */
async function load(path, init) {
  inventory = await (await fetch(path, init)).json();
  renderToolbar();
  renderStage();
}

async function refresh() {
  await load("/api/refresh", { method: "POST" });

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
  const slugs = inventory.projects.map((project) => project.slug);
  if (slugs.length === 0) return;

  const next = (slugs.indexOf(activeSlug ?? "") + step + slugs.length) % slugs.length;
  switchTo(slugs[next] ?? null);
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
  highlighted = Math.min(highlighted, Math.max(found.length - 1, 0));

  pickerList.replaceChildren(...found.map(pickerOption));
}

/**
 * @param {ProjectSummary} project
 * @param {number} index
 */
function pickerOption(project, index) {
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
  item.append(option);

  return item;
}

function openPicker() {
  highlighted = 0;
  pickerInput.value = "";
  renderPicker();
  picker.showModal();
  pickerInput.focus();
}

function highlightedOption() {
  return pickerList.children[highlighted]?.querySelector("button") ?? null;
}

/** @param {number} step */
function movePickerSelection(step) {
  const count = pickerList.children.length;
  if (count === 0) return;

  highlighted = (highlighted + step + count) % count;
  renderPicker();
  highlightedOption()?.scrollIntoView({ block: "nearest" });
}

/* Wiring ------------------------------------------------------------------- */

must("refresh-button").addEventListener("click", refresh);
must("picker-button").addEventListener("click", openPicker);

pickerInput.addEventListener("input", () => {
  highlighted = 0;
  renderPicker();
});

pickerInput.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") {
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

document.addEventListener("keydown", (event) => {
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

export {};
