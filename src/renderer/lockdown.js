/* ---------------------------------------------------------------------------
   DeepWork — lockdown window logic.
   Skeleton: shows what's in the session and runs the hold-to-exit.
   The PDF and video viewer will live here.
   ------------------------------------------------------------------------ */

const HOLD_SECONDS = 30;

const el = {
  files:   document.getElementById('stageFiles'),
  dialog:  document.getElementById('exitDialog'),
  goBack:  document.getElementById('goBack'),
  doExit:  document.getElementById('doExit'),
  counter: document.getElementById('holdCounter')
};

async function showSession() {
  const session = await window.lockdown.getSession();
  if (!session) return;

  el.files.textContent = session.files.map((file) => file.name).join('   ·   ');
}

/* --------------------------- Hold to exit -------------------------------
   Timed against the clock rather than by counting frames, so a busy moment
   can't quietly shorten the hold. Any release, any loss of focus, and it
   goes back to the full thirty.
   ---------------------------------------------------------------------- */

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

  // Held the whole way. Stop first so a slow teardown can't restart the timer.
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

// Pointer.
el.doExit.addEventListener('pointerdown', startHold);
el.doExit.addEventListener('pointerup', cancelHold);
el.doExit.addEventListener('pointerleave', cancelHold);
el.doExit.addEventListener('pointercancel', cancelHold);

// Keyboard. preventDefault stops the browser firing a click on keyup, which
// would otherwise be a way out without holding anything.
el.doExit.addEventListener('keydown', (event) => {
  if (event.key !== ' ' && event.key !== 'Enter') return;
  event.preventDefault();
  startHold();
});

el.doExit.addEventListener('keyup', (event) => {
  if (event.key !== ' ' && event.key !== 'Enter') return;
  cancelHold();
});

// Dragging the pointer off, switching away, anything at all: reset.
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

// Cmd+Q is intercepted in the main process and arrives here as a question.
window.lockdown.onExitRequested(openDialog);

el.goBack.addEventListener('click', closeDialog);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !el.dialog.hidden) closeDialog();
});

paintCounter(HOLD_SECONDS);
showSession();
