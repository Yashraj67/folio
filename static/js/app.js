// App bootstrap: auth gate, hash router, library grid, uploads, stats modal.
import { api, setUnauthorizedHandler } from './api.js';
import { Reader, SETTINGS_KEY } from './reader.js';
import { escapeHtml, fmtDuration, fmtSize, hashHue, relTime, toast } from './utils.js';

const state = {
  books: [],
  query: '',
  sort: 'recent',
  reader: null,
};

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ router

let routeToken = 0;

async function route() {
  // Each navigation invalidates any still-awaiting older route() run.
  const token = ++routeToken;
  const hash = location.hash || '#/';
  const readMatch = hash.match(/^#\/read\/(\d+)$/);

  if (state.reader) {
    state.reader.destroy();
    state.reader = null;
  }

  if (readMatch) {
    $('library-view').hidden = true;
    let book;
    try {
      book = await api.getBook(Number(readMatch[1]));
    } catch {
      if (token === routeToken) {
        toast('Book not found', { kind: 'error' });
        location.hash = '#/';
      }
      return;
    }
    if (token !== routeToken) return;
    state.reader = new Reader(book, () => {
      location.hash = '#/';
    });
    await state.reader.open();
  } else {
    $('reader-view').hidden = true;
    $('library-view').hidden = false;
    await refreshLibrary();
  }
}

// ----------------------------------------------------------------- library

async function refreshLibrary() {
  try {
    state.books = await api.listBooks();
  } catch (err) {
    toast(`Could not load library: ${err.message}`, { kind: 'error' });
    state.books = [];
  }
  renderLibrary();
}

function visibleBooks() {
  let books = [...state.books];
  const q = state.query.toLowerCase();
  if (q) {
    books = books.filter(
      (b) => b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q)
    );
  }
  const sorters = {
    recent: (a, b) =>
      new Date(b.last_opened_at || b.added_at) - new Date(a.last_opened_at || a.added_at),
    title: (a, b) => a.title.localeCompare(b.title),
    author: (a, b) => (a.author || '~').localeCompare(b.author || '~'),
    progress: (a, b) => b.percentage - a.percentage,
  };
  books.sort(sorters[state.sort] || sorters.recent);
  return books;
}

function coverHtml(book) {
  if (book.cover_url) {
    return `<img class="card-cover" src="${book.cover_url}" alt="" loading="lazy"
      onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'card-cover card-cover-ph'}))">`;
  }
  const hue = hashHue(book.title);
  const initials = book.title
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] || '')
    .join('')
    .toUpperCase();
  return `<div class="card-cover card-cover-ph"
    style="background:linear-gradient(160deg,hsl(${hue},32%,72%),hsl(${(hue + 40) % 360},30%,52%))">
    <span>${escapeHtml(initials)}</span></div>`;
}

function renderLibrary() {
  const grid = $('book-grid');
  const books = visibleBooks();
  $('lib-empty').hidden = state.books.length > 0;
  grid.hidden = state.books.length === 0;

  grid.innerHTML = books
    .map((b) => {
      const pct = Math.round(b.percentage);
      return `<article class="book-card" data-id="${b.id}" tabindex="0" role="button"
          aria-label="Read ${escapeHtml(b.title)}">
        <div class="card-cover-wrap">
          ${coverHtml(b)}
          <span class="card-badge">${b.format.toUpperCase()}</span>
          <button class="card-menu-btn icon-btn" title="More" aria-label="Book options">⋯</button>
        </div>
        <div class="card-info">
          <div class="card-title" title="${escapeHtml(b.title)}">${escapeHtml(b.title)}</div>
          <div class="card-author">${escapeHtml(b.author || '')}</div>
          <div class="card-progress"><div class="card-progress-fill" style="width:${pct}%"></div></div>
          <div class="card-meta">
            <span>${pct > 0 ? `${pct}%` : 'New'}</span>
            <span>${b.last_opened_at ? relTime(b.last_opened_at) : fmtSize(b.file_size)}</span>
          </div>
        </div>
      </article>`;
    })
    .join('');

  grid.onclick = (e) => {
    const card = e.target.closest('.book-card');
    if (!card) return;
    const book = state.books.find((b) => b.id === Number(card.dataset.id));
    if (!book) return;
    if (e.target.closest('.card-menu-btn')) {
      showCardMenu(book, e.target.closest('.card-menu-btn'));
      return;
    }
    location.hash = `#/read/${book.id}`;
  };
  grid.onkeydown = (e) => {
    if (e.key === 'Enter') {
      const card = e.target.closest('.book-card');
      if (card) location.hash = `#/read/${card.dataset.id}`;
    }
  };
}

function showCardMenu(book, anchor) {
  closeCardMenu();
  const menu = document.createElement('div');
  menu.className = 'card-menu';
  menu.id = 'card-menu';
  menu.innerHTML = `
    <button data-act="read">Continue reading</button>
    <button data-act="export">Export annotations</button>
    <button data-act="delete" class="danger">Delete book</button>`;
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.min(r.left, window.innerWidth - menu.offsetWidth - 12)}px`;
  menu.style.top = `${r.bottom + 6}px`;

  menu.onclick = async (e) => {
    const act = e.target.closest('button')?.dataset.act;
    closeCardMenu();
    if (act === 'read') location.hash = `#/read/${book.id}`;
    if (act === 'export') window.location.href = api.exportUrl(book.id);
    if (act === 'delete') {
      if (!confirm(`Delete “${book.title}” and all its highlights?`)) return;
      try {
        await api.deleteBook(book.id);
        toast('Book deleted');
        refreshLibrary();
      } catch (err) {
        toast(`Could not delete: ${err.message}`, { kind: 'error' });
      }
    }
  };
  setTimeout(() => {
    document.addEventListener('pointerdown', dismissCardMenu, { once: true });
  }, 0);
}

function dismissCardMenu(e) {
  if (!e.target.closest('#card-menu')) closeCardMenu();
}

function closeCardMenu() {
  document.getElementById('card-menu')?.remove();
}

// ------------------------------------------------------------------ upload

async function uploadFiles(files) {
  const accepted = [...files].filter((f) => /\.(epub|pdf|txt)$/i.test(f.name));
  const skipped = files.length - accepted.length;
  if (skipped > 0) toast(`${skipped} file(s) skipped (only EPUB, PDF, TXT)`, { kind: 'error' });

  for (const file of accepted) {
    const t = toast(`Uploading ${file.name}… 0%`, { timeout: 10 * 60 * 1000 });
    try {
      await api.uploadBook(file, (frac) => {
        t.textContent = `Uploading ${file.name}… ${Math.round(frac * 100)}%`;
      });
      t.textContent = `Added ${file.name}`;
      setTimeout(() => t.remove(), 2500);
    } catch (err) {
      t.textContent = `${file.name}: ${err.message}`;
      t.classList.add('toast-error');
      setTimeout(() => t.remove(), 6000);
    }
  }
  if (accepted.length) refreshLibrary();
}

function bindUpload() {
  const input = $('upload-input');
  $('upload-btn').addEventListener('click', () => input.click());
  $('empty-upload-btn').addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    uploadFiles(input.files);
    input.value = '';
  });

  let dragDepth = 0;
  const overlay = $('drop-overlay');
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    dragDepth += 1;
    overlay.hidden = false;
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) overlay.hidden = true;
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    overlay.hidden = true;
    if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
  });
}

// ------------------------------------------------------------------- stats

async function showStats() {
  const modal = $('stats-modal');
  const body = $('stats-body');
  modal.hidden = false;
  body.innerHTML = '<div class="side-empty">Loading…</div>';

  let s;
  try {
    s = await api.stats();
  } catch (err) {
    body.innerHTML = `<div class="side-empty">Could not load stats: ${escapeHtml(err.message)}</div>`;
    return;
  }

  const maxSec = Math.max(...s.last_14_days.map((d) => d.seconds), 1);
  const today = s.last_14_days[s.last_14_days.length - 1]?.day;
  const maxDay = s.last_14_days.reduce((a, b) => (b.seconds > a.seconds ? b : a), {
    seconds: -1,
  });

  const bars = s.last_14_days
    .map((d) => {
      const h = d.seconds > 0 ? Math.max(6, Math.round((d.seconds / maxSec) * 100)) : 2;
      const weekday = new Date(`${d.day}T00:00:00`).toLocaleDateString(undefined, {
        weekday: 'short',
      });
      const showLabel = d.seconds > 0 && (d.day === today || d.day === maxDay.day);
      return `<div class="chart-col">
        ${showLabel ? `<span class="chart-val">${fmtDuration(d.seconds)}</span>` : ''}
        <div class="chart-bar${d.seconds === 0 ? ' zero' : ''}" style="height:${h}%"
          role="img" aria-label="${d.day}: ${fmtDuration(d.seconds)}">
          <span class="chart-tip">${weekday} · ${fmtDuration(d.seconds)}</span>
        </div>
        <span class="chart-day">${weekday[0]}</span>
      </div>`;
    })
    .join('');

  const topBooks = s.top_books.length
    ? `<div class="stats-top">
        <h3>Most read</h3>
        ${s.top_books
          .map(
            (b) => `<div class="top-row">
              <span class="top-title">${escapeHtml(b.title)}</span>
              <span class="top-time">${fmtDuration(b.seconds)}</span>
            </div>`
          )
          .join('')}
      </div>`
    : '';

  body.innerHTML = `
    <div class="stat-tiles">
      <div class="stat-tile"><span class="stat-val">${s.streak_days}</span><span class="stat-label">day streak</span></div>
      <div class="stat-tile"><span class="stat-val">${fmtDuration(s.today_seconds)}</span><span class="stat-label">read today</span></div>
      <div class="stat-tile"><span class="stat-val">${fmtDuration(s.total_seconds)}</span><span class="stat-label">all time</span></div>
      <div class="stat-tile"><span class="stat-val">${s.finished_books}<span class="stat-sub">/${s.total_books}</span></span><span class="stat-label">books finished</span></div>
    </div>
    <h3>Reading time — last 14 days</h3>
    <div class="chart">${bars}</div>
    <details class="chart-data">
      <summary>View data</summary>
      <table>
        <thead><tr><th>Day</th><th>Time</th></tr></thead>
        <tbody>${s.last_14_days
          .map((d) => `<tr><td>${d.day}</td><td>${fmtDuration(d.seconds)}</td></tr>`)
          .join('')}</tbody>
      </table>
    </details>
    ${topBooks}`;
}

// -------------------------------------------------------------------- auth

let authMode = 'login';

function showAuth() {
  if (state.reader) {
    state.reader.destroy();
    state.reader = null;
  }
  // Wipe the previous account's client state so nothing leaks to the next
  // person on a shared browser.
  state.books = [];
  $('book-grid').innerHTML = '';
  $('user-chip').textContent = '';
  $('auth-email').value = '';
  $('auth-password').value = '';
  $('library-view').hidden = true;
  $('reader-view').hidden = true;
  $('auth-view').hidden = false;
  $('auth-error').hidden = true;
}

function enterApp(user) {
  globalThis.__userSettings = user.settings || {};
  // localStorage is only a cache of the signed-in account's settings — sync
  // it to the server copy so one account's prefs never bleed into another.
  try {
    const reader = globalThis.__userSettings.reader;
    if (reader) localStorage.setItem(SETTINGS_KEY, JSON.stringify(reader));
    else localStorage.removeItem(SETTINGS_KEY);
  } catch {
    /* storage unavailable */
  }
  $('user-chip').textContent = user.email;
  $('auth-view').hidden = true;
  if (location.hash.startsWith('#/read/')) location.hash = '#/';
  route();
}

function setAuthMode(mode) {
  authMode = mode;
  const isLogin = mode === 'login';
  $('auth-submit').textContent = isLogin ? 'Sign in' : 'Create account';
  $('auth-toggle').textContent = isLogin
    ? 'New here? Create an account'
    : 'Already registered? Sign in';
  $('auth-password').autocomplete = isLogin ? 'current-password' : 'new-password';
  $('auth-error').hidden = true;
}

function bindAuth() {
  setUnauthorizedHandler(showAuth);
  $('auth-toggle').addEventListener('click', () =>
    setAuthMode(authMode === 'login' ? 'register' : 'login')
  );
  $('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('auth-email').value.trim();
    const password = $('auth-password').value;
    const submit = $('auth-submit');
    submit.disabled = true;
    try {
      const user =
        authMode === 'login'
          ? await api.login(email, password)
          : await api.register(email, password);
      $('auth-password').value = '';
      enterApp(user);
    } catch (err) {
      const errEl = $('auth-error');
      errEl.textContent = err.message;
      errEl.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
  $('logout-btn').addEventListener('click', async () => {
    try {
      await api.logout();
    } catch {
      /* session may already be gone */
    }
    globalThis.__userSettings = {};
    try {
      localStorage.removeItem(SETTINGS_KEY);
    } catch {
      /* storage unavailable */
    }
    showAuth();
  });
}

// --------------------------------------------------------------- bootstrap

async function init() {
  bindAuth();
  bindUpload();
  $('lib-search').addEventListener('input', (e) => {
    state.query = e.target.value;
    renderLibrary();
  });
  $('lib-sort').addEventListener('change', (e) => {
    state.sort = e.target.value;
    renderLibrary();
  });
  $('stats-btn').addEventListener('click', showStats);
  $('stats-close').addEventListener('click', () => {
    $('stats-modal').hidden = true;
  });
  $('stats-modal').addEventListener('click', (e) => {
    if (e.target.id === 'stats-modal') $('stats-modal').hidden = true;
  });
  window.addEventListener('hashchange', route);
  try {
    enterApp(await api.me());
  } catch {
    showAuth();
  }
}

init();
