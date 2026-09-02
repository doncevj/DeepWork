/* ---------------------------------------------------------------------------
   DeepWork — lockdown window logic.

   Two screens: a list of what's in the session, and the reader. File contents
   arrive over lockdown://file/<id>, so nothing here ever sees a path.
   ------------------------------------------------------------------------ */

import * as pdfjs from './vendor/pdf.mjs';

// Same origin as this module, so it satisfies worker-src 'self'.
pdfjs.GlobalWorkerOptions.workerSrc =
  new URL('./vendor/pdf.worker.mjs', import.meta.url).href;

const HOLD_SECONDS = 30;

// 1.0 means "fits the window width", which is what you want for a textbook.
const ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 2.5, 3];
const DEFAULT_ZOOM_INDEX = 3;

// Render this far outside the viewport, measured in viewport heights.
const RENDER_MARGIN = '150% 0px';

const $ = (id) => document.getElementById(id);

const el = {
  home:      $('home'),
  homeList:  $('homeList'),

  viewer:      $('viewer'),
  homeButton:  $('homeButton'),
  viewerTitle: $('viewerTitle'),
  status:      $('viewerStatus'),

  zoomControls: $('zoomControls'),
  zoomOut:      $('zoomOut'),
  zoomIn:       $('zoomIn'),
  zoomLevel:    $('zoomLevel'),

  pdfScroll: $('pdfScroll'),
  pdfPages:  $('pdfPages'),

  dialog:  $('exitDialog'),
  goBack:  $('goBack'),
  doExit:  $('doExit'),
  counter: $('holdCounter')
};

/* --------------------------------- Home ---------------------------------- */

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const mb = bytes / (1024 * 1024);
  return mb < 1 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${mb.toFixed(1)} MB`;
}

async function buildHome() {
  const session = await window.lockdown.getSession();
  if (!session) return;

  el.homeList.textContent = '';

  for (const file of session.files) {
    const row = document.createElement('li');

    const button = document.createElement('button');
    button.className = 'home-item';
    button.type = 'button';

    const name = document.createElement('span');
    name.className = 'home-name';
    name.textContent = file.name;

    const meta = document.createElement('span');
    meta.className = 'home-meta';
    meta.textContent = `${file.kind} · ${formatSize(file.bytes)}`;

    button.append(name, meta);
    button.addEventListener('click', () => openFile(file));

    row.append(button);
    el.homeList.append(row);
  }
}

function showHome() {
  closeDocument();
  el.viewer.hidden = true;
  el.home.hidden = false;
}

function showViewer(file) {
  el.home.hidden = true;
  el.viewer.hidden = false;
  el.viewerTitle.textContent = file.name;
  el.zoomControls.hidden = file.kind !== 'PDF';
}

function setStatus(text, isWarning = false) {
  el.status.textContent = text;
  el.status.classList.toggle('is-warning', isWarning);
}

async function openFile(file) {
  showViewer(file);

  if (file.kind === 'PDF') {
    await openPdf(file);
    return;
  }

  // Video lands here next.
  setStatus('Video playback is not built yet.');
}

el.homeButton.addEventListener('click', showHome);

/* --------------------------------- PDF -----------------------------------
   Pages are laid out at their full size straight away so the scrollbar is
   honest, but only the ones near the viewport are actually drawn. A textbook
   can be a thousand pages; drawing them all would take minutes and gigabytes.
   -------------------------------------------------------------------------- */

let doc = null;              // current PDFDocumentProxy
let pageEls = [];            // one wrapper div per page
let renderTasks = new Map(); // page index -> RenderTask, so zoom can cancel them
let observer = null;
let basePageSize = null;     // { width, height } of page 1 at scale 1
let fitScale = 1;            // scale at which page 1 fills the column
let zoomIndex = DEFAULT_ZOOM_INDEX;

function currentScale() {
  return fitScale * ZOOM_STEPS[zoomIndex];
}

function closeDocument() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }

  for (const task of renderTasks.values()) task.cancel();
  renderTasks.clear();

  if (doc) {
    doc.destroy();
    doc = null;
  }

  pageEls = [];
  basePageSize = null;
  el.pdfPages.textContent = '';
  setStatus('');
}

async function openPdf(file) {
  closeDocument();
  setStatus('Opening…');

  try {
    doc = await pdfjs.getDocument({
      url: `lockdown://file/${encodeURIComponent(file.id)}`,
      // Let the protocol's range support do the work rather than pulling a
      // 200MB textbook down before showing page one.
      disableAutoFetch: true,
      disableStream: false
    }).promise;
  } catch (error) {
    setStatus(`Could not open this PDF — ${error?.message ?? 'unknown error'}`, true);
    return;
  }

  const first = await doc.getPage(1);
  const viewport = first.getViewport({ scale: 1 });
  basePageSize = { width: viewport.width, height: viewport.height };

  zoomIndex = DEFAULT_ZOOM_INDEX;
  measureFit();
  buildPages();
  setStatus(`${doc.numPages} ${doc.numPages === 1 ? 'page' : 'pages'}`);
}

// Width the column has to play with, minus the padding on .pdf-pages.
function measureFit() {
  if (!basePageSize) return;
  const available = Math.max(200, el.pdfScroll.clientWidth - 28);
  fitScale = available / basePageSize.width;
}

function buildPages() {
  el.pdfPages.textContent = '';
  pageEls = [];

  const scale = currentScale();

  for (let index = 0; index < doc.numPages; index += 1) {
    const wrapper = document.createElement('div');
    wrapper.className = 'pdf-page';
    wrapper.dataset.index = String(index);

    // Page one's proportions stand in for the rest until each is drawn, which
    // avoids opening a thousand pages just to measure them.
    wrapper.style.width = `${Math.round(basePageSize.width * scale)}px`;
    wrapper.style.height = `${Math.round(basePageSize.height * scale)}px`;

    el.pdfPages.append(wrapper);
    pageEls.push(wrapper);
  }

  observePages();
  updateZoomLabel();
}

function observePages() {
  if (observer) observer.disconnect();

  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const index = Number(entry.target.dataset.index);
      if (entry.isIntersecting) renderPage(index);
      else discardPage(index);
    }
  }, { root: el.pdfScroll, rootMargin: RENDER_MARGIN });

  for (const wrapper of pageEls) observer.observe(wrapper);
}

async function renderPage(index) {
  const wrapper = pageEls[index];
  if (!wrapper || wrapper.dataset.rendered === 'yes' || renderTasks.has(index)) return;

  const scale = currentScale();
  const ratio = window.devicePixelRatio || 1;

  let page;
  try {
    page = await doc.getPage(index + 1);
  } catch {
    return;
  }

  // The document may have been closed or zoomed while that await was pending.
  if (!doc || pageEls[index] !== wrapper || scale !== currentScale()) return;

  const viewport = page.getViewport({ scale });

  // Correct the placeholder, since pages aren't always page one's shape.
  wrapper.style.width = `${Math.round(viewport.width)}px`;
  wrapper.style.height = `${Math.round(viewport.height)}px`;

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width * ratio);
  canvas.height = Math.round(viewport.height * ratio);
  canvas.style.width = `${Math.round(viewport.width)}px`;
  canvas.style.height = `${Math.round(viewport.height)}px`;

  const task = page.render({
    canvasContext: canvas.getContext('2d', { alpha: false }),
    viewport,
    transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0]
  });

  renderTasks.set(index, task);

  try {
    await task.promise;
    wrapper.replaceChildren(canvas);
    wrapper.dataset.rendered = 'yes';
  } catch {
    // Cancelled by a zoom or a jump elsewhere in the document. Nothing to do.
  } finally {
    renderTasks.delete(index);
  }
}

// Canvases for a thousand pages would eat memory even after they scroll away,
// so pages that leave the margin give theirs back.
function discardPage(index) {
  const task = renderTasks.get(index);
  if (task) {
    task.cancel();
    renderTasks.delete(index);
  }

  const wrapper = pageEls[index];
  if (!wrapper || wrapper.dataset.rendered !== 'yes') return;

  wrapper.textContent = '';
  delete wrapper.dataset.rendered;
}

/* -------------------------------- Zoom ----------------------------------- */

function updateZoomLabel() {
  el.zoomLevel.textContent = `${Math.round(ZOOM_STEPS[zoomIndex] * 100)}%`;
  el.zoomOut.disabled = zoomIndex === 0;
  el.zoomIn.disabled = zoomIndex === ZOOM_STEPS.length - 1;
}

function setZoom(nextIndex) {
  const clamped = Math.min(ZOOM_STEPS.length - 1, Math.max(0, nextIndex));
  if (!doc || clamped === zoomIndex) return;

  // Keep the reader roughly where they were rather than jumping to the top.
  const anchor = el.pdfScroll.scrollTop / Math.max(1, el.pdfScroll.scrollHeight);

  zoomIndex = clamped;
  buildPages();

  el.pdfScroll.scrollTop = anchor * el.pdfScroll.scrollHeight;
}

el.zoomIn.addEventListener('click', () => setZoom(zoomIndex + 1));
el.zoomOut.addEventListener('click', () => setZoom(zoomIndex - 1));

window.addEventListener('resize', () => {
  if (!doc) return;
  measureFit();
  buildPages();
});

/* --------------------------- Hold to exit --------------------------------
   Timed against the clock rather than by counting frames, so a busy moment
   can't quietly shorten the hold. Any release, any loss of focus, and it
   goes back to the full thirty.
   -------------------------------------------------------------------------- */

let holdStartedAt = null;
let holdFrame = null;
let exiting = false;

function paintCounter(seconds) {
  el.counter.textContent = `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
}

function tick(now) {
  const elapsed = (now - holdStartedAt) / 1000;
  const remaining = Math.max(0, HOLD_SECONDS - elapsed);

  paintCounter(Math.ceil(remaining));

  if (remaining > 0) {
    holdFrame = requestAnimationFrame(tick);
    return;
  }

  exiting = true;
  cancelHold();
  window.lockdown.exit();
}

function startHold() {
  if (exiting || holdStartedAt !== null) return;

  holdStartedAt = performance.now();
  el.doExit.classList.add('is-holding');
  holdFrame = requestAnimationFrame(tick);
}

function cancelHold() {
  if (holdFrame !== null) cancelAnimationFrame(holdFrame);

  holdFrame = null;
  holdStartedAt = null;
  el.doExit.classList.remove('is-holding');
  paintCounter(HOLD_SECONDS);
}

el.doExit.addEventListener('pointerdown', startHold);
el.doExit.addEventListener('pointerup', cancelHold);
el.doExit.addEventListener('pointerleave', cancelHold);
el.doExit.addEventListener('pointercancel', cancelHold);

// preventDefault stops the browser firing a click on keyup, which would
// otherwise be a way out without holding anything.
el.doExit.addEventListener('keydown', (event) => {
  if (event.key !== ' ' && event.key !== 'Enter') return;
  event.preventDefault();
  startHold();
});

el.doExit.addEventListener('keyup', (event) => {
  if (event.key !== ' ' && event.key !== 'Enter') return;
  cancelHold();
});

window.addEventListener('blur', cancelHold);

/* -------------------------------- Dialog --------------------------------- */

function openDialog() {
  if (!el.dialog.hidden) return; // already asking

  cancelHold();
  el.dialog.hidden = false;
  el.goBack.focus(); // the safer of the two
}

function closeDialog() {
  cancelHold();
  el.dialog.hidden = true;
}

window.lockdown.onExitRequested(openDialog);
el.goBack.addEventListener('click', closeDialog);

/* ------------------------------ Keyboard --------------------------------- */

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !el.dialog.hidden) {
    closeDialog();
    return;
  }
  if (!el.dialog.hidden) return;

  if (event.metaKey && (event.key === '=' || event.key === '+')) {
    event.preventDefault();
    setZoom(zoomIndex + 1);
  } else if (event.metaKey && event.key === '-') {
    event.preventDefault();
    setZoom(zoomIndex - 1);
  } else if (event.metaKey && event.key === '0') {
    event.preventDefault();
    setZoom(DEFAULT_ZOOM_INDEX);
  }
});

/* --------------------------------- Boot ----------------------------------- */

paintCounter(HOLD_SECONDS);
buildHome();
