// Plain-text engine: renders paragraphs, tracks progress by scroll ratio and
// anchors highlights to character offsets in a canonical text
// (paragraphs joined by "\n\n"), which is stable across sessions.
import { api } from './api.js';
import { FONT_STACKS, clamp, debounce, wordAtPoint } from './utils.js';

function parseLoc(raw) {
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

export class TxtEngine {
  constructor(container, settings, cb) {
    this.container = container;
    this.settings = { ...settings };
    this.cb = cb;
    this.highlights = new Map();
    this._destroyed = false;
    this.supportsFlow = false;
    this.supportsZoom = false;
    this.canSeek = true;
  }

  async open(book, savedLocation) {
    this.bookMeta = book;
    const resp = await fetch(api.bookFileUrl(book.id));
    if (!resp.ok) throw new Error('Could not download the book file');
    const raw = (await resp.text()).replace(/\r\n?/g, '\n');
    if (this._destroyed) return; // torn down while downloading

    // Gutenberg-style files separate paragraphs with blank lines and
    // hard-wrap lines inside a paragraph; otherwise treat each line as one.
    const parts = /\n{2,}/.test(raw)
      ? raw.split(/\n{2,}/).map((p) => p.replace(/\n/g, ' ').trim())
      : raw.split('\n').map((p) => p.trim());
    this.paragraphs = parts.filter((p) => p.length > 0);
    this.canonical = this.paragraphs.join('\n\n');

    this.container.innerHTML =
      '<div class="txt-stage"><div class="txt-content"></div></div>';
    this.stage = this.container.querySelector('.txt-stage');
    this.content = this.container.querySelector('.txt-content');

    const frag = document.createDocumentFragment();
    let offset = 0;
    this.paraMeta = [];
    for (const text of this.paragraphs) {
      const p = document.createElement('p');
      p.dataset.start = offset;
      p.dataset.end = offset + text.length;
      p.textContent = text;
      this.paraMeta.push({ start: offset, end: offset + text.length, el: p, text });
      frag.appendChild(p);
      offset += text.length + 2; // "\n\n"
    }
    this.content.appendChild(frag);

    this.applySettings(this.settings);
    this._bindEvents();
    this.cb.onReady?.({ toc: [] });

    const saved = parseLoc(savedLocation);
    requestAnimationFrame(() => {
      if (this._destroyed) return;
      if (saved?.ratio) {
        this.stage.scrollTop = saved.ratio * (this.stage.scrollHeight - this.stage.clientHeight);
      }
      // Initial relocation so bookmarks/slider work before the first scroll.
      this._emitRelocated();
    });
  }

  destroy() {
    this._destroyed = true;
    this._onScroll?.cancel?.();
    if (this._selChangeHandler) {
      this._selChangeHandler.cancel?.();
      document.removeEventListener('selectionchange', this._selChangeHandler);
    }
  }

  // ------------------------------------------------------------ navigation

  next() {
    this.stage?.scrollBy({ top: this.stage.clientHeight * 0.9, behavior: 'smooth' });
  }

  prev() {
    this.stage?.scrollBy({ top: -this.stage.clientHeight * 0.9, behavior: 'smooth' });
  }

  goTo(href) {
    const loc = parseLoc(href);
    if (!loc || !this.stage) return;
    if (typeof loc.start === 'number') {
      const para = this.paraMeta.find((p) => loc.start >= p.start && loc.start <= p.end);
      if (para) {
        para.el.scrollIntoView({ block: 'center' });
        para.el.classList.add('flash');
        setTimeout(() => para.el.classList.remove('flash'), 1600);
      }
    } else if (typeof loc.ratio === 'number') {
      this.stage.scrollTop = loc.ratio * (this.stage.scrollHeight - this.stage.clientHeight);
    }
  }

  seekPercent(p) {
    if (!this.stage) return;
    this.stage.scrollTop = (p / 100) * (this.stage.scrollHeight - this.stage.clientHeight);
  }

  // -------------------------------------------------------------- settings

  applySettings(settings) {
    this.settings = { ...settings };
    if (!this.content) return; // still downloading; open() applies these
    this.content.style.fontFamily = FONT_STACKS[this.settings.font] || FONT_STACKS.serif;
    this.content.style.fontSize = `${(18 * this.settings.fontSize) / 100}px`;
    this.content.style.lineHeight = String(this.settings.lineHeight);
  }

  // ------------------------------------------------------------ highlights

  setHighlights(list) {
    this.highlights = new Map(list.map((h) => [h.id, h]));
    this._paintHighlights();
  }

  addHighlight(h) {
    this.highlights.set(h.id, h);
    this._paintHighlights();
  }

  removeHighlight(h) {
    this.highlights.delete(h.id);
    this._paintHighlights();
  }

  restyleHighlight(h) {
    this.highlights.set(h.id, h);
    this._paintHighlights();
  }

  _paintHighlights() {
    // Reset any paragraph that currently contains marks, then re-wrap.
    for (const meta of this.paraMeta) {
      if (meta.el.querySelector('mark')) meta.el.textContent = meta.text;
    }
    for (const h of this.highlights.values()) {
      const loc = parseLoc(h.location);
      if (!loc || typeof loc.start !== 'number' || typeof loc.end !== 'number') continue;
      for (const meta of this.paraMeta) {
        if (meta.end <= loc.start) continue;
        if (meta.start >= loc.end) break;
        const localStart = Math.max(0, loc.start - meta.start);
        const localEnd = Math.min(meta.text.length, loc.end - meta.start);
        this._wrapOffsets(meta.el, localStart, localEnd, h);
      }
    }
  }

  _wrapOffsets(paraEl, localStart, localEnd, h) {
    if (localEnd <= localStart) return;
    const walker = document.createTreeWalker(paraEl, NodeFilter.SHOW_TEXT);
    let pos = 0;
    const targets = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const len = node.textContent.length;
      const nodeStart = pos;
      const nodeEnd = pos + len;
      pos = nodeEnd;
      const from = Math.max(localStart, nodeStart);
      const to = Math.min(localEnd, nodeEnd);
      if (from >= to) continue;
      targets.push({ node, from: from - nodeStart, to: to - nodeStart });
    }
    for (const t of targets) {
      const range = document.createRange();
      range.setStart(t.node, t.from);
      range.setEnd(t.node, t.to);
      const mark = document.createElement('mark');
      mark.className = `txt-hl hl-${h.color}`;
      mark.dataset.hl = h.id;
      try {
        range.surroundContents(mark);
      } catch {
        /* range crosses element boundary — skip this fragment */
      }
    }
  }

  // ---------------------------------------------------------------- search

  async search(query) {
    const needle = query.trim().toLowerCase();
    if (!needle || !this.canonical) return [];
    const lower = this.canonical.toLowerCase();
    const results = [];
    let idx = lower.indexOf(needle);
    while (idx >= 0 && results.length < 60) {
      const from = Math.max(0, idx - 40);
      const excerpt =
        (from > 0 ? '…' : '') +
        this.canonical.slice(from, idx + needle.length + 40).replace(/\n+/g, ' ').trim() +
        '…';
      const pct = Math.round((idx / Math.max(1, this.canonical.length)) * 100);
      results.push({ label: `~${pct}%`, excerpt, href: JSON.stringify({ start: idx }) });
      idx = lower.indexOf(needle, idx + needle.length);
    }
    return results;
  }

  // ---------------------------------------------------------------- events

  _emitRelocated() {
    if (this._destroyed) return;
    const max = this.stage.scrollHeight - this.stage.clientHeight;
    const ratio = max > 0 ? clamp(this.stage.scrollTop / max, 0, 1) : 1;
    this.cb.onRelocated?.({
      location: JSON.stringify({ ratio }),
      percentage: ratio * 100,
      label: `${Math.round(ratio * 100)}%`,
      canSeek: true,
    });
  }

  _bindEvents() {
    this._onScroll = debounce(() => this._emitRelocated(), 250);
    this.stage.addEventListener('scroll', this._onScroll);

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
        const mark = e.target.closest?.('mark[data-hl]');
        if (mark) {
          this.cb.onHighlightClick?.(Number(mark.dataset.hl), e.clientX, e.clientY);
          return;
        }
        const hit = wordAtPoint(document, e.clientX, e.clientY);
        if (hit && this.content.contains(e.target)) {
          this.cb.onWordClick?.(hit.word, hit.rect.left + hit.rect.width / 2, hit.rect.bottom);
        } else {
          this.cb.onTap?.(e.clientX);
        }
      }, 30);
    });
  }

  _maybeEmitSelection() {
    if (this._destroyed || !this.content) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      this._lastSelKey = '';
      return;
    }
    const range = sel.getRangeAt(0);
    if (!this.content.contains(range.commonAncestorContainer)) return;
    const text = sel.toString().trim();
    if (!text) return;
    const start = this._absOffset(range.startContainer, range.startOffset);
    const end = this._absOffset(range.endContainer, range.endOffset);
    if (start == null || end == null || end <= start) return;

    const location = JSON.stringify({ start, end });
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

  _absOffset(node, offset) {
    // Element boundaries happen too (triple-click selections): resolve a
    // boundary on the content container to the paragraph at that child index.
    if (node === this.content) {
      const kids = node.children;
      if (offset >= kids.length) {
        const last = this.paraMeta[this.paraMeta.length - 1];
        return last ? last.end : null;
      }
      const start = kids[offset].dataset?.start;
      return start != null ? Number(start) : null;
    }
    const para = (node.nodeType === Node.TEXT_NODE ? node.parentElement : node)?.closest?.(
      'p[data-start]'
    );
    if (!para) return null;
    // A range from the paragraph start to (node, offset) measures the local
    // text offset for any boundary type, including inside <mark> wraps.
    const range = document.createRange();
    range.selectNodeContents(para);
    try {
      range.setEnd(node, offset);
    } catch {
      return Number(para.dataset.start);
    }
    return Number(para.dataset.start) + range.toString().length;
  }

  currentLabel() {
    if (!this.stage) return '';
    const max = this.stage.scrollHeight - this.stage.clientHeight;
    const ratio = max > 0 ? this.stage.scrollTop / max : 1;
    return `${Math.round(ratio * 100)}%`;
  }
}
