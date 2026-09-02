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
  start:       $('start'),

  confirm:       $('confirm'),
  confirmBody:   $('confirmBody'),
  confirmStart:  $('confirmStart'),
  confirmCancel: $('confirmCancel')
};

let files = [];

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

function render() {
  const hasFiles = files.length > 0;

  el.empty.hidden = hasFiles;
  el.fileList.hidden = !hasFiles;
  el.chooseMore.hidden = !hasFiles;
  el.start.disabled = !hasFiles;

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
    `You'll be locked in with ${count} ${count === 1 ? 'file' : 'files'}.`;

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
    files: files.map((f) => f.path)
  });

  closeConfirm();

  if (!response.ok) setNote(response.error, true);
});

render();
