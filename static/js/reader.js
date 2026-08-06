// Reader controller: owns the reader chrome (toolbar, sidebar, popups,
// settings) and delegates rendering to a per-format engine.
import { api } from './api.js';
import { EpubEngine } from './epub-reader.js';
import { PdfEngine } from './pdf-reader.js';
import { TxtEngine } from './txt-reader.js';
import { clamp, debounce, escapeHtml, placeFloating, toast } from './utils.js';

export const SETTINGS_KEY = 'folio:settings';
const DEFAULT_SETTINGS = {
  theme: 'light',
  font: 'serif',
  fontSize: 100,
  lineHeight: 1.6,
  flow: 'paginated',
};

const ENGINES = { epub: EpubEngine, pdf: PdfEngine, txt: TxtEngine };

export function loadSettings() {
  let local = {};
  try {
    local = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  } catch {
    /* corrupted cache */
  }
  // Server-side settings follow the account across devices; localStorage is
  // just the offline/latency cache.
  const server = globalThis.__userSettings?.reader || {};
  return { ...DEFAULT_SETTINGS, ...local, ...server };
}

export class Reader {
  constructor(book, onExit) {
    this.book = book;
    this.onExit = onExit;
    this.settings = loadSettings();
    this.highlights = [];
    this.bookmarks = [];
    this.current = { location: book.location || '', percentage: book.percentage || 0 };
    this.lastActivity = Date.now();
    this._bound = [];
    this._destroyed = false;
  }

  // ------------------------------------------------------------- lifecycle

  async open() {
    this._cacheEls();
    this.view.dataset.theme = this.settings.theme;
    this.view.hidden = false;
    this.els.title.textContent = this.book.title;
    this.els.chapter.textContent = '';
    this.els.stage.innerHTML = '';
    this.els.slider.value = String(Math.round((this.book.percentage || 0) * 10));
    this.els.slider.disabled = true; // engines re-enable via onRelocated canSeek
    this.els.pct.textContent = this.book.percentage ? `${Math.round(this.book.percentage)}%` : '';

    // Reset panes that would otherwise leak state from the previous book.
    this.els.searchInput.value = '';
    this.els.searchResults.innerHTML = '';
    this.els.searchResults.onclick = null;
    this._selectTab('toc');

    const Engine = ENGINES[this.book.format];
    if (!Engine) {
      toast(`Unsupported format: ${this.book.format}`, { kind: 'error' });
      this.onExit();
      return;
    }
    this.engine = new Engine(this.els.stage, this.settings, {
      onReady: (info) => this._onEngineReady(info),
      onRelocated: (info) => this._onRelocated(info),
      onSelected: (sel) => this._showSelectionMenu(sel),
      onWordClick: (word, x, y) => this._showDictionary(word, x, y),
      onHighlightClick: (id, x, y) => this._showHighlightMenu(id, x, y),
      onTap: (x) => this._onTap(x),
      onKey: (e) => this._onKey(e),
      onTouchStart: (x, y) => this._touchStart(x, y),
      onTouchEnd: (x, y) => this._touchEnd(x, y),
    });

    this.els.zoomWrap.hidden = !this.engine.supportsZoom;
    this.els.flowRow.hidden = !this.engine.supportsFlow;

    this._bindUI();
    this._renderSettings();

    try {
      const [highlights, bookmarks] = await Promise.all([
        api.listHighlights(this.book.id),
        api.listBookmarks(this.book.id),
      ]);
      this.highlights = highlights;
      this.bookmarks = bookmarks;
    } catch {
      if (!this._destroyed) toast('Could not load annotations', { kind: 'error' });
    }
    if (this._destroyed) return;

    try {
      await this.engine.open(this.book, this.book.location || '');
    } catch (err) {
      if (this._destroyed) return; // teardown races look like open failures
      console.error(err);
      toast(`Could not open this book: ${err.message}`, { kind: 'error' });
      this.onExit();
      return;
    }
    if (this._destroyed) return;

    this.engine.setHighlights(this.highlights);
    this._renderHighlightList();
    this._renderBookmarkList();
    this._startHeartbeat();
  }

  destroy() {
    this._destroyed = true;
    this._flushProgress();
    clearInterval(this._heartbeatTimer);
    this._saveProgressDebounced?.cancel?.();
    for (const [target, type, fn, opts] of this._bound) target.removeEventListener(type, fn, opts);
    this._bound = [];
    this.engine?.destroy();
    this.els.stage.innerHTML = '';
    this._closePopups();
    this._closeDrawers();
    this.view.hidden = true;
  }

  _cacheEls() {
    this.view = document.getElementById('reader-view');
    const $ = (id) => document.getElementById(id);
    this.els = {
      back: $('r-back'),
      title: $('r-title'),
      chapter: $('r-chapter'),
      stage: $('r-stage'),
      prev: $('r-prev'),
      next: $('r-next'),
      slider: $('r-slider'),
      pct: $('r-pct'),
      tocBtn: $('r-toc'),
      searchBtn: $('r-search-btn'),
      bookmarkBtn: $('r-bookmark'),
      settingsBtn: $('r-settings'),
      zoomWrap: $('r-zoom'),
      zoomIn: $('r-zoom-in'),
      zoomOut: $('r-zoom-out'),
      sidebar: $('r-sidebar'),
      scrim: $('r-scrim'),
      drawer: $('r-drawer'),
      tabButtons: [...document.querySelectorAll('#r-sidebar .tab-btn')],
      tabPanels: {
        toc: $('tab-toc'),
        highlights: $('tab-highlights'),
        bookmarks: $('tab-bookmarks'),
        search: $('tab-search'),
      },
      searchInput: $('r-search-input'),
      searchResults: $('r-search-results'),
      dictPop: $('dict-pop'),
      dictBody: $('dict-body'),
      selMenu: $('sel-menu'),
      hlMenu: $('hl-menu'),
      notePop: $('note-pop'),
      noteText: $('note-text'),
      noteSave: $('note-save'),
      noteCancel: $('note-cancel'),
      flowRow: $('set-flow-row'),
      sizeVal: $('set-size-val'),
      lh: $('set-lh'),
      lhVal: $('set-lh-val'),
      fontSel: $('set-font'),
    };
  }

  _listen(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this._bound.push([target, type, fn, opts]);
  }

  // -------------------------------------------------------------------- UI

  _bindUI() {
    const els = this.els;
    this._listen(els.back, 'click', () => this.onExit());
    this._listen(els.prev, 'click', () => this.engine.prev());
    this._listen(els.next, 'click', () => this.engine.next());
    this._listen(els.zoomIn, 'click', () => this.engine.zoomIn?.());
    this._listen(els.zoomOut, 'click', () => this.engine.zoomOut?.());
    this._listen(els.bookmarkBtn, 'click', () => this._addBookmark());
    this._listen(els.tocBtn, 'click', () => this._toggleSidebar());
    this._listen(els.searchBtn, 'click', () => {
      this._toggleSidebar(true);
      this._selectTab('search');
      els.searchInput.focus();
    });
    this._listen(els.settingsBtn, 'click', () => {
      const open = els.drawer.classList.toggle('open');
      els.scrim.hidden = !open && !els.sidebar.classList.contains('open');
    });
    this._listen(els.scrim, 'click', () => this._closeDrawers());

    for (const btn of els.tabButtons) {
      this._listen(btn, 'click', () => this._selectTab(btn.dataset.tab));
    }

    this._listen(els.slider, 'input', () => {
      els.pct.textContent = `${Math.round(Number(els.slider.value) / 10)}%`;
    });
    this._listen(els.slider, 'change', () => {
      if (this.engine.canSeek) this.engine.seekPercent(Number(els.slider.value) / 10);
    });

    this._listen(els.searchInput, 'keydown', (e) => {
      if (e.key === 'Enter') this._runSearch();
    });

    this._listen(document, 'keydown', (e) => this._onKey(e));
    this._listen(document, 'pointerdown', (e) => {
      if (
        !e.target.closest(
          '#dict-pop, #sel-menu, #hl-menu, #note-pop, #r-sidebar, #r-drawer, .reader-top'
        )
      ) {
        this._closePopups();
      }
      this.lastActivity = Date.now();
    });

    // Swipe left/right anywhere on the stage turns the page (PDF/TXT; the
    // EPUB engine forwards the same events out of its iframe).
    this._listen(
      this.els.stage,
      'touchstart',
      (e) => this._touchStart(e.changedTouches[0].clientX, e.changedTouches[0].clientY),
      { passive: true }
    );
    this._listen(
      this.els.stage,
      'touchend',
      (e) => this._touchEnd(e.changedTouches[0].clientX, e.changedTouches[0].clientY),
      { passive: true }
    );

    const flush = () => this._flushProgress();
    this._listen(window, 'pagehide', flush);
    this._listen(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });

    this._bindSettingsControls();
    this._bindMenus();
  }

  _onKey(e) {
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    this.lastActivity = Date.now();
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
      e.preventDefault();
      this.engine.next();
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      e.preventDefault();
      this.engine.prev();
    } else if (e.key === 'Escape') {
      this._closePopups();
      this._closeDrawers();
    }
  }

  _toggleSidebar(forceOpen = false) {
    const open = forceOpen || !this.els.sidebar.classList.contains('open');
    this.els.sidebar.classList.toggle('open', open);
    this.els.scrim.hidden = !open && !this.els.drawer.classList.contains('open');
  }

  _closeDrawers() {
    this.els.sidebar.classList.remove('open');
    this.els.drawer.classList.remove('open');
    this.els.scrim.hidden = true;
  }

  _selectTab(name) {
    for (const btn of this.els.tabButtons) {
      btn.classList.toggle('active', btn.dataset.tab === name);
    }
    for (const [key, panel] of Object.entries(this.els.tabPanels)) {
      panel.hidden = key !== name;
    }
  }

  _closePopups() {
    this.els.dictPop.hidden = true;
    this.els.selMenu.hidden = true;
    this.els.hlMenu.hidden = true;
    this.els.notePop.hidden = true;
    this._pendingSelection = null;
  }

  /** Tap on empty reading area: close popups, or page-turn via edge zones. */
  _onTap(x) {
    const wasOpen = ['dictPop', 'selMenu', 'hlMenu', 'notePop'].some((k) => !this.els[k].hidden);
    this._closePopups();
    if (wasOpen || x == null) return;
    const w = window.innerWidth;
    if (x < w * 0.2) this.engine.prev();
    else if (x > w * 0.8) this.engine.next();
  }

  _touchStart(x, y) {
    this._touch = { x, y };
  }

  _touchEnd(x, y) {
    if (!this._touch) return;
    const dx = x - this._touch.x;
    const dy = y - this._touch.y;
    this._touch = null;
    if (Math.abs(dx) > 64 && Math.abs(dy) < Math.abs(dx) * 0.6) {
      if (dx < 0) this.engine.next();
      else this.engine.prev();
    }
  }

  // -------------------------------------------------------------- progress

  _onEngineReady(info) {
    this._renderToc(info.toc || []);
  }

  _onRelocated(info) {
    this.lastActivity = Date.now();
    this.current.location = info.location;
    if (info.percentage != null) this.current.percentage = clamp(info.percentage, 0, 100);
    this.els.chapter.textContent = info.label || '';
    if (info.percentage != null) {
      this.els.slider.value = String(Math.round(this.current.percentage * 10));
      this.els.pct.textContent = `${Math.round(this.current.percentage)}%`;
    }
    this.els.slider.disabled = !info.canSeek;
    if (!this._saveProgressDebounced) {
      this._saveProgressDebounced = debounce(() => this._saveProgress(), 1500);
    }
    this._saveProgressDebounced();
  }

  _saveProgress(opts = {}) {
    if (!this.current.location) return;
    api
      .saveProgress(this.book.id, this.current.location, this.current.percentage, opts)
      .catch(() => {});
  }

  _flushProgress() {
    this._saveProgressDebounced?.cancel?.();
    this._saveProgress({ keepalive: true });
  }

  _startHeartbeat() {
    this._heartbeatTimer = setInterval(() => {
      const active = Date.now() - this.lastActivity < 90_000;
      if (document.visibilityState === 'visible' && active) {
        api.heartbeat(this.book.id, 30).catch(() => {});
      }
    }, 30_000);
  }

  // ------------------------------------------------------------ dictionary

  async _showDictionary(word, x, y, selection = null) {
    this._closePopups();
    this._pendingSelection = selection; // enables highlight actions in the popup
    const pop = this.els.dictPop;
    const actionsHtml = selection
      ? `<div class="dict-actions">
          <span class="dict-actions-label">Highlight</span>
          <button data-color="yellow" class="color-dot dot-yellow" title="Yellow"></button>
          <button data-color="green" class="color-dot dot-green" title="Green"></button>
          <button data-color="blue" class="color-dot dot-blue" title="Blue"></button>
          <button data-color="pink" class="color-dot dot-pink" title="Pink"></button>
          <button class="pill-btn dict-note-btn">Note</button>
        </div>`
      : '';

    const render = (html) => {
      this.els.dictBody.innerHTML = html + actionsHtml;
      for (const dot of this.els.dictBody.querySelectorAll('.dict-actions [data-color]')) {
        dot.addEventListener('click', () => this._createHighlight(dot.dataset.color));
      }
      this.els.dictBody.querySelector('.dict-note-btn')?.addEventListener('click', async () => {
        const h = await this._createHighlight('yellow', { keepOpen: true });
        if (h) this._openNoteEditor(h);
      });
      placeFloating(pop, x, y);
    };

    render(`<div class="dict-word">${escapeHtml(word)}</div>
      <div class="dict-loading">Looking up…</div>`);

    let entry;
    try {
      entry = await api.define(word);
    } catch {
      entry = { word, found: false, error: 'offline' };
    }
    if (pop.hidden) return; // closed while loading
    render(this._dictHtml(entry));

    const audioBtn = this.els.dictBody.querySelector('.dict-audio');
    if (audioBtn) {
      audioBtn.addEventListener('click', () => new Audio(audioBtn.dataset.src).play());
    }
    for (const syn of this.els.dictBody.querySelectorAll('.dict-syn')) {
      syn.addEventListener('click', () => this._showDictionary(syn.textContent, x, y));
    }
  }

  _dictHtml(entry) {
    const head = `<div class="dict-head">
        <span class="dict-word">${escapeHtml(entry.word)}</span>
        ${entry.phonetic ? `<span class="dict-phon">${escapeHtml(entry.phonetic)}</span>` : ''}
        ${entry.audio ? `<button class="dict-audio icon-btn" data-src="${escapeHtml(entry.audio)}" title="Pronounce">🔊</button>` : ''}
      </div>`;
    if (!entry.found) {
      const msg =
        entry.error === 'offline'
          ? 'Dictionary is unreachable right now.'
          : 'No definition found.';
      return `${head}<div class="dict-empty">${msg}</div>`;
    }
    const meanings = entry.meanings
      .map(
        (m) => `<div class="dict-meaning">
          <span class="dict-pos">${escapeHtml(m.partOfSpeech)}</span>
          <ol>${m.definitions
            .map(
              (d) =>
                `<li>${escapeHtml(d.definition)}${
                  d.example ? `<div class="dict-example">“${escapeHtml(d.example)}”</div>` : ''
                }</li>`
            )
            .join('')}</ol>
          ${
            m.synonyms.length
              ? `<div class="dict-syns">${m.synonyms
                  .map((s) => `<button class="dict-syn">${escapeHtml(s)}</button>`)
                  .join('')}</div>`
              : ''
          }
        </div>`
      )
      .join('');
    return `${head}<div class="dict-meanings">${meanings}</div>`;
  }

  // ----------------------------------------------------- selection actions

  _bindMenus() {
    // New-selection menu
    for (const dot of this.els.selMenu.querySelectorAll('[data-color]')) {
      this._listen(dot, 'click', () => this._createHighlight(dot.dataset.color));
    }
    this._listen(document.getElementById('sel-note'), 'click', async () => {
      const h = await this._createHighlight('yellow', { keepOpen: true });
      if (h) this._openNoteEditor(h);
    });
    this._listen(document.getElementById('sel-copy'), 'click', () => {
      if (this._pendingSelection) {
        navigator.clipboard?.writeText(this._pendingSelection.text);
        toast('Copied');
      }
      this._closePopups();
    });
    this._listen(document.getElementById('sel-define'), 'click', () => {
      const sel = this._pendingSelection;
      if (!sel) return;
      const word = sel.text.split(/\s+/)[0];
      this._showDictionary(word, sel.x, sel.y);
    });

    // Existing-highlight menu
    for (const dot of this.els.hlMenu.querySelectorAll('[data-color]')) {
      this._listen(dot, 'click', async () => {
        const h = this._menuHighlight;
        if (!h) return;
        try {
          const updated = await api.patchHighlight(h.id, { color: dot.dataset.color });
          Object.assign(h, updated);
          this.engine.restyleHighlight(h);
          this._renderHighlightList();
        } catch {
          toast('Could not update highlight', { kind: 'error' });
        }
        this._closePopups();
      });
    }
    this._listen(document.getElementById('hl-note'), 'click', () => {
      if (this._menuHighlight) this._openNoteEditor(this._menuHighlight);
    });
    this._listen(document.getElementById('hl-copy'), 'click', () => {
      if (this._menuHighlight) {
        navigator.clipboard?.writeText(this._menuHighlight.text);
        toast('Copied');
      }
      this._closePopups();
    });
    this._listen(document.getElementById('hl-delete'), 'click', async () => {
      const h = this._menuHighlight;
      if (!h) return;
      try {
        await api.deleteHighlight(h.id);
        this.highlights = this.highlights.filter((x) => x.id !== h.id);
        this.engine.removeHighlight(h);
        this._renderHighlightList();
      } catch {
        toast('Could not delete highlight', { kind: 'error' });
      }
      this._closePopups();
    });

    // Note editor
    this._listen(this.els.noteSave, 'click', async () => {
      const h = this._noteHighlight;
      if (!h) return;
      try {
        const updated = await api.patchHighlight(h.id, { note: this.els.noteText.value.trim() });
        Object.assign(h, updated);
        this._renderHighlightList();
        toast('Note saved');
      } catch {
        toast('Could not save note', { kind: 'error' });
      }
      this._closePopups();
    });
    this._listen(this.els.noteCancel, 'click', () => this._closePopups());
  }

  _showSelectionMenu(sel) {
    // A single-word selection — however it was made (tap-select on touch
    // browsers, long-press, double-click) — opens the dictionary directly,
    // with highlight actions embedded in the popup. Deterministic: no
    // gesture sniffing. Multi-word selections get the highlight menu.
    const isSingleWord = !/\s/.test(sel.text) && sel.text.length <= 48;
    if (isSingleWord) {
      const word = sel.text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      sel.clear(); // also dismisses the OS selection callout
      if (word) {
        this._showDictionary(word, sel.x, sel.y + 20, sel);
        return;
      }
    }

    this._closePopups();
    this._pendingSelection = sel;
    document.getElementById('sel-define').hidden = true;
    placeFloating(this.els.selMenu, sel.x, sel.y, { above: true });
  }

  async _createHighlight(color, { keepOpen = false } = {}) {
    const sel = this._pendingSelection;
    if (!sel) return null;
    try {
      const created = await api.createHighlight(this.book.id, {
        location: sel.location,
        text: sel.text,
        color,
        note: '',
      });
      this.highlights.push(created);
      this.engine.addHighlight(created);
      this._renderHighlightList();
      sel.clear();
      if (!keepOpen) this._closePopups();
      return created;
    } catch (err) {
      toast(`Could not save highlight: ${err.message}`, { kind: 'error' });
      this._closePopups();
      return null;
    }
  }

  _showHighlightMenu(id, x, y) {
    const h = this.highlights.find((x_) => x_.id === id);
    if (!h) return;
    this._closePopups();
    this._menuHighlight = h;
    placeFloating(this.els.hlMenu, x, y, { above: true });
  }

  _openNoteEditor(h) {
    this.els.selMenu.hidden = true;
    this.els.hlMenu.hidden = true;
    this.els.dictPop.hidden = true;
    this._noteHighlight = h;
    this.els.noteText.value = h.note || '';
    this.els.notePop.hidden = false;
    this.els.noteText.focus();
  }

  // --------------------------------------------------------------- sidebar

  _renderToc(items) {
    const panel = this.els.tabPanels.toc;
    if (!items.length) {
      panel.innerHTML = '<div class="side-empty">No table of contents</div>';
      return;
    }
    panel.innerHTML = items
      .map(
        (item, i) =>
          `<button class="toc-item depth-${Math.min(item.depth, 3)}" data-i="${i}">
            ${escapeHtml(item.label || 'Untitled')}</button>`
      )
      .join('');
    this._tocItems = items;
    panel.onclick = (e) => {
      const btn = e.target.closest('.toc-item');
      if (!btn) return;
      this.engine.goTo(this._tocItems[Number(btn.dataset.i)].href);
      this._closeDrawers();
    };
  }

  _renderHighlightList() {
    const panel = this.els.tabPanels.highlights;
    if (!this.highlights.length) {
      panel.innerHTML = '<div class="side-empty">Select text while reading to highlight it</div>';
      return;
    }
    panel.innerHTML = this.highlights
      .map(
        (h) => `<div class="hl-item" data-id="${h.id}">
          <span class="hl-dot dot-${escapeHtml(h.color)}"></span>
          <div class="hl-body">
            <div class="hl-text">${escapeHtml(h.text.slice(0, 140))}${h.text.length > 140 ? '…' : ''}</div>
            ${h.note ? `<div class="hl-note">${escapeHtml(h.note.slice(0, 100))}</div>` : ''}
          </div>
          <button class="icon-btn hl-del" title="Delete">✕</button>
        </div>`
      )
      .join('');
    panel.onclick = async (e) => {
      const item = e.target.closest('.hl-item');
      if (!item) return;
      const h = this.highlights.find((x) => x.id === Number(item.dataset.id));
      if (!h) return;
      if (e.target.closest('.hl-del')) {
        try {
          await api.deleteHighlight(h.id);
          this.highlights = this.highlights.filter((x) => x.id !== h.id);
          this.engine.removeHighlight(h);
          this._renderHighlightList();
        } catch {
          toast('Could not delete highlight', { kind: 'error' });
        }
        return;
      }
      this.engine.goTo(h.location);
      this._closeDrawers();
    };
  }

  _renderBookmarkList() {
    const panel = this.els.tabPanels.bookmarks;
    if (!this.bookmarks.length) {
      panel.innerHTML = '<div class="side-empty">No bookmarks yet — tap the ribbon icon</div>';
      return;
    }
    panel.innerHTML = this.bookmarks
      .map(
        (b) => `<div class="bm-item" data-id="${b.id}">
          <span class="bm-icon">🔖</span>
          <div class="bm-label">${escapeHtml(b.label || 'Bookmark')}</div>
          <button class="icon-btn bm-del" title="Delete">✕</button>
        </div>`
      )
      .join('');
    panel.onclick = async (e) => {
      const item = e.target.closest('.bm-item');
      if (!item) return;
      const b = this.bookmarks.find((x) => x.id === Number(item.dataset.id));
      if (!b) return;
      if (e.target.closest('.bm-del')) {
        try {
          await api.deleteBookmark(b.id);
          this.bookmarks = this.bookmarks.filter((x) => x.id !== b.id);
          this._renderBookmarkList();
        } catch {
          toast('Could not delete bookmark', { kind: 'error' });
        }
        return;
      }
      this.engine.goTo(b.location);
      this._closeDrawers();
    };
  }

  async _addBookmark() {
    if (!this.current.location) return;
    const pct = Math.round(this.current.percentage || 0);
    const label = [this.engine.currentLabel?.() || '', `${pct}%`].filter(Boolean).join(' · ');
    try {
      const created = await api.createBookmark(this.book.id, {
        location: this.current.location,
        label,
      });
      this.bookmarks.push(created);
      this._renderBookmarkList();
      toast('Bookmarked');
    } catch {
      toast('Could not add bookmark', { kind: 'error' });
    }
  }

  async _runSearch() {
    const q = this.els.searchInput.value.trim();
    const host = this.els.searchResults;
    if (!q) return;
    host.innerHTML = '<div class="side-empty">Searching…</div>';
    let results = [];
    try {
      results = await this.engine.search(q);
    } catch {
      /* treated as no results */
    }
    if (!results.length) {
      host.innerHTML = '<div class="side-empty">No matches</div>';
      return;
    }
    host.innerHTML = results
      .map(
        (r, i) => `<button class="search-item" data-i="${i}">
          <span class="search-label">${escapeHtml(r.label)}</span>
          <span class="search-excerpt">${escapeHtml(r.excerpt || '')}</span>
        </button>`
      )
      .join('');
    host.onclick = (e) => {
      const btn = e.target.closest('.search-item');
      if (!btn) return;
      this.engine.goTo(results[Number(btn.dataset.i)].href);
      this._closeDrawers();
    };
  }

  // -------------------------------------------------------------- settings

  _bindSettingsControls() {
    for (const btn of this.els.drawer.querySelectorAll('[data-theme-opt]')) {
      this._listen(btn, 'click', () => {
        this._updateSettings({ theme: btn.dataset.themeOpt });
      });
    }
    this._listen(this.els.fontSel, 'change', () => {
      this._updateSettings({ font: this.els.fontSel.value });
    });
    this._listen(document.getElementById('set-size-minus'), 'click', () => {
      this._updateSettings({ fontSize: clamp(this.settings.fontSize - 10, 70, 160) });
    });
    this._listen(document.getElementById('set-size-plus'), 'click', () => {
      this._updateSettings({ fontSize: clamp(this.settings.fontSize + 10, 70, 160) });
    });
    this._listen(this.els.lh, 'change', () => {
      this._updateSettings({ lineHeight: Number(this.els.lh.value) });
    });
    for (const radio of this.els.flowRow.querySelectorAll('input[name=flow]')) {
      this._listen(radio, 'change', () => {
        if (radio.checked) this._updateSettings({ flow: radio.value });
      });
    }
  }

  _updateSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    globalThis.__userSettings = { ...(globalThis.__userSettings || {}), reader: this.settings };
    api.saveSettings(globalThis.__userSettings).catch(() => {});
    this.view.dataset.theme = this.settings.theme;
    this.engine.applySettings(this.settings);
    this._renderSettings();
  }

  _renderSettings() {
    for (const btn of this.els.drawer.querySelectorAll('[data-theme-opt]')) {
      btn.classList.toggle('active', btn.dataset.themeOpt === this.settings.theme);
    }
    this.els.fontSel.value = this.settings.font;
    this.els.sizeVal.textContent = `${this.settings.fontSize}%`;
    this.els.lh.value = String(this.settings.lineHeight);
    this.els.lhVal.textContent = this.settings.lineHeight.toFixed(1);
    for (const radio of this.els.flowRow.querySelectorAll('input[name=flow]')) {
      radio.checked = radio.value === this.settings.flow;
    }
  }
}
