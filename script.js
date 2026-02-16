// PDF Fill & Sign - script.js
// Uses: PDF.js (for rendering), pdf-lib (for writing), SignaturePad (for signature capture)

// ----------------------
// CONFIG: change coordinates here (PDF points, bottom-left origin)
// ----------------------
const PDF_URL = 'form.pdf'; // file in project root

// Define text fields in PDF points (origin bottom-left). Adjust these values to match your PDF.
// Each field: { name, label, page, x, y, width, height, fontSize }
// NOTE: cleared by default — add entries here for any fields you want overlaid.
const fields = [
  // Example:
  // { name: 'fullName', label: 'Full name', page: 1, x: 120, y: 650, width: 350, height: 18, fontSize: 12 }
];

// Signature placement in PDF points. Add `page` if signature should be on another page.
const signatureField = { page: 1, x: 120, y: 540, width: 240, height: 60 };

// ----------------------
// Globals
// ----------------------
let originalPdfBytes = null; // ArrayBuffer of original PDF
let pdfJSDoc = null; // PDF.js document
let pdfPage = null; // current PDF.js page object
let pageWidthPts = 0;
let pageHeightPts = 0;
let currentScale = 1; // PDF points -> canvas pixel scale
let currentPageNum = 1;
let totalPages = 1;
let fieldCounter = 0;
let pdfFields = []; // collected form widget metadata from PDF.js
let activeSigField = null;
let currentRenderTask = null;
let resizeTimer = null;

// DOM
const canvas = document.getElementById('pdf-canvas');
const overlay = document.getElementById('overlay');
const coordDisplay = document.getElementById('coord-display');
const debugToggle = document.getElementById('debug-toggle');
const downloadBtn = document.getElementById('download-btn');
const downloadFillableBtn = document.getElementById('download-fillable-btn');
const addFieldBtn = document.getElementById('add-field');
let addFieldMode = false;
const fieldsList = document.getElementById('fields-list');
const sigCanvas = document.getElementById('sig-pad');
const clearSigBtn = document.getElementById('clear-sig');

// signature pad
const signaturePad = new SignaturePad(sigCanvas, { backgroundColor: 'rgba(255,255,255,0)', penColor: 'black' });

// Ensure PDF.js worker is set
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';

// ----------------------
// Utility: download a blob
// ----------------------
function downloadBytes(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Create overlays based on PDF.js annotations (form widgets)
async function createFormOverlays(page, viewport, pageNum) {
  // clear any existing overlays on this page (DOM only)
  fieldsList.innerHTML = '';

  const annotations = await page.getAnnotations({ intent: 'display' });
  annotations.forEach((ann, idx) => {
    if (ann.subtype !== 'Widget') return;

    const fieldName = ann.fieldName || `field_${pageNum}_${idx}`;
    const fieldType = ann.fieldType || ann.annotationType || 'Tx';
    const rect = ann.rect; // [x1, y1, x2, y2] in PDF user space

    // convert to viewport coords (pixels)
    const vpRect = viewport.convertToViewportRectangle(rect);
    const left = Math.min(vpRect[0], vpRect[2]);
    const top = Math.min(vpRect[1], vpRect[3]);
    const width = Math.abs(vpRect[2] - vpRect[0]);
    const height = Math.abs(vpRect[3] - vpRect[1]);

    // Determine widget type
    let type = 'text';
    if (fieldType === 'Btn') {
      // button: could be checkbox or radio
      if (ann.buttonValue) type = 'radio'; else type = 'checkbox';
    } else if (fieldType === 'Ch') {
      type = 'choice';
    } else if (fieldType === 'Sig') {
      type = 'signature';
    }

    // initial value (prefer previously stored value)
    const existing = pdfFields.find(x => x.name === fieldName && x.page === pageNum);
    const initial = existing ? (existing.value || '') : (ann.fieldValue || '');

    // create overlay control
    let el = null;
    if (type === 'text' || type === 'choice') {
      el = document.createElement('input');
      el.type = 'text';
      el.value = initial;
      el.style.fontSize = Math.max(10, Math.round(12 * currentScale * 0.63)) + 'px';
      el.addEventListener('input', () => { setPdfFieldValue(fieldName, pageNum, el.value); });
    } else if (type === 'checkbox') {
      el = document.createElement('input');
      el.type = 'checkbox';
      el.checked = initial && initial !== 'Off';
      el.addEventListener('change', () => { setPdfFieldValue(fieldName, pageNum, el.checked); });
    } else if (type === 'radio') {
      el = document.createElement('input');
      el.type = 'radio';
      el.name = fieldName; // group by name
      el.value = ann.buttonValue || ann.fieldValue || ('val' + idx);
      el.checked = (ann.fieldValue === el.value);
      el.addEventListener('change', () => { if (el.checked) setPdfFieldValue(fieldName, pageNum, el.value); });
    } else if (type === 'signature') {
      // if existing signature image stored, show it; otherwise show Sign button
      const existingSig = existing && existing.sigImage;
      if (existingSig) {
        el = document.createElement('img');
        el.src = existingSig;
        el.dataset.sig = fieldName;
        el.style.objectFit = 'contain';
        // allow clicking the image to select this signature field for replacement
        el.addEventListener('click', () => {
          activeSigField = fieldName;
          alert('Signature field selected. Draw a signature then click "Apply Signature To Field".');
        });
      } else {
        el = document.createElement('button');
        el.textContent = 'Sign';
        el.addEventListener('click', () => { activeSigField = fieldName; alert('Signature field selected. Draw a signature then click "Apply Signature To Field".'); });
      }
    }

    if (!el) return;

    el.style.position = 'absolute';
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
    el.style.padding = '2px';
    el.style.boxSizing = 'border-box';

    overlay.appendChild(el);

    // store or update metadata
    if (existing) {
      existing.type = type;
      existing.rect = rect;
      existing.element = el;
      existing.buttonValue = ann.buttonValue;
      existing.value = existing.value || initial;
    } else {
      pdfFields.push({ name: fieldName, type, page: pageNum, rect, element: el, value: initial, buttonValue: ann.buttonValue });
    }

    // Mark element with its field name for selection and attach click handler
    try {
      el.dataset.fieldName = fieldName;
    } catch (e) {}
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      // clear previous selection
      const prev = overlay.querySelector('.overlay-selected');
      if (prev) prev.classList.remove('overlay-selected');
      // mark this element as selected for signing
      el.classList.add('overlay-selected');
      activeSigField = fieldName;
    });

    // sidebar list
    const row = document.createElement('div');
    row.textContent = `${fieldName} (${type})`;
    fieldsList.appendChild(row);
  });
}

function setPdfFieldValue(name, page, value) {
  const f = pdfFields.find(x => x.name === name && x.page === page);
  if (!f) return;
  if (f.type === 'checkbox') f.checked = !!value;
  else f.value = value;
}

// ----------------------
// Load PDF, render page 1 to canvas, set up overlay
// ----------------------
async function loadAndRender() {
  try {
    // fetch the PDF bytes (only once)
    if (!originalPdfBytes) {
      const res = await fetch(PDF_URL);
      if (!res.ok) throw new Error('Cannot fetch form.pdf. Make sure file exists.');
      originalPdfBytes = await res.arrayBuffer();
    }

    // Load PDF.js document once
    if (!pdfJSDoc) {
      const loadingTask = pdfjsLib.getDocument({ data: originalPdfBytes });
      pdfJSDoc = await loadingTask.promise;
      totalPages = pdfJSDoc.numPages || 1;
      document.getElementById('page-indicator').textContent = `Page ${currentPageNum} / ${totalPages}`;
    }

    // Render current page
    await renderPage(currentPageNum);

  } catch (err) {
    console.error(err);
    alert('Failed to load PDF: ' + (err.message || err));
  }
}

async function renderPage(pageNum) {
  pdfPage = await pdfJSDoc.getPage(pageNum);

  // Get PDF page size in points for this page
  const view = pdfPage.view; // [xMin, yMin, xMax, yMax]
  pageWidthPts = view[2] - view[0];
  pageHeightPts = view[3] - view[1];

  // Choose scale so canvas fits its container width
  const container = document.getElementById('pdf-container');
  const containerWidth = Math.max(300, container.clientWidth || 700);
  currentScale = containerWidth / pageWidthPts;

  const viewport = pdfPage.getViewport({ scale: currentScale });

  // Set canvas size in device pixels for clarity
  const context = canvas.getContext('2d');
  const outputScale = window.devicePixelRatio || 1;
  canvas.width = Math.floor(viewport.width * outputScale);
  canvas.height = Math.floor(viewport.height * outputScale);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;

  // Use an offscreen (temporary) canvas for PDF.js rendering so multiple
  // render() operations don't try to use the same visible canvas concurrently.
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = canvas.width;
  tempCanvas.height = canvas.height;
  const tempCtx = tempCanvas.getContext('2d');
  // Apply the device pixel ratio transform on the temp context so pdf.js
  // renders at the correct scale (keeps overlay coordinates aligned).
  tempCtx.setTransform(outputScale, 0, 0, outputScale, 0, 0);

  // Render PDF page into the offscreen canvas
  const renderContext = { canvasContext: tempCtx, viewport };
  // If a previous render is in progress, cancel it and wait for it to finish
  if (currentRenderTask) {
    try {
      if (typeof currentRenderTask.cancel === 'function') currentRenderTask.cancel();
    } catch (e) {}
    try {
      await currentRenderTask.promise.catch(() => {});
    } catch (e) {}
  }


  // Start new render into temp canvas
  currentRenderTask = pdfPage.render(renderContext);
  try {
    await currentRenderTask.promise;

    // Copy rendered pixels from the offscreen canvas to the visible canvas.
    // Temporarily reset transforms so we draw into device pixel space.
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(tempCanvas, 0, 0);
    // Restore transform so overlay coordinate calculations remain consistent
    context.setTransform(outputScale, 0, 0, outputScale, 0, 0);

  } catch (err) {
    // If render was cancelled, ignore; otherwise log and rethrow
    if (err && err.name && err.name.toLowerCase().includes('cancel')) {
      // cancelled - ignore
    } else {
      console.error('Render error', err);
      throw err;
    }
  } finally {
    currentRenderTask = null;
  }

  // Resize and populate overlay for this page
  overlay.style.width = canvas.style.width;
  overlay.style.height = canvas.style.height;
  overlay.innerHTML = ''; // clear previous inputs
  overlay.style.pointerEvents = 'auto';

  // Create inputs for fields that belong to this page
  await createFormOverlays(pdfPage, viewport, pageNum);

  // Create signature preview element overlaid on PDF for this page
  createSignaturePreview();

  // Update page indicator
  totalPages = pdfJSDoc.numPages || totalPages;
  document.getElementById('page-indicator').textContent = `Page ${currentPageNum} / ${totalPages}`;
}

// ----------------------
// Create text input elements positioned over the PDF (visual only)
// ----------------------
function createFieldInputs() {
  // Clear fields list (sidebar)
  fieldsList.innerHTML = '';

  // For each field on this page, create a contenteditable div with drag/resize
  fields.filter(f => (f.page || 1) === currentPageNum).forEach(f => {
    const wrapper = document.createElement('div');
    wrapper.className = 'field-wrapper';

    // Convert PDF points -> pixels (top-left CSS coords)
    const leftPx = f.x * currentScale;
    const topPx = (pageHeightPts - f.y - f.height) * currentScale; // PDF origin bottom-left
    const widthPx = f.width * currentScale;
    const heightPx = f.height * currentScale;

    // Position wrapper exactly where the field should appear
    wrapper.style.position = 'absolute';
    wrapper.style.left = `${leftPx}px`;
    wrapper.style.top = `${topPx}px`;
    wrapper.style.width = `${widthPx}px`;
    wrapper.style.height = `${heightPx}px`;

    let fieldDiv;
    if (f.type === 'checkbox') {
      // render a checkbox input
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.style.width = '100%';
      cb.style.height = '100%';
      cb.checked = !!f.checked;
      cb.addEventListener('change', (e) => { f.checked = e.target.checked; });
      fieldDiv = cb;
    } else {
      fieldDiv = document.createElement('div');
      fieldDiv.className = 'field';
      fieldDiv.contentEditable = 'true';
      fieldDiv.dataset.name = f.name;
      fieldDiv.style.fontSize = `${Math.max(10, Math.round((f.fontSize || 12) * currentScale * 0.63))}px`;
      fieldDiv.innerText = f.value || f.label || '';
      // Update stored value when editing
      fieldDiv.addEventListener('input', (e) => { f.value = e.target.innerText; });
    }

    // Drag handling
    let drag = null;
    wrapper.addEventListener('pointerdown', (ev) => {
      if (ev.target.classList.contains('resize-handle') || ev.target.classList.contains('remove-btn') || ev.target.tagName.toLowerCase() === 'button') return;
      drag = { x: ev.clientX, y: ev.clientY, left: parseFloat(wrapper.style.left), top: parseFloat(wrapper.style.top) };
      wrapper.setPointerCapture(ev.pointerId);
    });
    wrapper.addEventListener('pointermove', (ev) => {
      if (!drag) return;
      const dx = ev.clientX - drag.x;
      const dy = ev.clientY - drag.y;
      wrapper.style.left = `${drag.left + dx}px`;
      wrapper.style.top = `${drag.top + dy}px`;
    });
    wrapper.addEventListener('pointerup', (ev) => {
      if (!drag) return;
      wrapper.releasePointerCapture(ev.pointerId);
      drag = null;
      // Save new coords back to field (convert px -> PDF points)
      const newLeftPx = parseFloat(wrapper.style.left);
      const newTopPx = parseFloat(wrapper.style.top);
      f.x = newLeftPx / currentScale;
      // convert top px back to PDF y
      f.y = pageHeightPts - (newTopPx / currentScale) - f.height;
    });

    // Resize handling
    const handle = document.createElement('div');
    handle.className = 'resize-handle';
    let resizing = null;
    handle.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation();
      resizing = { x: ev.clientX, y: ev.clientY, w: parseFloat(wrapper.style.width), h: parseFloat(wrapper.style.height) };
      handle.setPointerCapture(ev.pointerId);
    });
    handle.addEventListener('pointermove', (ev) => {
      if (!resizing) return;
      const dx = ev.clientX - resizing.x;
      const dy = ev.clientY - resizing.y;
      wrapper.style.width = `${Math.max(30, resizing.w + dx)}px`;
      wrapper.style.height = `${Math.max(14, resizing.h + dy)}px`;
    });
    handle.addEventListener('pointerup', (ev) => {
      if (!resizing) return;
      handle.releasePointerCapture(ev.pointerId);
      resizing = null;
      // save size back to field in PDF points
      const newWpx = parseFloat(wrapper.style.width);
      const newHpx = parseFloat(wrapper.style.height);
      f.width = newWpx / currentScale;
      f.height = newHpx / currentScale;
    });

    // Remove button on the overlay
    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-btn';
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove field';
    removeBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const idx = fields.findIndex(x => x.name === f.name);
      if (idx >= 0) fields.splice(idx, 1);
      createFieldInputs();
    });

    wrapper.appendChild(fieldDiv);
    wrapper.appendChild(handle);
    wrapper.appendChild(removeBtn);
    overlay.appendChild(wrapper);

    // Add an entry in the sidebar with a remove control
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.gap = '8px';

    const nameLabel = document.createElement('span');
    nameLabel.textContent = f.label || f.name;

    const del = document.createElement('button');
    del.textContent = 'Remove';
    del.style.background = '#e53935';
    del.style.padding = '4px 8px';
    del.style.fontSize = '12px';
    del.style.borderRadius = '4px';
    del.style.color = '#fff';
    del.addEventListener('click', () => {
      const idx = fields.findIndex(x => x.name === f.name);
      if (idx >= 0) fields.splice(idx, 1);
      createFieldInputs();
    });

    row.appendChild(nameLabel);
    row.appendChild(del);
    fieldsList.appendChild(row);
  });

  // Also populate sidebar with a helpful hint when no fields
  if (fields.filter(f => (f.page || 1) === currentPageNum).length === 0) {
    const hint = document.createElement('div');
    hint.textContent = 'No fields on this page. Click anywhere on the PDF to create an editable field (Shift+click to create a checkbox).';
    hint.style.fontSize = '13px';
    hint.style.color = '#555';
    fieldsList.appendChild(hint);
  }
}

// ----------------------
// Create an image element positioned over the PDF to preview signature
// ----------------------
let sigPreview = null;
function createSignaturePreview() {
  // Only show preview if signatureField is on current page
  if ((signatureField.page || 1) !== currentPageNum) return;

  sigPreview = document.createElement('img');
  sigPreview.className = 'sig-preview';
  sigPreview.style.display = 'none';

  const leftPx = signatureField.x * currentScale;
  const topPx = (pageHeightPts - signatureField.y - signatureField.height) * currentScale;
  const widthPx = signatureField.width * currentScale;
  const heightPx = signatureField.height * currentScale;

  sigPreview.style.left = `${leftPx}px`;
  sigPreview.style.top = `${topPx}px`;
  sigPreview.style.width = `${widthPx}px`;
  sigPreview.style.height = `${heightPx}px`;

  overlay.appendChild(sigPreview);

  updateSignaturePreview();
}

// ----------------------
// Debug: clicking on PDF shows PDF coordinates
// ----------------------
canvas.addEventListener('click', (ev) => {
  if (!debugToggle.checked) return;
  const rect = canvas.getBoundingClientRect();
  const clickX = ev.clientX - rect.left;
  const clickY = ev.clientY - rect.top;

  // Convert canvas pixels -> PDF points
  const pdfX = clickX / currentScale;
  const pdfY = pageHeightPts - (clickY / currentScale);

  coordDisplay.classList.remove('hidden');
  coordDisplay.textContent = `x: ${pdfX.toFixed(2)}, y: ${pdfY.toFixed(2)}`;

  // Temporary red marker
  const marker = document.createElement('div');
  marker.className = 'marker';
  marker.style.left = `${clickX}px`;
  marker.style.top = `${clickY}px`;
  overlay.appendChild(marker);
  setTimeout(() => marker.remove(), 2000);
});

// Also listen on the overlay (so clicks on transparent areas above the canvas work)
overlay.addEventListener('click', (ev) => {
  // If Developer Coordinate Mode is on, show coordinates and do not create a field
  const tag = ev.target.tagName && ev.target.tagName.toLowerCase();
  if (debugToggle.checked) {
    if (tag === 'input' || tag === 'textarea' || tag === 'button') return;
    const rect = canvas.getBoundingClientRect();
    const clickX = ev.clientX - rect.left;
    const clickY = ev.clientY - rect.top;
    const pdfX = clickX / currentScale;
    const pdfY = pageHeightPts - (clickY / currentScale);
    coordDisplay.classList.remove('hidden');
    coordDisplay.textContent = `x: ${pdfX.toFixed(2)}, y: ${pdfY.toFixed(2)}`;
    const marker = document.createElement('div');
    marker.className = 'marker';
    marker.style.left = `${clickX}px`;
    marker.style.top = `${clickY}px`;
    overlay.appendChild(marker);
    setTimeout(() => marker.remove(), 2000);
    return;
  }

  // Default: clicking the PDF creates a text field. Hold Shift while clicking to create a checkbox.
  if (tag === 'input' || tag === 'textarea' || tag === 'button') return;
  // Only create new fields when Add Field mode is active
  if (!addFieldMode) return;
  const rect2 = canvas.getBoundingClientRect();
  const clickX2 = ev.clientX - rect2.left;
  const clickY2 = ev.clientY - rect2.top;
  const pdfX2 = clickX2 / currentScale;
  const pdfY2 = pageHeightPts - (clickY2 / currentScale);

  fieldCounter += 1;
  const isCheckbox = ev.shiftKey === true;
  const newField = {
    name: `field_${Date.now()}_${fieldCounter}`,
    label: isCheckbox ? `Checkbox ${fieldCounter}` : `Field ${fieldCounter}`,
    page: currentPageNum,
    x: Math.max(10, pdfX2),
    y: Math.max(10, pdfY2),
    width: isCheckbox ? 16 : 200,
    height: isCheckbox ? 16 : 22,
    fontSize: isCheckbox ? 12 : 12,
    value: '',
    checked: false,
    type: isCheckbox ? 'checkbox' : 'text'
  };
  fields.push(newField);
  createFieldInputs();
  createSignaturePreview();
});

// ----------------------
// Signature handling
// ----------------------
clearSigBtn.addEventListener('click', () => {
  signaturePad.clear();
  updateSignaturePreview();
});

// Update preview when signature changes
sigCanvas.addEventListener('mouseup', updateSignaturePreview);
sigCanvas.addEventListener('touchend', updateSignaturePreview);

function updateSignaturePreview() {
  if (!sigPreview) return;
  if (signaturePad.isEmpty()) {
    sigPreview.style.display = 'none';
  } else {
    sigPreview.src = signaturePad.toDataURL('image/png');
    sigPreview.style.display = 'block';
  }
}

// Resize signature canvas for crisp strokes
function fixSignatureCanvasDPR() {
  const ratio = Math.max(window.devicePixelRatio || 1, 1);
  const w = sigCanvas.offsetWidth || 360;
  const h = sigCanvas.offsetHeight || 120;
  sigCanvas.width = Math.floor(w * ratio);
  sigCanvas.height = Math.floor(h * ratio);
  sigCanvas.getContext('2d').scale(ratio, ratio);
  signaturePad.clear();
}

window.addEventListener('resize', () => {
  // Debounce resize to avoid triggering overlapping PDF.js renders on mobile
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    loadAndRender();
    fixSignatureCanvasDPR();
  }, 200);
});

// Initial signature canvas fix
fixSignatureCanvasDPR();

// ----------------------
// PDF exports
// - Flattened: draws text/checks directly on pages (visual, works in browser viewers)
// - Fillable: creates real AcroForm fields (editable in supporting PDF viewers like Adobe Acrobat)
// ----------------------
downloadBtn.addEventListener('click', async () => {
  try {
    if (!originalPdfBytes) {
      alert('Original PDF not loaded.');
      return;
    }

    const pdfDoc = await PDFLib.PDFDocument.load(originalPdfBytes);
    const helvetica = await pdfDoc.embedFont(PDFLib.StandardFonts.Helvetica);
    const pagesCount = pdfJSDoc.numPages || 1;

    for (let p = 1; p <= pagesCount; p++) {
      const pages = pdfDoc.getPages();
      const targetPage = pages[p - 1];

      // Draw text fields onto page (flattened) using pdfFields collected from PDF.js
      pdfFields.filter(f => f.page === p && f.type === 'text').forEach(f => {
        const value = (f.value || '').toString();
        if (!value) return;
        const rect = f.rect; // [x1,y1,x2,y2]
        const x = Math.min(rect[0], rect[2]);
        const y = Math.min(rect[1], rect[3]);
        const width = Math.abs(rect[2] - rect[0]);
        const height = Math.abs(rect[3] - rect[1]);
        const fontSize = f.fontSize || Math.min(12, height * 0.8);
        const maxWidth = width;
        const words = value.split(/\s+/);
        let line = '';
        let cursorY = y + height - fontSize; // start near top
        const lineHeight = fontSize * 1.15;
        for (let i = 0; i < words.length; i++) {
          const testLine = line ? line + ' ' + words[i] : words[i];
          const testWidth = helvetica.widthOfTextAtSize(testLine, fontSize);
          if (testWidth > maxWidth && line) {
            targetPage.drawText(line, { x: x, y: cursorY, size: fontSize, font: helvetica, color: PDFLib.rgb(0, 0, 0) });
            line = words[i];
            cursorY -= lineHeight;
          } else {
            line = testLine;
          }
        }
        if (line) targetPage.drawText(line, { x: x, y: cursorY, size: fontSize, font: helvetica, color: PDFLib.rgb(0, 0, 0) });
      });

      // Draw checkboxes as X if checked
      pdfFields.filter(f => f.page === p && f.type === 'checkbox').forEach(f => {
        if (!f.checked) return;
        const rect = f.rect;
        const x = Math.min(rect[0], rect[2]);
        const y = Math.min(rect[1], rect[3]);
        const width = Math.abs(rect[2] - rect[0]);
        const height = Math.abs(rect[3] - rect[1]);
        const boxSize = Math.min(width, height);
        const fontSize = boxSize;
        const text = 'X';
        const textWidth = helvetica.widthOfTextAtSize(text, fontSize);
        const tx = x + (width - textWidth) / 2;
        const ty = y + (height - fontSize) / 2;
        targetPage.drawText(text, { x: tx, y: ty, size: fontSize, font: helvetica, color: PDFLib.rgb(0, 0, 0) });
      });

      // Embed signature images assigned to signature fields on this page
      for (const f of pdfFields.filter(ff => ff.page === p && ff.type === 'signature' && ff.sigImage)) {
        const rect = f.rect;
        const x = Math.min(rect[0], rect[2]);
        const y = Math.min(rect[1], rect[3]);
        const width = Math.abs(rect[2] - rect[0]);
        const height = Math.abs(rect[3] - rect[1]);
        const pngImage = await pdfDoc.embedPng(f.sigImage);
        targetPage.drawImage(pngImage, { x, y, width, height });
      }
    }

    const modifiedBytes = await pdfDoc.save();
    downloadBytes(modifiedBytes, 'completed_flattened.pdf');

  } catch (err) {
    console.error(err);
    alert('Failed to generate flattened PDF: ' + (err.message || err));
  }
});

// Fillable PDF (AcroForm)
downloadFillableBtn.addEventListener('click', async () => {
  try {
    if (!originalPdfBytes) {
      alert('Original PDF not loaded.');
      return;
    }

    const pdfDoc = await PDFLib.PDFDocument.load(originalPdfBytes);
    const form = pdfDoc.getForm();
    const helvetica = await pdfDoc.embedFont(PDFLib.StandardFonts.Helvetica);
    const pagesCount = pdfJSDoc.numPages || 1;

    // For fillable PDF, attempt to set existing fields by name
    pdfFields.forEach(f => {
      try {
        if (f.type === 'checkbox') {
          const cb = form.getCheckBox(f.name);
          if (f.checked) cb.check(); else cb.uncheck();
        } else if (f.type === 'radio') {
          // try radio group
          try { const rg = form.getRadioGroup(f.name); rg.select(f.value || ''); } catch (e) { }
        } else if (f.type === 'text' || f.type === 'choice') {
          try { const tf = form.getTextField(f.name); tf.setText(f.value || ''); } catch (e) { }
        }
      } catch (e) {
        // ignore missing field in original PDF; do not create new ones to avoid altering layout
      }
    });

    // Embed signatures as images (pdf-lib cannot create digital signatures, so we draw the image)
    for (const f of pdfFields.filter(ff => ff.type === 'signature' && ff.sigImage)) {
      const pages = pdfDoc.getPages();
      const targetPage = pages[f.page - 1];
      const rect = f.rect;
      const x = Math.min(rect[0], rect[2]);
      const y = Math.min(rect[1], rect[3]);
      const width = Math.abs(rect[2] - rect[0]);
      const height = Math.abs(rect[3] - rect[1]);
      const pngImage = await pdfDoc.embedPng(f.sigImage);
      targetPage.drawImage(pngImage, { x, y, width, height });
    }

    try { form.updateAppearances(helvetica); } catch (e) { }

    const modifiedBytes = await pdfDoc.save();
    downloadBytes(modifiedBytes, 'completed_fillable.pdf');

  } catch (err) {
    console.error(err);
    alert('Failed to generate fillable PDF: ' + (err.message || err));
  }
});

// ----------------------
// Boot
// ----------------------
document.addEventListener('DOMContentLoaded', () => {
  // Wire page navigation
  document.getElementById('prev-page').addEventListener('click', async () => {
    if (currentPageNum <= 1) return;
    currentPageNum -= 1;
    await loadAndRender();
  });
  document.getElementById('next-page').addEventListener('click', async () => {
    if (pdfJSDoc && currentPageNum >= pdfJSDoc.numPages) return;
    currentPageNum += 1;
    await loadAndRender();
  });

  // Note: clicking the PDF creates a text field by default.
  // Wire Add Field toggle button
  if (addFieldBtn) {
    addFieldBtn.addEventListener('click', () => {
      addFieldMode = !addFieldMode;
      addFieldBtn.classList.toggle('active', addFieldMode);
      const container = document.getElementById('pdf-container');
      if (addFieldMode) container.classList.add('add-field-mode'); else container.classList.remove('add-field-mode');
    });
  }

  loadAndRender();
});

// Apply signature button: assign current signature canvas image to selected field (converts it to signature)
document.getElementById('apply-sig').addEventListener('click', () => {
  if (!activeSigField) { alert('No signature field selected. Click a field on the PDF to select it, or click a signature field "Sign" button first.'); return; }
  if (signaturePad.isEmpty()) { alert('Please draw a signature first.'); return; }
  const dataUrl = signaturePad.toDataURL('image/png');
  const f = pdfFields.find(x => x.name === activeSigField);
  if (!f) { alert('Selected field not found.'); activeSigField = null; return; }

  // Convert the target to a signature field and store the image
  f.type = 'signature';
  f.sigImage = dataUrl;

  // show preview if field is on current page
  if (f.page === currentPageNum) {
    // remove any existing preview for this field
    const existing = overlay.querySelector(`img[data-sig="${f.name}"]`);
    if (existing) existing.remove();

    const img = document.createElement('img');
    img.src = dataUrl;
    img.dataset.sig = f.name;
    img.className = 'sig-preview';

    // compute viewport rectangle for the field
    let vpRect = null;
    try {
      if (f.rect) {
        const viewport = pdfPage.getViewport({ scale: currentScale });
        vpRect = viewport.convertToViewportRectangle(f.rect);
      } else if (f.element) {
        // fall back to element geometry
        const el = f.element;
        vpRect = [parseFloat(el.style.left || 0), parseFloat(el.style.top || 0), parseFloat(el.style.left || 0) + parseFloat(el.style.width || 0), parseFloat(el.style.top || 0) + parseFloat(el.style.height || 0)];
      }
    } catch (e) { vpRect = null; }

    let left = 0, top = 0, width = 120, height = 40;
    if (vpRect) {
      left = Math.min(vpRect[0], vpRect[2]);
      top = Math.min(vpRect[1], vpRect[3]);
      width = Math.abs(vpRect[2] - vpRect[0]);
      height = Math.abs(vpRect[3] - vpRect[1]);
    }

    img.style.position = 'absolute'; img.style.left = `${left}px`; img.style.top = `${top}px`;
    img.style.width = `${width}px`; img.style.height = `${height}px`;
    overlay.appendChild(img);

    // make it draggable and selectable
    try { enableDragForImage(img); } catch (e) {}
    img.addEventListener('click', (ev) => { ev.stopPropagation(); img.classList.add('overlay-selected'); activeSigField = f.name; });
  }

  activeSigField = null;
  // restore sidebar visibility after applying signature
  document.body.classList.remove('hide-sidebar');
  alert('Signature applied to field.');
});

// ----------------------
// Notes for developers
// - To change where text or signature appear in the final PDF, edit the
//   `fields` array and `signatureField` above. Coordinates are in PDF points
//   (units used by PDF: 72 points = 1 inch). Origin is bottom-left.
// - Use the Developer Coordinate Mode (checkbox) and click the displayed PDF
//   to see exact PDF coordinates for quick positioning.
// ----------------------
