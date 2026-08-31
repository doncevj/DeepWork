/* ---------------------------------------------------------------------------
   DeepWork — window logic.
   No Node here. Everything that touches the disk goes through window.deepwork.
   ------------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);

const el = {
  dropzone:    $('dropzone'),
  empty:       $('empty'),
  fileList:    $('fileList'),
  fileNote:    $('fileNote'),
  chooseEmpty: $('chooseEmpty'),
  chooseMore:  $('chooseMore'),
  hours:       $('hours'),
  minutes:     $('minutes'),
  start:       $('start'),

  confirm:       $('confirm'),
  confirmBody:   $('confirmBody'),
  confirmStart:  $('confirmStart'),
  confirmCancel: $('confirmCancel')
};

const HOUR_MAX = 12;
const MINUTE_MAX = 59;

let files = [];

/* ------------------------------ Duration --------------------------------
   Digits only, clamped as you type so the field can never show a length the
   app would refuse. Empty reads as zero while typing and normalises on blur.
   ---------------------------------------------------------------------- */

function bindDurationField(input, max, { advanceTo = null } = {}) {
  function read() {
    const digits = input.value.replace(/\D/g, '');
    return digits === '' ? 0 : Math.min(max, Number(digits));
  }

  input.addEventListener('input', () => {
    const digits = input.value.replace(/\D/g, '').slice(0, 2);
    const next = digits === '' ? '' : String(Math.min(max, Number(digits)));

    if (next !== input.value) input.value = next;
    refreshStart();

    // Two digits is as far as either field goes, so move on rather than
    // silently swallowing the next keystroke.
    if (advanceTo && digits.length === 2) advanceTo.focus();
  });

  // Click in and type — the old value is replaced instead of appended to.
  input.addEventListener('focus', () => input.select());

  input.addEventListener('blur', () => {
    input.value = String(read());
    refreshStart();
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      input.blur();
      return;
    }

    const step = { ArrowUp: 1, ArrowDown: -1 }[event.key];
    if (step === undefined) return;

    event.preventDefault();
    input.value = String(Math.min(max, Math.max(0, read() + step)));
    refreshStart();
  });

  return { get value() { return read(); } };
}

const hours = bindDurationField(el.hours, HOUR_MAX, { advanceTo: el.minutes });
const minutes = bindDurationField(el.minutes, MINUTE_MAX);

function totalMinutes() {
  return hours.value * 60 + minutes.value;
}

function formatDuration(total) {
  const h = Math.floor(total / 60);
  const m = total % 60;

  const hourText = h > 0 ? `${h} ${h === 1 ? 'hour' : 'hours'}` : '';
  const minuteText = m > 0 ? `${m} ${m === 1 ? 'minute' : 'minutes'}` : '';

  return [hourText, minuteText].filter(Boolean).join(' ');
}

/* -------------------------------- Files ---------------------------------- */

function addFiles(result) {
  const known = new Set(files.map((f) => f.path));
  const fresh = result.accepted.filter((f) => !known.has(f.path));

  files = files.concat(fresh);
  render();

  if (result.rejected > 0) {
    const n = result.rejected;
    setNote(`${n} ${n === 1 ? 'file was' : 'files were'} skipped — DeepWork opens PDFs and MP4s.`, true);
  } else if (fresh.length === 0 && result.accepted.length > 0) {
    setNote('Already added.');
  } else {
    setNote('');
  }
}

function removeFile(filePath) {
  files = files.filter((f) => f.path !== filePath);
  setNote('');
  render();
}

function setNote(text, isWarning = false) {
  el.fileNote.textContent = text;
  el.fileNote.classList.toggle('is-warning', isWarning);
}

// Start needs both a file and a length. Zero and zero is the resting state of
// the fields, so it can't count as a choice.
function refreshStart() {
  el.start.disabled = files.length === 0 || totalMinutes() === 0;
}

function render() {
  const hasFiles = files.length > 0;

  el.empty.hidden = hasFiles;
  el.fileList.hidden = !hasFiles;
  el.chooseMore.hidden = !hasFiles;

  el.fileList.textContent = '';

  for (const file of files) {
    const row = document.createElement('li');
    row.className = 'file-row';

    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = file.name;
    name.title = file.path;

    const kind = document.createElement('span');
    kind.className = 'file-kind';
    kind.textContent = file.kind;

    const remove = document.createElement('button');
    remove.className = 'file-remove';
    remove.type = 'button';
    remove.textContent = '\u00d7';
    remove.setAttribute('aria-label', `Remove ${file.name}`);
    remove.addEventListener('click', () => removeFile(file.path));

    row.append(name, kind, remove);
    el.fileList.append(row);
  }

  refreshStart();
}

async function chooseFiles() {
  const result = await window.deepwork.chooseFiles();
  addFiles(result);
}

el.chooseEmpty.addEventListener('click', chooseFiles);
el.chooseMore.addEventListener('click', chooseFiles);

el.dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    chooseFiles();
  }
});

/* ---------------------------- Drag and drop ------------------------------
   Electron will happily navigate the window to a dropped file unless every
   drop on the document is cancelled, so start by cancelling all of them.
   ---------------------------------------------------------------------- */

for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) {
  document.addEventListener(type, (event) => event.preventDefault());
}

el.dropzone.addEventListener('dragover', () => {
  el.dropzone.classList.add('is-hovered');
});

el.dropzone.addEventListener('dragleave', () => {
  el.dropzone.classList.remove('is-hovered');
});

el.dropzone.addEventListener('drop', async (event) => {
  el.dropzone.classList.remove('is-hovered');

  const dropped = event.dataTransfer?.files;
  if (!dropped || dropped.length === 0) return;

  const result = await window.deepwork.resolveDroppedFiles(dropped);
  addFiles(result);
});

/* ------------------------------- Confirm --------------------------------- */

function openConfirm() {
  const count = files.length;
  el.confirmBody.textContent =
    `You'll be locked in with ${count} ${count === 1 ? 'file' : 'files'} ` +
    `for ${formatDuration(totalMinutes())}.`;

  el.confirm.hidden = false;
  el.confirmStart.focus();
}

function closeConfirm() {
  el.confirm.hidden = true;
  el.start.focus();
}

el.start.addEventListener('click', openConfirm);
el.confirmCancel.addEventListener('click', closeConfirm);

el.confirm.addEventListener('click', (event) => {
  if (event.target === el.confirm) closeConfirm(); // click the scrim to dismiss
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !el.confirm.hidden) closeConfirm();
});

el.confirmStart.addEventListener('click', async () => {
  const response = await window.deepwork.startSession({
    files: files.map((f) => f.path),
    minutes: totalMinutes()
  });

  closeConfirm();

  if (!response.ok) {
    setNote(response.error, true);
    return;
  }

  // Deliberately nothing yet. Lockdown and the file viewer hook in here.
});

render();
