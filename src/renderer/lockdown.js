/* ---------------------------------------------------------------------------
   DeepWork — lockdown window logic.

   Two screens: a list of what's in the session, and the reader. File contents
   arrive over lockdown://file/<id>, so nothing here ever sees a path.

   The lockdown timer is displayed here but enforced in the main process. This
   file can't let anyone out early even if it wanted to.
   ------------------------------------------------------------------------ */

import * as pdfjs from './vendor/pdf.mjs';

// Same origin as this module, so it satisfies worker-src 'self'.
pdfjs.GlobalWorkerOptions.workerSrc =
  new URL('./vendor/pdf.worker.mjs', import.meta.url).href;

const HOLD_SECONDS = 30;

const TIMER_MAX_HOURS = 8;
const TIMER_MAX_MINUTES = 59;

// 1.0 means "fits the window width", which is what you want for a textbook.
const ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 2.5, 3];
const DEFAULT_ZOOM_INDEX = 3;

// Render this far outside the viewport, measured in viewport heights.
const RENDER_MARGIN = '150% 0px';

// Matches the padding and gap on .pdf-pages, so a jump lands the page top just
// inside the viewport rather than flush against the bar.
const PAGE_GUTTER = 14;

const SKIP_SECONDS = 10;
const LONG_SKIP_SECONDS = 60; // shift + arrow, for getting across a long lecture

const $ = (id) => document.getElementById(id);

const el = {
  home:      $('home'),
  homeList:  $('homeList'),

  timerSetter:    $('timerSetter'),
  timerHours:     $('timerHours'),
  timerMinutes:   $('timerMinutes'),
  timerSet:       $('timerSet'),
  timerCountdown: $('timerCountdown'),

  viewer:      $('viewer'),
  homeButton:  $('homeButton'),
  viewerTitle: $('viewerTitle'),
  status:      $('viewerStatus'),

  pageControls: $('pageControls'),
  pageInput:    $('pageInput'),
  pageTotal:    $('pageTotal'),

  zoomControls: $('zoomControls'),
  zoomOut:      $('zoomOut'),
  zoomIn:       $('zoomIn'),
  zoomLevel:    $('zoomLevel'),

  pdfScroll: $('pdfScroll'),
  pdfPages:  $('pdfPages'),

  videoStage: $('videoStage'),
  video:      $('video'),
  seek:       $('seek'),
  playPause:  $('playPause'),
  back10:     $('back10'),
  forward10:  $('forward10'),
  time:       $('time'),
  speed:      $('speed'),

  armDialog:  $('armDialog'),
  armBody:    $('armBody'),
  armCancel:  $('armCancel'),
  armConfirm: $('armConfirm'),

  lockedDialog: $('lockedDialog'),
  lockedBack:   $('lockedBack'),

  dialog:  $('exitDialog'),
  goBack:  $('goBack'),
  doExit:  $('doExit'),
  counter: $('holdCounter')
};

// 'PDF' | 'Video' | null — decides which keyboard shortcuts are live.
let activeKind = null;

/* --------------------------------- Timer ---------------------------------
   Optional. Setting one removes every exit, including Cmd+Q, until it runs
   out. The main process is what actually refuses; this just draws it.
   -------------------------------------------------------------------------- */

let lockUntil = null;
let timerTicker = null;

function timerRemainingMs() {
  return lockUntil === null ? 0 : Math.max(0, lockUntil - Date.now());
}

function timerRunning() {
  return timerRemainingMs() > 0;
}

// Hours and minutes only, and rounded up so it never reads 0m while still
// holding you. Seconds would just be something else to watch.
function formatRemaining(ms) {
  const totalMinutes = Math.ceil(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function paintTimer() {
  const running = timerRunning();

  el.timerSetter.hidden = running;
  el.timerCountdown.hidden = !running;

  if (running) el.timerCountdown.textContent = formatRemaining(timerRemainingMs());
}

function startTimerTicker() {
  stopTimerTicker();

  timerTicker = setInterval(() => {
    paintTimer();
    if (!timerRunning()) stopTimerTicker();
  }, 1000);
}

function stopTimerTicker() {
  if (timerTicker !== null) clearInterval(timerTicker);
  timerTicker = null;
}

/* The two fields. Digits only, clamped as typed. Eight hours is the ceiling,
   so at 8 the minutes field is pinned to zero. */

function readField(input, max) {
  const digits = input.value.replace(/\D/g, '');
  return digits === '' ? 0 : Math.min(max, Number(digits));
}

function timerHoursValue() {
  return readField(el.timerHours, TIMER_MAX_HOURS);
}

function timerMinutesValue() {
  const ceiling = timerHoursValue() >= TIMER_MAX_HOURS ? 0 : TIMER_MAX_MINUTES;
  return readField(el.timerMinutes, ceiling);
}

function timerTotalMinutes() {
  return timerHoursValue() * 60 + timerMinutesValue();
}

function normaliseTimerFields() {
  el.timerHours.value = String(timerHoursValue());
  el.timerMinutes.value = String(timerMinutesValue());
  el.timerSet.disabled = timerTotalMinutes() === 0;
}

for (const input of [el.timerHours, el.timerMinutes]) {
  input.addEventListener('focus', () => input.select());

  input.addEventListener('input', () => {
    const max = input === el.timerHours
      ? TIMER_MAX_HOURS
      : (timerHoursValue() >= TIMER_MAX_HOURS ? 0 : TIMER_MAX_MINUTES);

    const digits = input.value.replace(/\D/g, '').slice(0, input === el.timerHours ? 1 : 2);
    const next = digits === '' ? '' : String(Math.min(max, Number(digits)));

    if (next !== input.value) input.value = next;

    // Clamping hours to 8 has to drag minutes down with it.
    if (input === el.timerHours && timerHoursValue() >= TIMER_MAX_HOURS) {
      el.timerMinutes.value = '0';
    }

    el.timerSet.disabled = timerTotalMinutes() === 0;
  });

  input.addEventListener('blur', normaliseTimerFields);

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      input.blur();
      if (!el.timerSet.disabled) openArmDialog();
    }
  });
}

function openArmDialog() {
  if (timerRunning() || timerTotalMinutes() === 0) return;

  el.armDialog.hidden = false;
  el.armCancel.focus(); // this one can't be undone, so the safe button leads
}

function closeArmDialog() {
  el.armDialog.hidden = true;
}

el.timerSet.addEventListener('click', openArmDialog);
el.armCancel.addEventListener('click', closeArmDialog);

el.armConfirm.addEventListener('click', async () => {
  const minutes = timerTotalMinutes();
  closeArmDialog();

  const result = await window.lockdown.armTimer(minutes);
  if (!result?.ok) {
    console.error('[DeepWork] arming failed:', result?.error);
    return;
  }

  lockUntil = result.lockUntil;
  paintTimer();
  startTimerTicker();
});

async function loadTimer() {
  const state = await window.lockdown.getTimer();
  lockUntil = state?.lockUntil ?? null;

  paintTimer();
  if (timerRunning()) startTimerTicker();
}

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

function closeActive() {
  closeVideo();

  try {
    closeDocument();
  } catch (error) {
    console.error('[DeepWork] closing the document failed', error);
  }

  activeKind = null;
}

// Swap the screens first. If tearing something down goes wrong, the reader
// still gets their list back rather than being stuck staring at a dead page.
function showHome() {
  el.viewer.hidden = true;
  el.home.hidden = false;
  closeActive();
  paintTimer();
}

function showViewer(file) {
  const isPdf = file.kind === 'PDF';

  el.home.hidden = true;
  el.viewer.hidden = false;
  el.viewerTitle.textContent = file.name;

  el.pdfScroll.hidden = !isPdf;
  el.zoomControls.hidden = !isPdf;
  el.pageControls.hidden = !isPdf;
  el.videoStage.hidden = isPdf;
}

function setStatus(text, isWarning = false) {
  el.status.textContent = text;
  el.status.classList.toggle('is-warning', isWarning);
}

async function openFile(file) {
  closeActive();
  showViewer(file);
  activeKind = file.kind;

  if (file.kind === 'PDF') await openPdf(file);
  else openVideo(file);
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
let renderObserver = null;   // decides what gets drawn
let pageObserver = null;     // decides what the page field says
let visiblePages = new Set();
let basePageSize = null;     // { width, height } of page 1 at scale 1
let fitScale = 1;            // scale at which page 1 fills the column
let zoomIndex = DEFAULT_ZOOM_INDEX;

// Bumped on every close, so an open that's still in flight can tell it's stale
// and stop rather than painting over whatever the reader moved on to.
let openToken = 0;

function currentScale() {
  return fitScale * ZOOM_STEPS[zoomIndex];
}

function closeDocument() {
  openToken += 1;

  for (const observer of [renderObserver, pageObserver]) {
    try {
      observer?.disconnect();
    } catch { /* already gone */ }
  }
  renderObserver = null;
  pageObserver = null;

  for (const task of renderTasks.values()) {
    try {
      task.cancel();
    } catch { /* already finished */ }
  }
  renderTasks.clear();
  visiblePages.clear();

  if (doc) {
    const closing = doc;
    doc = null;
    // Detached so a rejection here can't take the caller down with it.
    Promise.resolve().then(() => closing.destroy()).catch(() => {});
  }

  pageEls = [];
  basePageSize = null;
  el.pdfPages.textContent = '';
  el.pageTotal.textContent = '';
  el.pageInput.value = '1';
  setStatus('');
}

async function openPdf(file) {
  closeDocument();
  const token = openToken;

  setStatus('Opening…');

  let opened;
  try {
    opened = await pdfjs.getDocument({
      url: `lockdown://file/${encodeURIComponent(file.id)}`,
      // Let the protocol's range support do the work rather than pulling a
      // 200MB textbook down before showing page one.
      disableAutoFetch: true,
      disableStream: false
    }).promise;
  } catch (error) {
    if (token !== openToken) return;
    setStatus(`Could not open this PDF — ${error?.message ?? 'unknown error'}`, true);
    return;
  }

  // The reader may have hit Home while that was loading.
  if (token !== openToken) {
    opened.destroy().catch(() => {});
    return;
  }

  doc = opened;

  const first = await doc.getPage(1);
  if (token !== openToken) return;

  const viewport = first.getViewport({ scale: 1 });
  basePageSize = { width: viewport.width, height: viewport.height };

  zoomIndex = DEFAULT_ZOOM_INDEX;
  measureFit();
  buildPages();

  el.pageTotal.textContent = `/ ${doc.numPages}`;
  el.pageInput.value = '1';
  setStatus(`${doc.numPages} ${doc.numPages === 1 ? 'page' : 'pages'}`);
}

// Width the column has to play with, minus the padding on .pdf-pages.
function measureFit() {
  if (!basePageSize) return;
  const available = Math.max(200, el.pdfScroll.clientWidth - PAGE_GUTTER * 2);
  fitScale = available / basePageSize.width;
}

function buildPages() {
  el.pdfPages.textContent = '';
  pageEls = [];
  visiblePages.clear();

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
  renderObserver?.disconnect();
  pageObserver?.disconnect();

  renderObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const index = Number(entry.target.dataset.index);
      if (entry.isIntersecting) renderPage(index);
      else discardPage(index);
    }
  }, { root: el.pdfScroll, rootMargin: RENDER_MARGIN });

  // A second, tight observer just for "which page am I on". Reusing the render
  // one would report pages far off screen, since its margin is deliberately huge.
  pageObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const index = Number(entry.target.dataset.index);
      if (entry.isIntersecting) visiblePages.add(index);
      else visiblePages.delete(index);
    }
    paintPageNumber();
  }, { root: el.pdfScroll, rootMargin: '0px' });

  for (const wrapper of pageEls) {
    renderObserver.observe(wrapper);
    pageObserver.observe(wrapper);
  }
}

async function renderPage(index) {
  const wrapper = pageEls[index];
  if (!doc || !wrapper || wrapper.dataset.rendered === 'yes' || renderTasks.has(index)) return;

  const token = openToken;
  const scale = currentScale();
  const ratio = window.devicePixelRatio || 1;

  let page;
  try {
    page = await doc.getPage(index + 1);
  } catch {
    return;
  }

  // The document may have been closed or zoomed while that await was pending.
  if (token !== openToken || !doc || pageEls[index] !== wrapper || scale !== currentScale()) return;

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
    if (token !== openToken) return;
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
    try {
      task.cancel();
    } catch { /* already finished */ }
    renderTasks.delete(index);
  }

  const wrapper = pageEls[index];
  if (!wrapper || wrapper.dataset.rendered !== 'yes') return;

  wrapper.textContent = '';
  delete wrapper.dataset.rendered;
}

/* ------------------------------ Page field -------------------------------
   "Which page am I on" is the one filling most of the viewport, not whichever
   one still touches its top edge. Landing on a page leaves the previous one's
   bottom edge sitting exactly on the boundary, and sub-pixel rounding is
   enough for it to still count as visible.
   -------------------------------------------------------------------------- */

function currentPageNumber() {
  if (visiblePages.size === 0) return null;

  const view = el.pdfScroll.getBoundingClientRect();

  let best = null;
  let bestVisible = -Infinity;

  // Sorted so an exact tie settles on the earlier page rather than at random.
  for (const index of [...visiblePages].sort((a, b) => a - b)) {
    const wrapper = pageEls[index];
    if (!wrapper) continue;

    const rect = wrapper.getBoundingClientRect();
    const visible = Math.min(rect.bottom, view.bottom) - Math.max(rect.top, view.top);

    if (visible > bestVisible) {
      bestVisible = visible;
      best = index;
    }
  }

  return best === null ? null : best + 1;
}

function paintPageNumber() {
  // Don't fight someone mid-type.
  if (document.activeElement === el.pageInput) return;

  const page = currentPageNumber();
  if (page === null) return;

  el.pageInput.value = String(page);
}

function goToPage(number) {
  if (!doc) return false;

  const target = Math.min(doc.numPages, Math.max(1, number));
  const wrapper = pageEls[target - 1];
  if (!wrapper) return false;

  // Measured rather than accumulated, so it stays right even though pages
  // resize themselves as they render.
  const containerTop = el.pdfScroll.getBoundingClientRect().top;
  const targetTop = wrapper.getBoundingClientRect().top;
  el.pdfScroll.scrollTop += targetTop - containerTop - PAGE_GUTTER;

  el.pageInput.value = String(target);
  return true;
}

el.pageInput.addEventListener('focus', () => el.pageInput.select());

el.pageInput.addEventListener('input', () => {
  const digits = el.pageInput.value.replace(/\D/g, '').slice(0, 5);
  if (digits !== el.pageInput.value) el.pageInput.value = digits;
});

el.pageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    const wanted = Number(el.pageInput.value);
    if (Number.isFinite(wanted) && wanted > 0) goToPage(wanted);
    el.pageInput.blur();
    el.pdfScroll.focus(); // hand the arrow keys back to the document
    return;
  }

  if (event.key === 'Escape') {
    event.preventDefault();
    el.pageInput.blur();
  }
});

// Leaving without committing puts the real page number back.
el.pageInput.addEventListener('blur', () => {
  const page = currentPageNumber();
  el.pageInput.value = String(page ?? (Number(el.pageInput.value) || 1));
});

/* -------------------------------- Zoom ----------------------------------- */

function updateZoomLabel() {
  el.zoomLevel.textContent = `${Math.round(ZOOM_STEPS[zoomIndex] * 100)}%`;
  el.zoomOut.disabled = zoomIndex === 0;
  el.zoomIn.disabled = zoomIndex === ZOOM_STEPS.length - 1;
}

function setZoom(nextIndex) {
  const clamped = Math.min(ZOOM_STEPS.length - 1, Math.max(0, nextIndex));
  if (!doc || clamped === zoomIndex) return;

  // Rebuild at the new scale, then put the reader back on the page they were on.
  const anchor = currentPageNumber() ?? 1;

  zoomIndex = clamped;
  buildPages();
  goToPage(anchor);
}

el.zoomIn.addEventListener('click', () => setZoom(zoomIndex + 1));
el.zoomOut.addEventListener('click', () => setZoom(zoomIndex - 1));

window.addEventListener('resize', () => {
  if (!doc) return;

  const anchor = currentPageNumber() ?? 1;
  measureFit();
  buildPages();
  goToPage(anchor);
});

/* -------------------------------- Video ----------------------------------
   The file is streamed from lockdown://, which answers Range requests, so
   seeking in a two hour recording doesn't mean downloading it first.
   -------------------------------------------------------------------------- */

let scrubbing = false;

function formatTime(seconds) {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;

  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n) => String(n).padStart(2, '0');

  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(secs)}`
    : `${minutes}:${pad(secs)}`;
}

function paintProgress() {
  const duration = el.video.duration;
  const fraction = Number.isFinite(duration) && duration > 0
    ? el.video.currentTime / duration
    : 0;

  el.seek.style.setProperty('--progress', `${fraction * 100}%`);
  el.time.textContent = `${formatTime(el.video.currentTime)} / ${formatTime(duration)}`;
}

function setPlayLabel() {
  el.playPause.textContent = el.video.paused ? 'Play' : 'Pause';
}

function openVideo(file) {
  el.video.src = `lockdown://file/${encodeURIComponent(file.id)}`;
  el.video.playbackRate = Number(el.speed.value); // carried over between files
  el.video.load();

  el.seek.value = '0';
  el.seek.max = '0';
  paintProgress();
  setPlayLabel();
  setStatus('');
}

function closeVideo() {
  scrubbing = false;

  try {
    el.video.pause();
    // Dropping the attribute and reloading is what actually releases the
    // stream; leaving the src set keeps the file open behind the scenes.
    el.video.removeAttribute('src');
    el.video.load();
  } catch { /* nothing worth reporting */ }

  el.seek.value = '0';
  el.seek.max = '0';
  el.seek.style.setProperty('--progress', '0%');
  el.time.textContent = '0:00 / 0:00';
  setPlayLabel();
}

function togglePlay() {
  if (el.video.paused) el.video.play().catch(() => {});
  else el.video.pause();
}

function nudge(delta) {
  const duration = el.video.duration;
  if (!Number.isFinite(duration)) return;

  el.video.currentTime = Math.min(duration, Math.max(0, el.video.currentTime + delta));
}

el.playPause.addEventListener('click', togglePlay);
el.back10.addEventListener('click', () => nudge(-SKIP_SECONDS));
el.forward10.addEventListener('click', () => nudge(SKIP_SECONDS));

el.speed.addEventListener('change', () => {
  el.video.playbackRate = Number(el.speed.value);
});

el.video.addEventListener('loadedmetadata', () => {
  el.seek.max = String(Number.isFinite(el.video.duration) ? el.video.duration : 0);
  paintProgress();
});

el.video.addEventListener('durationchange', () => {
  el.seek.max = String(Number.isFinite(el.video.duration) ? el.video.duration : 0);
});

el.video.addEventListener('timeupdate', () => {
  if (scrubbing) return; // don't yank the handle out from under a drag
  el.seek.value = String(el.video.currentTime);
  paintProgress();
});

el.video.addEventListener('play', setPlayLabel);
el.video.addEventListener('pause', setPlayLabel);
el.video.addEventListener('ended', setPlayLabel);

el.video.addEventListener('error', () => {
  // Clearing the source to release the file fires this too; ignore that one.
  if (!el.video.getAttribute('src')) return;

  const reasons = {
    1: 'Loading was interrupted.',
    2: 'The file could not be read.',
    3: 'This video could not be decoded.',
    4: 'This video format is not supported.'
  };

  setStatus(reasons[el.video.error?.code] ?? 'This video could not be played.', true);
});

el.seek.addEventListener('pointerdown', () => { scrubbing = true; });
el.seek.addEventListener('pointerup', () => { scrubbing = false; });
el.seek.addEventListener('pointercancel', () => { scrubbing = false; });

el.seek.addEventListener('input', () => {
  const target = Number(el.seek.value);
  if (!Number.isFinite(target)) return;

  el.video.currentTime = target;
  paintProgress();
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

  // Main has the last word. If a timer is still running it says no, and the
  // hold simply becomes available again.
  window.lockdown.exit().then((result) => {
    if (result && result.ok === false) exiting = false;
  });
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

/* -------------------------------- Dialogs -------------------------------- */

function anyDialogOpen() {
  return !el.dialog.hidden || !el.armDialog.hidden || !el.lockedDialog.hidden;
}

// Cmd+Q. Main tells us whether the timer is currently refusing.
function onExitRequested(payload) {
  if (payload?.locked) {
    if (el.lockedDialog.hidden) {
      el.lockedDialog.hidden = false;
      el.lockedBack.focus();
    }
    return;
  }

  if (!el.dialog.hidden) return; // already asking

  cancelHold();
  el.dialog.hidden = false;
  el.goBack.focus(); // the safer of the two
}

function closeDialog() {
  cancelHold();
  el.dialog.hidden = true;
}

function closeAllDialogs() {
  closeDialog();
  closeArmDialog();
  el.lockedDialog.hidden = true;
}

window.lockdown.onExitRequested(onExitRequested);
el.goBack.addEventListener('click', closeDialog);
el.lockedBack.addEventListener('click', () => { el.lockedDialog.hidden = true; });

/* ------------------------------ Keyboard --------------------------------- */

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && anyDialogOpen()) {
    closeAllDialogs();
    return;
  }

  if (anyDialogOpen()) return;                    // a dialog is up; leave it alone
  if (event.target === el.pageInput) return;      // typing a page number
  if (event.target === el.timerHours) return;     // typing a lockdown length
  if (event.target === el.timerMinutes) return;
  if (event.target === el.speed) return;          // arrow keys belong to the menu

  if (activeKind === 'Video') {
    if (event.key === ' ') {
      // Also stops a focused button being clicked by the same keystroke.
      event.preventDefault();
      togglePlay();
      return;
    }

    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const step = event.shiftKey ? LONG_SKIP_SECONDS : SKIP_SECONDS;
      nudge(event.key === 'ArrowLeft' ? -step : step);
      return;
    }
  }

  if (activeKind === 'PDF') {
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
  }
});

/* --------------------------------- Boot ----------------------------------- */

paintCounter(HOLD_SECONDS);
normaliseTimerFields();
loadTimer();
buildHome();
