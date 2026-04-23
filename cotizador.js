// ═══════════════════════════════════════════════════════════════════
// COTIZADOR — cotizador.js
// Upload a R2 via Worker · Pricing · WhatsApp
// ═══════════════════════════════════════════════════════════════════

const WORKER_URL = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? 'http://localhost:8787'
  : 'https://cotizador-worker.1328copias.workers.dev';

const WA_NUMBER      = '5491126343647';
const TRANSFER_ALIAS = 'JOS.BARRIGA';        // Alias transferencia
const TRANSFER_NOMBRE = 'José María Barriga'; // Titular
const MAX_FILE_MB    = 100;
const MAX_FILE_SIZE = MAX_FILE_MB * 1024 * 1024;

// ── Precios — cargados desde cotizador-precios.json ────────────────
let PRECIOS = {};
let ANILLADO_TIERS = [];
let pricesLoaded = false;

function enableUploadUI() {
  pricesLoaded = true;
  const btn  = document.getElementById('cotBrowse');
  const drop = document.getElementById('cotDrop');
  if (btn)  { btn.disabled = false; btn.textContent = 'Seleccionar archivos'; }
  if (drop) drop.classList.remove('cot-drop--loading');
}

fetch('cotizador-precios.json')
  .then(r => r.json())
  .then(data => { PRECIOS = data.papel; ANILLADO_TIERS = data.anillado; enableUploadUI(); })
  .catch(() => { console.warn('No se pudo cargar cotizador-precios.json'); enableUploadUI(); });

function precioAnillado(hojas) {
  for (const tier of ANILLADO_TIERS) {
    if (hojas <= tier.hasta) return tier.precio;
  }
  return ANILLADO_TIERS.at(-1)?.precio ?? 5200;
}

const SESSION_ID = crypto.randomUUID();

// Estado de archivos: Map<fileId, FileState>
const files = new Map();
let fileCounter = 0;

// ── DOM refs ──────────────────────────────────────────────────────
const stepUpload  = document.getElementById('step-upload');
const stepFiles   = document.getElementById('step-files');
const stepSuccess = document.getElementById('step-success');
const cotDrop     = document.getElementById('cotDrop');
const cotBrowse   = document.getElementById('cotBrowse');
const cotFileInput      = document.getElementById('cotFileInput');
const cotFileInputMore  = document.getElementById('cotFileInputMore');
const cotAddMore        = document.getElementById('cotAddMore');
const cotFileList       = document.getElementById('cotFileList');
const cotSummaryRows    = document.getElementById('cotSummaryRows');
const cotTotal          = document.getElementById('cotTotal');
const cotNombre         = document.getElementById('cotNombre');
const cotTel            = document.getElementById('cotTel');
const cotNota           = document.getElementById('cotNota');
const cotSubmit         = document.getElementById('cotSubmit');
const cotSubmitLabel    = document.getElementById('cotSubmitLabel');
const cotSpinner        = document.getElementById('cotSpinner');
const cotSubmitNote     = document.getElementById('cotSubmitNote');
const cotOrderId        = document.getElementById('cotOrderId');
const cotWaBtn          = document.getElementById('cotWaBtn');
const cotNewOrder       = document.getElementById('cotNewOrder');
let   waReturnListener  = null;
const cotUrgente        = document.getElementById('cotUrgente');
const cotPagoInfo       = document.getElementById('cotPagoInfo');

// ── Selector de medio de pago ─────────────────────────────────────
document.querySelectorAll('input[name="pago"]').forEach(radio => {
  radio.addEventListener('change', () => {
    const val = radio.value;
    cotPagoInfo.style.display = '';
    if (val === 'efectivo' || val === 'tarjeta') {
      cotPagoInfo.className = 'cot-pago-info cot-pago-retiro';
      cotPagoInfo.innerHTML = '<span>Se abona al retirar</span>';
    } else {
      cotPagoInfo.className = 'cot-pago-info cot-pago-transferencia';
      cotPagoInfo.innerHTML =
        `<span>Alias: <strong>${TRANSFER_ALIAS}</strong></span>` +
        `<span>A nombre de: ${TRANSFER_NOMBRE}</span>`;
    }
  });
});
const tplRow            = document.getElementById('tpl-file-row');

// ── Process file: thumbnail + page count (single PDF read) ──────
async function processFile(file, row) {
  const canvas      = row.querySelector('.cot-thumb-canvas');
  const img         = row.querySelector('.cot-thumb-img');
  const placeholder = row.querySelector('.cot-thumb-placeholder');
  const isPdf  = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  const isImage = file.type.startsWith('image/');

  if (isImage) {
    const url = URL.createObjectURL(file);
    img.onload = () => URL.revokeObjectURL(url);
    img.src = url;
    img.style.display = '';
    placeholder.style.display = 'none';
    return null; // sin conteo de páginas
  }

  if (isPdf) {
    try {
      const lib = window['pdfjs-dist/build/pdf'];
      if (!lib) return null;
      lib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      const ab  = await file.arrayBuffer();
      const pdf = await lib.getDocument({ data: ab }).promise;
      // Thumbnail: renderiza página 1
      const page     = await pdf.getPage(1);
      const scale    = 1.2;
      const viewport = page.getViewport({ scale });
      canvas.width  = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      canvas.style.display = '';
      placeholder.style.display = 'none';
      return pdf.numPages; // devuelve conteo
    } catch { return null; }
  }

  return null; // otro tipo de archivo
}

// ── Helpers ───────────────────────────────────────────────────────
function fmt(n) {
  return '$' + Math.round(n).toLocaleString('es-AR');
}

function genId() {
  return 'COT-' + Date.now().toString(36).toUpperCase().slice(-5) +
         Math.random().toString(36).slice(2, 4).toUpperCase();
}

function calcSubtotal(opts) {
  const pHoja = PRECIOS?.[opts.papel]?.[opts.tinta]?.[opts.faz] ?? 0;
  let sub = pHoja * opts.hojas * opts.copias;
  if (opts.anillado === 'si') {
    sub += precioAnillado(opts.hojas) * opts.copias;
  }
  return sub;
}

function getOpts(row) {
  // name^= porque los radios tienen sufijo de id (ej: "papel-1")
  const r = (base) => row.querySelector(`input[name^="${base}"]:checked`)?.value;
  const n = (base) => Math.max(1, parseInt(row.querySelector(`input[name^="${base}"]`)?.value) || 1);
  return {
    papel:    r('papel')    || 'obra75',
    tinta:    r('tinta')    || 'mono',
    faz:      r('faz')      || 'simple',
    anillado: r('anillado') || 'no',
    hojas:    row.dataset.autoHojas ? parseInt(row.dataset.autoHojas) : n('hojas'),
    copias:   n('copias'),
  };
}

function optsLabel(opts) {
  const papelMap = { obra75: 'Obra 75g', autoadhesivo: 'Autoadhesivo', kraft225: 'Kraft 225g' };
  const papel = papelMap[opts.papel] || opts.papel;
  const tinta = opts.tinta === 'mono'   ? 'Mono'     : 'Color';
  const faz   = opts.faz   === 'simple' ? 'Simple'   : 'Doble faz';
  const anill = opts.anillado === 'si'  ? ' · Anillado' : '';
  return `${opts.hojas} hj. · ${opts.copias} cop. · ${tinta} · ${faz} · ${papel}${anill}`;
}

// ── Render / update ───────────────────────────────────────────────
function updateSummary() {
  let subtotal = 0;
  cotSummaryRows.innerHTML = '';

  files.forEach((state) => {
    const opts = state.opts;
    const sub  = calcSubtotal(opts);
    subtotal += sub;

    const row = document.createElement('div');
    row.className = 'cot-summary-row';
    row.innerHTML = `
      <span class="cot-summary-row-name">${state.name}</span>
      <span class="cot-summary-row-detail">${optsLabel(opts)}</span>
      <span class="cot-summary-row-amount">${fmt(sub)}</span>
    `;
    cotSummaryRows.appendChild(row);
  });

  const urgente = cotUrgente?.checked;
  if (urgente && subtotal > 0) {
    const recargo = subtotal * 0.3;
    const surRow  = document.createElement('div');
    surRow.className = 'cot-summary-row cot-summary-row-urgente';
    surRow.innerHTML = `
      <span class="cot-summary-row-name">Recargo urgente</span>
      <span class="cot-summary-row-detail">+30%</span>
      <span class="cot-summary-row-amount">${fmt(recargo)}</span>
    `;
    cotSummaryRows.appendChild(surRow);
    cotTotal.textContent = fmt(subtotal + recargo);
  } else {
    cotTotal.textContent = fmt(subtotal);
  }
  cotTotal.classList.remove('total-pulse');
  void cotTotal.offsetWidth;
  cotTotal.classList.add('total-pulse');
}

function setBadge(row, type, text) {
  const badge = row.querySelector('.cot-file-badge');
  badge.className = 'cot-file-badge badge-' + type;
  badge.textContent = text;
}

function addFileRow(file) {
  const id = ++fileCounter;
  const node = tplRow.content.cloneNode(true);
  const row  = node.querySelector('.cot-file-row');

  row.dataset.fileid = id;
  row.querySelector('.cot-file-name').textContent = file.name;
  setBadge(row, 'pending', 'Pendiente');

  // Dar nombres únicos a los radios de esta fila
  row.querySelectorAll('input[type="radio"]').forEach(inp => {
    inp.name = inp.name + '-' + id;
  });
  row.querySelectorAll('input[type="number"]').forEach(inp => {
    inp.name = inp.name + '-' + id;
  });

  // Estado inicial
  const state = { id, name: file.name, file, opts: getOpts(row), uploadUrl: null };
  files.set(id, state);

  // Restricciones y hojas automáticas
  const enforceConstraints = () => {
    const papel     = row.querySelector('input[name^="papel"]:checked')?.value;
    const fazDoble  = row.querySelector('input[name^="faz"][value="doble"]');
    const fazSimple = row.querySelector('input[name^="faz"][value="simple"]');
    const pillDoble = fazDoble?.closest('.cot-pill');

    // autoadhesivo → solo simple faz
    if (papel === 'autoadhesivo') {
      fazDoble.disabled = true;
      pillDoble?.classList.add('pill-disabled');
      if (fazDoble.checked) { fazDoble.checked = false; fazSimple.checked = true; }
    } else {
      fazDoble.disabled = false;
      pillDoble?.classList.remove('pill-disabled');
    }

    // kraft225 → solo monocromo
    const tintaColor = row.querySelector('input[name^="tinta"][value="color"]');
    const tintaMono  = row.querySelector('input[name^="tinta"][value="mono"]');
    const pillColor  = tintaColor?.closest('.cot-pill');
    if (papel === 'kraft225') {
      tintaColor.disabled = true;
      pillColor?.classList.add('pill-disabled');
      if (tintaColor.checked) { tintaColor.checked = false; tintaMono.checked = true; }
    } else {
      tintaColor.disabled = false;
      pillColor?.classList.remove('pill-disabled');
    }

    // hints de anillado según cantidad de páginas
    const anilladoHint = row.querySelector('.cot-anillado-hint');
    const tomoHint     = row.querySelector('.cot-tomo-hint');
    if (anilladoHint) anilladoHint.style.display = (state.numPages && state.numPages > 100 && state.numPages <= 500) ? '' : 'none';
    if (tomoHint)     tomoHint.style.display     = (state.numPages && state.numPages > 500) ? '' : 'none';

    // hojas automáticas desde página count del PDF
    if (state.numPages) {
      const faz   = row.querySelector('input[name^="faz"]:checked')?.value || 'simple';
      const hojas = faz === 'doble' ? Math.ceil(state.numPages / 2) : state.numPages;
      row.dataset.autoHojas = hojas;
      row.querySelector('.cot-hojas-val').textContent   = hojas + (hojas === 1 ? ' hoja' : ' hojas');
      row.querySelector('.cot-hojas-pages').textContent =
        state.numPages + ' pág.' + (faz === 'doble' ? ' · doble faz' : '');
    }
  };

  // Recalcular al cambiar opciones
  const recalc = () => {
    enforceConstraints();
    state.opts = getOpts(row);
    row.querySelector('.cot-file-subtotal').textContent = fmt(calcSubtotal(state.opts));
    updateSummary();
  };
  row.querySelectorAll('input').forEach(inp => inp.addEventListener('change', recalc));
  row.querySelectorAll('input[type="number"]').forEach(inp => inp.addEventListener('input', recalc));
  recalc();

  // Eliminar fila
  row.querySelector('.cot-file-remove').addEventListener('click', () => {
    files.delete(id);
    row.remove();
    updateSummary();
    if (files.size === 0) showStep('upload');
  });

  cotFileList.appendChild(row);
  updateSummary();

  // Thumbnail + conteo de páginas (PDF leído una sola vez)
  processFile(file, row).then(numPages => {
    if (numPages === null) {
      // No es PDF o no se pudo leer — mostrar aviso hojas manual
      const note = row.querySelector('.cot-hojas-note');
      if (note) note.style.display = '';
      return;
    }
    state.numPages = numPages;
    row.querySelector('.cot-hojas-auto').style.display   = '';
    row.querySelector('.cot-hojas-manual').style.display = 'none';
    recalc();
  });

  return row;
}

function showStep(name) {
  stepUpload.style.display  = name === 'upload'  ? '' : 'none';
  stepFiles.style.display   = name === 'files'   ? '' : 'none';
  stepSuccess.style.display = name === 'success' ? '' : 'none';
}

// ── Drop / file input ─────────────────────────────────────────────
const cotSizeToast      = document.getElementById('cotSizeToast');
const cotSizeToastTitle = document.getElementById('cotSizeToastTitle');
document.getElementById('cotSizeToastClose').addEventListener('click', () => {
  cotSizeToast.style.display = 'none';
});

function showFileError(title) {
  cotSizeToastTitle.textContent = title;
  cotSizeToast.style.display = '';
  clearTimeout(cotSizeToast._timer);
  cotSizeToast._timer = setTimeout(() => { cotSizeToast.style.display = 'none'; }, 8000);
}

function isDuplicate(file) {
  for (const [, state] of files) {
    if (state.name === file.name && state.file.size === file.size) return true;
  }
  return false;
}

function handleFiles(fileList) {
  let added = 0;
  Array.from(fileList).forEach(f => {
    if (files.size >= 10) return;
    if (f.size > MAX_FILE_SIZE) { showFileError(`«${f.name}» supera los ${MAX_FILE_MB} MB`); return; }
    if (isDuplicate(f)) { showFileError(`«${f.name}» ya fue agregado`); return; }
    addFileRow(f);
    added++;
  });
  if (added > 0) showStep('files');
}

cotBrowse.addEventListener('click', e => { e.stopPropagation(); if (pricesLoaded) cotFileInput.click(); });
function onFileInputChange(e) { if (e.target.files?.length) { handleFiles(e.target.files); e.target.value = ''; } }
cotFileInput.addEventListener('change', onFileInputChange);
cotFileInput.addEventListener('input',  onFileInputChange);

cotAddMore.addEventListener('click', () => cotFileInputMore.click());
cotUrgente.addEventListener('change', updateSummary);
cotFileInputMore.addEventListener('change', e => { handleFiles(e.target.files); e.target.value = ''; });

cotDrop.addEventListener('dragover',  e => { if (!pricesLoaded) return; e.preventDefault(); cotDrop.classList.add('drag-over'); });
cotDrop.addEventListener('dragleave', ()  => cotDrop.classList.remove('drag-over'));
cotDrop.addEventListener('drop', e => {
  e.preventDefault();
  cotDrop.classList.remove('drag-over');
  if (!pricesLoaded) return;
  handleFiles(e.dataTransfer.files);
});
cotDrop.addEventListener('click', () => { if (pricesLoaded) cotFileInput.click(); });

// ── Upload ────────────────────────────────────────────────────────
function uploadFile(state, row) {
  return new Promise((resolve, reject) => {
    setBadge(row, 'uploading', 'Subiendo…');
    row.classList.add('uploading');

    const bar  = row.querySelector('.cot-progress-bar');
    const wrap = row.querySelector('.cot-progress-wrap');
    if (wrap) wrap.style.display = '';

    const form = new FormData();
    form.append('file', state.file);
    form.append('sessionId', SESSION_ID);

    const xhr = new XMLHttpRequest();
    xhr.timeout = 120000; // 2 minutos
    xhr.open('POST', `${WORKER_URL}/upload`);

    xhr.upload.onprogress = e => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        if (bar) bar.style.width = `${pct}%`;
        setBadge(row, 'uploading', `Subiendo ${pct}%`);
      }
    };

    xhr.onload = () => {
      if (wrap) wrap.style.display = 'none';
      if (xhr.status >= 200 && xhr.status < 300) {
        const data = JSON.parse(xhr.responseText);
        state.uploadUrl = data.url;
        setBadge(row, 'done', 'Subido ✓');
        row.classList.remove('uploading');
        row.classList.add('done');
        resolve();
      } else {
        let msg = 'Error al subir archivo.';
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
        reject(new Error(msg));
      }
    };

    xhr.onerror   = () => reject(new Error('Error de red al subir archivo.'));
    xhr.ontimeout = () => reject(new Error('El archivo tardó demasiado en subir. Intentá con una conexión más rápida.'));
    xhr.send(form);
  });
}

// ── Submit ────────────────────────────────────────────────────────
cotSubmit.addEventListener('click', async () => {
  if (files.size === 0) return;

  const nombre = cotNombre.value.trim();
  const tel    = cotTel.value.trim();

  let invalid = false;
  [cotNombre, cotTel].forEach(el => {
    if (!el.value.trim()) {
      el.classList.add('input-error');
      el.addEventListener('input', () => el.classList.remove('input-error'), { once: true });
      invalid = true;
    }
  });
  if (invalid) {
    setNote('Completá tu nombre y teléfono para continuar.', true);
    cotNombre.closest('.cot-contact-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  setSubmitting(true);

  try {
    let uploaded = 0;
    const rows = document.querySelectorAll('.cot-file-row');
    const rowMap = {};
    rows.forEach(r => { rowMap[r.dataset.fileid] = r; });

    for (const [id, state] of files) {
      setNote(`Subiendo archivo ${++uploaded} de ${files.size}…`);
      await uploadFile(state, rowMap[id]);
    }

    const orderId = genId();
    setNote('Generando pedido…');
    buildSuccess(orderId, nombre, tel, cotNota.value.trim());
    showStep('success');

  } catch (err) {
    setNote('Error: ' + err.message, true);
  } finally {
    setSubmitting(false);
  }
});

function setSubmitting(on) {
  cotSubmit.disabled     = on;
  cotSubmitLabel.style.display = on ? 'none' : '';
  cotSpinner.style.display     = on ? ''     : 'none';
  if (!on) setNote('');
}

function setNote(msg, isError = false) {
  cotSubmitNote.textContent = msg;
  cotSubmitNote.className   = 'cot-submit-note' + (isError ? ' is-error' : '');
}

// ── Armar mensaje WhatsApp ─────────────────────────────────────────
function buildSuccess(orderId, nombre, tel, nota) {
  cotOrderId.textContent = orderId;

  const urgente = cotUrgente?.checked;

  const lines = [
    `Hola! Quiero confirmar el siguiente pedido:`,
    ``,
    urgente ? `*⚡ Pedido URGENTE — ${orderId}*` : `*Pedido ${orderId}*`,
    ``,
    `*Archivos:*`,
  ];

  let subtotal = 0;
  files.forEach(state => {
    const sub = calcSubtotal(state.opts);
    subtotal += sub;
    const detalle = optsLabel(state.opts);
    lines.push(`• ${state.name} — ${detalle} → ${fmt(sub)}`);
  });

  const total = urgente ? subtotal * 1.3 : subtotal;
  if (urgente) lines.push(`• Recargo urgente (+30%) → ${fmt(subtotal * 0.3)}`);

  lines.push(``);
  lines.push(`*Total estimado: ${fmt(total)}*`);
  lines.push(``);
  lines.push(`*Archivos (disponibles 7 días):*`);

  files.forEach(state => {
    lines.push(`• ${state.name}: ${state.uploadUrl || '(no disponible)'}`);
  });

  lines.push(``);
  const pago = document.querySelector('input[name="pago"]:checked')?.value;
  const pagoLabel = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia' };

  lines.push(`Nombre: ${nombre}`);
  lines.push(`Tel: ${tel}`);
  if (pago) lines.push(`Pago: ${pagoLabel[pago] || pago}${pago === 'transferencia' ? ` (Alias: ${TRANSFER_ALIAS})` : ''}`);
  if (nota) lines.push(`Nota: ${nota}`);

  const msg = lines.join('\n');
  cotWaBtn.href = `https://wa.me/${WA_NUMBER}?text=${encodeURIComponent(msg)}`;
  document.getElementById('cotWaPreview').textContent = msg;

  // Detectar retorno desde WhatsApp
  if (waReturnListener) document.removeEventListener('visibilitychange', waReturnListener);
  let waClicked = false;
  cotWaBtn.addEventListener('click', () => { waClicked = true; }, { once: true });
  waReturnListener = () => {
    if (waClicked && !document.hidden) {
      const conf = document.getElementById('cotWaConfirm');
      if (conf) conf.style.display = '';
      document.removeEventListener('visibilitychange', waReturnListener);
      waReturnListener = null;
    }
  };
  document.addEventListener('visibilitychange', waReturnListener);
}

// ── Nueva cotización ──────────────────────────────────────────────
cotNewOrder.addEventListener('click', () => {
  if (waReturnListener) { document.removeEventListener('visibilitychange', waReturnListener); waReturnListener = null; }
  const conf = document.getElementById('cotWaConfirm');
  if (conf) conf.style.display = 'none';
  files.clear();
  fileCounter = 0;
  cotFileList.innerHTML = '';
  cotSummaryRows.innerHTML = '';
  cotTotal.textContent = '$0';
  cotNombre.value = '';
  cotTel.value    = '';
  cotNota.value   = '';
  document.querySelectorAll('input[name="pago"]').forEach(r => r.checked = false);
  cotPagoInfo.style.display = 'none';
  showStep('upload');
});
