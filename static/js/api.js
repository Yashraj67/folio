// Thin fetch client for the Folio backend.

const JSON_HEADERS = { 'Content-Type': 'application/json' };

let onUnauthorized = null;

/** Called on any 401 so the app can drop back to the sign-in screen. */
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

async function handle(resp) {
  if (resp.status === 401 && onUnauthorized) onUnauthorized();
  if (!resp.ok) {
    let detail = resp.statusText;
    try {
      const body = await resp.json();
      if (body && body.detail) detail = typeof body.detail === 'string' ? body.detail : detail;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail || `Request failed (${resp.status})`);
  }
  if (resp.status === 204) return null;
  return resp.json();
}

const get = (url) => fetch(url).then(handle);

/** Client-local calendar day (YYYY-MM-DD) so stats bucket by the reader's day. */
function localDay() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const send = (url, method, body, opts = {}) =>
  fetch(url, { method, headers: JSON_HEADERS, body: JSON.stringify(body), ...opts }).then(handle);
const del = (url) => fetch(url, { method: 'DELETE' }).then(handle);

export const api = {
  me: () => get('/api/auth/me'),
  login: (email, password) => send('/api/auth/login', 'POST', { email, password }),
  register: (email, password) => send('/api/auth/register', 'POST', { email, password }),
  logout: () => send('/api/auth/logout', 'POST', {}),
  saveSettings: (settings) => send('/api/auth/settings', 'PUT', { settings }),

  listBooks: () => get('/api/books'),
  getBook: (id) => get(`/api/books/${id}`),
  deleteBook: (id) => del(`/api/books/${id}`),
  bookFileUrl: (id) => `/api/books/${id}/file`,
  exportUrl: (id) => `/api/books/${id}/export`,

  getProgress: (id) => get(`/api/books/${id}/progress`),
  saveProgress: (id, location, percentage, { keepalive = false } = {}) =>
    send(`/api/books/${id}/progress`, 'PUT', { location, percentage }, { keepalive }),

  getLocations: (id) => get(`/api/books/${id}/locations`).then((r) => r.locations),
  saveLocations: (id, locations) => send(`/api/books/${id}/locations`, 'PUT', { locations }),

  listHighlights: (id) => get(`/api/books/${id}/highlights`),
  createHighlight: (id, data) => send(`/api/books/${id}/highlights`, 'POST', data),
  patchHighlight: (hlId, data) => send(`/api/highlights/${hlId}`, 'PATCH', data),
  deleteHighlight: (hlId) => del(`/api/highlights/${hlId}`),

  listBookmarks: (id) => get(`/api/books/${id}/bookmarks`),
  createBookmark: (id, data) => send(`/api/books/${id}/bookmarks`, 'POST', data),
  deleteBookmark: (bmId) => del(`/api/bookmarks/${bmId}`),

  define: (word) => get(`/api/dictionary/${encodeURIComponent(word)}`),

  heartbeat: (bookId, seconds) =>
    send(
      '/api/stats/heartbeat',
      'POST',
      { book_id: bookId, seconds, day: localDay() },
      { keepalive: true }
    ),
  stats: () => get(`/api/stats?today=${localDay()}`),

  /** Upload with progress callback (XHR — fetch has no upload progress). */
  uploadBook: (file, onProgress) =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/books');
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
      });
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(JSON.parse(xhr.responseText));
        } else {
          let detail = `Upload failed (${xhr.status})`;
          try {
            detail = JSON.parse(xhr.responseText).detail || detail;
          } catch {
            /* keep default */
          }
          reject(new Error(detail));
        }
      });
      xhr.addEventListener('error', () => reject(new Error('Network error during upload')));
      const form = new FormData();
      form.append('file', file);
      xhr.send(form);
    }),
};
