// EPUB engine built on epub.js (loaded globally as `ePub` from vendor).
import { api } from './api.js';
import { FONT_STACKS, HL_COLORS, debounce, wordAtPoint } from './utils.js';

const READER_THEMES = {
  light: { color: '#1f2328', background: '#faf9f6' },
  sepia: { color: '#453723', background: '#f4ecd8' },
  dark: { color: '#d5d1c9', background: '#15181c' },
};

export class EpubEngine {
  constructor(container, settings, cb) {
    this.container = container;
    this.settings = { ...settings };
    this.cb = cb;
    this.highlights = new Map(); // id -> highlight
    this.locationsReady = false;
    this.toc = [];
    this._destroyed = false;
    this.supportsFlow = true;
    this.supportsZoom = false;
  }

  async open(book, savedLocation) {
    this.bookMeta = book;
    const buf = await fetch(api.bookFileUrl(book.id)).then((r) => {
      if (!r.ok) throw new Error('Could not download the book file');
      return r.arrayBuffer();
    });
    if (this._destroyed) return;
    this.book = ePub(buf);

    this.rendition = this.book.renderTo(this.container, {
      width: '100%',
      height: '100%',
      flow: this.settings.flow === 'scrolled' ? 'scrolled' : 'paginated',
      spread: 'auto',
      allowScriptedContent: false,
    });

    this._registerThemes();
    this.applySettings(this.settings, { initial: true });

    this.rendition.hooks.content.register((contents) => this._onContent(contents));
    this.rendition.on('relocated', (loc) => this._onRelocated(loc));
    this.rendition.on('selected', (cfiRange, contents) => this._onSelected(cfiRange, contents));

    await this.book.ready;
    if (this._destroyed) return;
    await this.rendition.display(savedLocation || undefined);
    if (this._destroyed) return;

    const nav = await this.book.loaded.navigation;
    if (this._destroyed) return;
    this.toc = this._flattenToc(nav.toc || []);
    this.cb.onReady?.({ toc: this.toc });

    this._loadLocations(book); // async; refreshes percentage once ready
    this._observeResize();
  }

  destroy() {
    this._destroyed = true;
    this._resizeObserver?.disconnect();
    try {
      this.rendition?.destroy();
      this.book?.destroy();
    } catch {
      /* epub.js can throw during teardown of partially loaded books */
    }
  }

  // ------------------------------------------------------------ navigation

  next() {
    return this.rendition?.next();
  }

  prev() {
    return this.rendition?.prev();
  }

  goTo(href) {
    if (href) this.rendition?.display(href);
  }

  seekPercent(p) {
    if (!this.locationsReady) return;
    const cfi = this.book.locations.cfiFromPercentage(p / 100);
    if (cfi) this.rendition.display(cfi);
  }

  get canSeek() {
    return this.locationsReady;
  }

  // -------------------------------------------------------------- settings

  applySettings(settings, { initial = false } = {}) {
    const flowChanged = !initial && settings.flow !== this.settings.flow;
    const themeChanged = !initial && settings.theme !== this.settings.theme;
    this.settings = { ...settings };
    if (!this.rendition) return; // still downloading; open() applies these

    this.rendition.themes.select(this.settings.theme);
    this.rendition.themes.fontSize(`${this.settings.fontSize}%`);
    this.rendition.themes.font(FONT_STACKS[this.settings.font] || FONT_STACKS.serif);
    this.rendition.themes.override('line-height', String(this.settings.lineHeight));

    if (flowChanged) {
      this.rendition.flow(this.settings.flow === 'scrolled' ? 'scrolled' : 'paginated');
    }
    if (themeChanged) this._reapplyHighlights();
  }

  _registerThemes() {
    for (const [name, colors] of Object.entries(READER_THEMES)) {
      this.rendition.themes.register(name, {
        body: {
          color: `${colors.color} !important`,
          background: `${colors.background} !important`,
          'padding-left': '1.2em',
          'padding-right': '1.2em',
        },
        'a, a:visited': { color: 'inherit !important' },
        '::selection': { background: 'rgba(42, 120, 214, 0.28)' },
        img: { 'max-width': '100% !important' },
      });
    }
  }

  // ------------------------------------------------------------ highlights

  setHighlights(list) {
    for (const h of this.highlights.values()) this._removeAnnotation(h);
    this.highlights.clear();
    for (const h of list) this.addHighlight(h);
  }

  addHighlight(h) {
    this.highlights.set(h.id, h);
    try {
      this.rendition.annotations.highlight(
        h.location,
        { id: h.id },
        (e) => this._onAnnotationClick(h.id, e),
        'folio-hl',
        this._hlStyle(h.color)
      );
    } catch {
      /* stale CFI from a different copy of the book — skip rendering it */
    }
  }

  removeHighlight(h) {
    this.highlights.delete(h.id);
    this._removeAnnotation(h);
  }

  restyleHighlight(h) {
    this._removeAnnotation(h);
    this.addHighlight(h);
  }

  _removeAnnotation(h) {
    try {
      this.rendition.annotations.remove(h.location, 'highlight');
    } catch {
      /* not rendered */
    }
  }

  _reapplyHighlights() {
    const all = [...this.highlights.values()];
    this.setHighlights(all);
  }

  _hlStyle(color) {
    const fill = HL_COLORS[color] || HL_COLORS.yellow;
    if (this.settings.theme === 'dark') {
      return { fill, 'fill-opacity': '0.32', 'mix-blend-mode': 'normal' };
    }
    return { fill, 'fill-opacity': '0.45', 'mix-blend-mode': 'multiply' };
  }

  _onAnnotationClick(id, e) {
    const frame = e?.view?.frameElement;
    const fr = frame ? frame.getBoundingClientRect() : { left: 0, top: 0 };
    this.cb.onHighlightClick?.(id, fr.left + e.clientX, fr.top + e.clientY);
  }

  // ---------------------------------------------------------------- search

  async search(query) {
    const q = query.trim();
    if (!q || !this.book) return [];
    const variants = [...new Set([q, q.toLowerCase(), q[0].toUpperCase() + q.slice(1)])];
    const results = [];
    const seen = new Set();
    for (const item of this.book.spine.spineItems) {
      try {
        await item.load(this.book.load.bind(this.book));
        for (const v of variants) {
          for (const m of item.find(v)) {
            if (seen.has(m.cfi)) continue;
            seen.add(m.cfi);
            results.push({
              label: this._chapterFor(item.href) || 'Result',
              excerpt: m.excerpt,
              href: m.cfi,
            });
          }
        }
      } catch {
        /* skip unreadable spine item */
      } finally {
        item.unload();
      }
      if (results.length >= 60) break;
    }
    return results.slice(0, 60);
  }

  // ------------------------------------------------------------- internals

  async _loadLocations(book) {
    try {
      const cached = await api.getLocations(book.id);
      if (cached) {
        this.book.locations.load(cached);
      } else {
        await this.book.locations.generate(900);
        api.saveLocations(book.id, this.book.locations.save()).catch(() => {});
      }
      if (this._destroyed) return;
      this.locationsReady = true;
      if (this._lastLoc) this._onRelocated(this._lastLoc);
    } catch {
      /* percentage stays unavailable; reading still works */
    }
  }

  _onRelocated(loc) {
    this._lastLoc = loc;
    let percentage = null;
    if (this.locationsReady && loc.start?.cfi) {
      percentage = this.book.locations.percentageFromCfi(loc.start.cfi) * 100;
    }
    this.cb.onRelocated?.({
      location: loc.start?.cfi || '',
      percentage,
      label: this._chapterFor(loc.start?.href) || '',
      canSeek: this.locationsReady,
    });
  }

  _onSelected(cfiRange, contents) {
    const sel = contents.window.getSelection();
    const text = sel ? sel.toString().trim().slice(0, 5000) : '';
    if (!text) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const frame = contents.window.frameElement?.getBoundingClientRect() || { left: 0, top: 0 };
    this.cb.onSelected?.({
      location: cfiRange,
      text,
      x: frame.left + rect.left + rect.width / 2,
      y: frame.top + rect.top,
      clear: () => {
        try {
          contents.window.getSelection().removeAllRanges();
        } catch {
          /* iframe already gone */
        }
      },
    });
  }

  _onContent(contents) {
    const doc = contents.document;
    doc.addEventListener('keydown', (e) => this.cb.onKey?.(e));
    // Touch events don't cross the iframe boundary — forward them so the
    // reader's swipe-to-turn works inside EPUBs too.
    doc.addEventListener(
      'touchstart',
      (e) => {
        const t = e.changedTouches[0];
        this.cb.onTouchStart?.(t.clientX, t.clientY);
      },
      { passive: true }
    );
    doc.addEventListener(
      'touchend',
      (e) => {
        const t = e.changedTouches[0];
        this.cb.onTouchEnd?.(t.clientX, t.clientY);
      },
      { passive: true }
    );
    doc.addEventListener('click', (e) => {
      // Let epub.js emit 'selected' first; only treat as a tap/word-click
      // when nothing is selected.
      setTimeout(() => {
        const sel = contents.window.getSelection();
        if (sel && !sel.isCollapsed) return;
        if (e.target.closest && e.target.closest('a[href]')) return;
        const frame = contents.window.frameElement?.getBoundingClientRect() || { left: 0, top: 0 };
        const hit = wordAtPoint(doc, e.clientX, e.clientY);
        if (hit) {
          this.cb.onWordClick?.(
            hit.word,
            frame.left + hit.rect.left + hit.rect.width / 2,
            frame.top + hit.rect.bottom
          );
        } else {
          this.cb.onTap?.(frame.left + e.clientX);
        }
      }, 30);
    });
  }

  _flattenToc(items, depth = 0) {
    const out = [];
    for (const item of items) {
      out.push({ label: (item.label || '').trim(), href: item.href, depth });
      if (item.subitems?.length) out.push(...this._flattenToc(item.subitems, depth + 1));
    }
    return out;
  }

  _chapterFor(href) {
    if (!href) return '';
    const clean = href.split('#')[0];
    let best = '';
    for (const item of this.toc) {
      const itemHref = (item.href || '').split('#')[0];
      if (itemHref && (clean.endsWith(itemHref) || itemHref.endsWith(clean))) {
        best = item.label;
        break;
      }
    }
    return best;
  }

  _observeResize() {
    const onResize = debounce(() => {
      if (this._destroyed || !this.rendition) return;
      try {
        this.rendition.resize(this.container.clientWidth, this.container.clientHeight);
      } catch {
        /* rendition mid-teardown */
      }
    }, 150);
    this._resizeObserver = new ResizeObserver(onResize);
    this._resizeObserver.observe(this.container);
  }

  currentLabel() {
    return this._chapterFor(this._lastLoc?.start?.href) || '';
  }
}
