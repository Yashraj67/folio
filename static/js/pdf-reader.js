// PDF engine built on PDF.js (vendored ES module, imported lazily).
import { api } from './api.js';
import { HL_COLORS, clamp, debounce, wordAtPoint } from './utils.js';

let pdfjsPromise = null;

function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('/static/vendor/pdf.mjs').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = '/static/vendor/pdf.worker.mjs';
      return lib;
    });
  }
  return pdfjsPromise;
}

function parseLoc(raw) {
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

export class PdfEngine {
  constructor(container, settings, cb) {
    this.container = container;
    this.settings = { ...settings };
    this.cb = cb;
    this.highlights = new Map();
    this.page = 1;
    this.total = 1;
    this.zoom = 1;
    this._renderSeq = 0;
    this._pageTextCache = new Map();
    this._destroyed = false;
    this.supportsFlow = false;
    this.supportsZoom = true;
    this.canSeek = true;
  }

  async open(book, savedLocation) {
    this.bookMeta = book;
    const pdfjs = await loadPdfjs();
    if (this._destroyed) return;

    this.container.innerHTML = `
      <div class="pdf-stage">
        <div class="pdf-page">
          <canvas></canvas>
          <div class="pdf-hl-layer"></div>
          <div class="textLayer"></div>
        </div>
      </div>`;
    this.stage = this.container.querySelector('.pdf-stage');
    this.pageEl = this.container.querySelector('.pdf-page');
    this.canvas = this.container.querySelector('canvas');
    this.hlLayer = this.container.querySelector('.pdf-hl-layer');
    this.textLayerEl = this.container.querySelector('.textLayer');

    this._loadingTask = pdfjs.getDocument({
      url: api.bookFileUrl(book.id),
      cMapUrl: '/static/vendor/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/static/vendor/standard_fonts/',
    });
    try {
      this.doc = await this._loadingTask.promise;
    } catch (err) {
      if (this._destroyed) return; // torn down mid-download
      throw err;
    }
    if (this._destroyed) return; // destroy() already killed the loading task
    this.total = this.doc.numPages;

    const saved = parseLoc(savedLocation);
    this.page = clamp(saved?.page || 1, 1, this.total);

    this._bindEvents();
    await this._render();
    if (this._destroyed) return;

    this.toc = await this._buildToc();
    if (this._destroyed) return;
    this.cb.onReady?.({ toc: this.toc });
    this._observeResize();
  }

  destroy() {
    this._destroyed = true;
    this._resizeObserver?.disconnect();
    if (this._selChangeHandler) {
      this._selChangeHandler.cancel?.();
      document.removeEventListener('selectionchange', this._selChangeHandler);
    }
    this._renderTask?.cancel?.();
    // Destroying the loading task also destroys the document and its worker,
    // including while the download/parse is still in flight.
    this._loadingTask?.destroy().catch(() => {});
    this.doc = null;
  }

  // ------------------------------------------------------------ navigation

  next() {
    this.setPage(this.page + 1);
  }

  prev() {
    this.setPage(this.page - 1);
  }

  setPage(p) {
    if (!this.doc) return;
    const target = clamp(p, 1, this.total);
    if (target === this.page) return;
    this.page = target;
    this._render();
  }

  goTo(href) {
    const loc = parseLoc(href);
    if (!loc || !this.doc) return;
    if (loc.page) {
      this.page = clamp(loc.page, 1, this.total);
      this._render();
    } else if (loc.dest !== undefined) {
      this._goToDest(loc.dest);
    }
  }

  async _goToDest(dest) {
    try {
      const resolved = typeof dest === 'string' ? await this.doc.getDestination(dest) : dest;
      if (!resolved || resolved[0] == null) return;
      // Explicit destinations may carry a page *index* instead of a page ref.
      if (Number.isInteger(resolved[0])) {
        this.page = clamp(resolved[0] + 1, 1, this.total);
        this._render();
        return;
      }
      const index = await this.doc.getPageIndex(resolved[0]);
      this.page = clamp(index + 1, 1, this.total);
      this._render();
    } catch {
      /* unresolvable destination */
    }
  }

  seekPercent(p) {
    this.setPage(Math.max(1, Math.round((p / 100) * this.total)));
  }

  zoomIn() {
    if (!this.doc) return;
    this.zoom = clamp(this.zoom + 0.15, 0.5, 3);
    this._render();
  }

  zoomOut() {
    if (!this.doc) return;
    this.zoom = clamp(this.zoom - 0.15, 0.5, 3);
    this._render();
  }

  // -------------------------------------------------------------- settings

  applySettings(settings) {
    this.settings = { ...settings };
    this._applyThemeFilter();
  }

  _applyThemeFilter() {
    if (!this.canvas) return; // settings changed before open() built the DOM
    // Soft-invert the page canvas in dark mode so PDFs aren't a white slab.
    this.canvas.style.filter =
      this.settings.theme === 'dark' ? 'invert(0.86) hue-rotate(180deg)' : '';
  }

  // ------------------------------------------------------------ highlights

  setHighlights(list) {
    this.highlights = new Map(list.map((h) => [h.id, h]));
    this._renderHighlightLayer();
  }

  addHighlight(h) {
    this.highlights.set(h.id, h);
    this._renderHighlightLayer();
  }

  removeHighlight(h) {
    this.highlights.delete(h.id);
    this._renderHighlightLayer();
  }

  restyleHighlight(h) {
    this.highlights.set(h.id, h);
    this._renderHighlightLayer();
  }

  _renderHighlightLayer() {
    if (!this.hlLayer) return;
    this.hlLayer.innerHTML = '';
    const scale = this.curScale || 1;
    for (const h of this.highlights.values()) {
      const loc = parseLoc(h.location);
      if (!loc || loc.page !== this.page || !Array.isArray(loc.rects)) continue;
      for (const r of loc.rects) {
        const div = document.createElement('div');
        div.className = 'pdf-hl';
        div.dataset.hl = h.id;
        div.style.left = `${r.x * scale}px`;
        div.style.top = `${r.y * scale}px`;
        div.style.width = `${r.w * scale}px`;
        div.style.height = `${r.h * scale}px`;
        div.style.background = HL_COLORS[h.color] || HL_COLORS.yellow;
        this.hlLayer.appendChild(div);
      }
    }
  }

  _highlightAtPoint(x, y) {
    for (const div of this.hlLayer.querySelectorAll('.pdf-hl')) {
      const r = div.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        return Number(div.dataset.hl);
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- search

  async search(query) {
    const needle = query.trim().toLowerCase();
    if (!needle || !this.doc) return [];
    const results = [];
    for (let p = 1; p <= this.total && results.length < 60; p++) {
      const text = await this._pageText(p);
      const lower = text.toLowerCase();
      let idx = lower.indexOf(needle);
      let perPage = 0;
      while (idx >= 0 && perPage < 5 && results.length < 60) {
        const from = Math.max(0, idx - 40);
        const excerpt =
          (from > 0 ? '…' : '') + text.slice(from, idx + needle.length + 40).trim() + '…';
        results.push({ label: `Page ${p}`, excerpt, href: JSON.stringify({ page: p }) });
        perPage += 1;
        idx = lower.indexOf(needle, idx + needle.length);
      }
    }
    return results;
  }

  async _pageText(p) {
    if (this._pageTextCache.has(p)) return this._pageTextCache.get(p);
    const page = await this.doc.getPage(p);
    const content = await page.getTextContent();
    const text = content.items.map((i) => i.str).join(' ');
    this._pageTextCache.set(p, text);
    return text;
  }

  // ------------------------------------------------------------- rendering

  async _render() {
    if (this._destroyed || !this.doc) return;
    const seq = ++this._renderSeq;
    this._renderTask?.cancel?.();

    let page;
    try {
      page = await this.doc.getPage(this.page);
    } catch {
      return; // document destroyed mid-request
    }
    if (seq !== this._renderSeq || this._destroyed) return;

    const base = page.getViewport({ scale: 1 });
    const availW = Math.max(280, this.stage.clientWidth - 48);
    const scale = (availW / base.width) * this.zoom;
    const viewport = page.getViewport({ scale });
    this.curScale = scale;

    const ratio = window.devicePixelRatio || 1;
    this.canvas.width = Math.floor(viewport.width * ratio);
    this.canvas.height = Math.floor(viewport.height * ratio);
    this.canvas.style.width = `${Math.floor(viewport.width)}px`;
    this.canvas.style.height = `${Math.floor(viewport.height)}px`;
    this.pageEl.style.width = `${Math.floor(viewport.width)}px`;
    this.pageEl.style.height = `${Math.floor(viewport.height)}px`;
    this.pageEl.style.setProperty('--scale-factor', String(scale));
    this._applyThemeFilter();

    const ctx = this.canvas.getContext('2d');
    this._renderTask = page.render({
      canvasContext: ctx,
      viewport,
      transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null,
    });
    try {
      await this._renderTask.promise;
    } catch {
      return; // cancelled by a newer render
    }
    if (seq !== this._renderSeq || this._destroyed) return;

    // Text layer (makes text selectable & clickable).
    this.textLayerEl.innerHTML = '';
    try {
      const pdfjs = await loadPdfjs();
      const textContent = await page.getTextContent();
      if (seq !== this._renderSeq || this._destroyed) return;
      const textLayer = new pdfjs.TextLayer({
        textContentSource: textContent,
        container: this.textLayerEl,
        viewport,
      });
      await textLayer.render();
    } catch {
      /* text layer is best-effort; the page image still renders */
    }

    this._renderHighlightLayer();
    this.stage.scrollTop = 0;

    this.cb.onRelocated?.({
      location: JSON.stringify({ page: this.page }),
      percentage: (this.page / this.total) * 100,
      label: `Page ${this.page} of ${this.total}`,
      canSeek: true,
    });
  }

  // ---------------------------------------------------------------- events

  _bindEvents() {
    this.stage.addEventListener('mouseup', () => {
      setTimeout(() => this._maybeEmitSelection(), 10);
    });
    // Mobile long-press selection never fires mouseup — watch selectionchange.
    this._selChangeHandler = debounce(() => this._maybeEmitSelection(), 600);
    document.addEventListener('selectionchange', this._selChangeHandler);

    this.stage.addEventListener('click', (e) => {
      setTimeout(() => {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) return;
        const hlId = this._highlightAtPoint(e.clientX, e.clientY);
        if (hlId != null) {
          this.cb.onHighlightClick?.(hlId, e.clientX, e.clientY);
          return;
        }
        if (this.textLayerEl.contains(e.target)) {
          const hit = wordAtPoint(document, e.clientX, e.clientY);
          if (hit) {
            this.cb.onWordClick?.(hit.word, hit.rect.left + hit.rect.width / 2, hit.rect.bottom);
            return;
          }
        }
        this.cb.onTap?.(e.clientX);
      }, 30);
    });
  }

  _maybeEmitSelection() {
    if (this._destroyed || !this.textLayerEl) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      this._lastSelKey = '';
      return;
    }
    const range = sel.getRangeAt(0);
    if (!this.textLayerEl.contains(range.commonAncestorContainer)) return;
    const text = sel.toString().trim();
    if (!text) return;

    const pageRect = this.pageEl.getBoundingClientRect();
    const scale = this.curScale || 1;
    const rects = this._mergeLineRects([...range.getClientRects()]).map((r) => ({
      x: (r.left - pageRect.left) / scale,
      y: (r.top - pageRect.top) / scale,
      w: r.width / scale,
      h: r.height / scale,
    }));
    if (!rects.length) return;

    const location = JSON.stringify({ page: this.page, rects });
    const key = `${location}|${text}`;
    if (key === this._lastSelKey) return; // mouseup + selectionchange double-fire
    this._lastSelKey = key;

    const bounds = range.getBoundingClientRect();
    this.cb.onSelected?.({
      location,
      text: text.slice(0, 5000),
      x: bounds.left + bounds.width / 2,
      y: bounds.top,
      clear: () => window.getSelection()?.removeAllRanges(),
    });
  }

  _mergeLineRects(rects) {
    const clean = rects.filter((r) => r.width > 1 && r.height > 1);
    const lines = [];
    for (const r of clean) {
      const line = lines.find((l) => Math.abs(l.top - r.top) < r.height * 0.5);
      if (line) {
        line.left = Math.min(line.left, r.left);
        line.right = Math.max(line.right, r.right);
        line.bottom = Math.max(line.bottom, r.bottom);
      } else {
        lines.push({ top: r.top, left: r.left, right: r.right, bottom: r.bottom });
      }
    }
    return lines.map((l) => ({
      left: l.left,
      top: l.top,
      width: l.right - l.left,
      height: l.bottom - l.top,
    }));
  }

  async _buildToc() {
    try {
      const outline = await this.doc.getOutline();
      if (!outline) return [];
      const flat = [];
      const walk = (items, depth) => {
        for (const item of items) {
          flat.push({
            label: item.title || 'Untitled',
            href: JSON.stringify({ dest: item.dest }),
            depth,
          });
          if (item.items?.length && depth < 3) walk(item.items, depth + 1);
        }
      };
      walk(outline, 0);
      return flat.slice(0, 400);
    } catch {
      return [];
    }
  }

  _observeResize() {
    const onResize = debounce(() => {
      if (!this._destroyed) this._render();
    }, 200);
    this._resizeObserver = new ResizeObserver(onResize);
    this._resizeObserver.observe(this.container);
  }

  currentLabel() {
    return `Page ${this.page} of ${this.total}`;
  }
}
