// Shared helpers used by the library view and all three reader engines.

export const HL_COLORS = {
  yellow: '#f2c94c',
  green: '#6fcf97',
  blue: '#56ccf2',
  pink: '#f2789f',
};

export const FONT_STACKS = {
  serif: 'Georgia, "Iowan Old Style", "Times New Roman", serif',
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  mono: '"SF Mono", "Cascadia Code", Menlo, Consolas, monospace',
};

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

export function debounce(fn, ms) {
  let t = null;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function fmtDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function relTime(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function hashHue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

const WORD_CHAR = /[\p{L}\p{N}'’-]/u;

/**
 * Find the word under a point inside `doc` (works for the main document and
 * for epub.js iframes). Returns {word, rect} in that document's client
 * coordinates, or null when the point isn't actually on a word.
 */
export function wordAtPoint(doc, x, y) {
  let node;
  let offset;
  if (doc.caretPositionFromPoint) {
    const pos = doc.caretPositionFromPoint(x, y);
    if (!pos) return null;
    node = pos.offsetNode;
    offset = pos.offset;
  } else if (doc.caretRangeFromPoint) {
    const range = doc.caretRangeFromPoint(x, y);
    if (!range) return null;
    node = range.startContainer;
    offset = range.startOffset;
  } else {
    return null;
  }
  if (!node || node.nodeType !== Node.TEXT_NODE) return null;

  const text = node.textContent;
  const isWord = (ch) => ch !== undefined && WORD_CHAR.test(ch);
  if (!isWord(text[offset]) && isWord(text[offset - 1])) offset -= 1;
  if (!isWord(text[offset])) return null;

  let start = offset;
  let end = offset;
  while (start > 0 && isWord(text[start - 1])) start--;
  while (end < text.length && isWord(text[end])) end++;

  // The caret APIs snap to the nearest position: reject clicks that landed
  // outside the word's actual boxes (margins, blank space between lines).
  const range = doc.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const rect = [...range.getClientRects()].find(
    (r) => x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2
  );
  if (!rect) return null;

  const word = text.slice(start, end).replace(/^['’\-\d]+|['’\-\d]+$/gu, '');
  if (!word || word.length > 48 || !/\p{L}/u.test(word)) return null;
  return { word, rect };
}

/** Keep a floating element inside the viewport. */
export function placeFloating(el, x, y, { above = false, margin = 10 } = {}) {
  el.style.visibility = 'hidden';
  el.hidden = false;
  const { offsetWidth: w, offsetHeight: h } = el;
  let left = clamp(x - w / 2, margin, window.innerWidth - w - margin);
  let top = above ? y - h - 12 : y + 12;
  if (top < margin) top = y + 12;
  if (top + h > window.innerHeight - margin) top = Math.max(margin, y - h - 12);
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  el.style.visibility = '';
}

export function toast(message, { kind = 'info', timeout = 3200 } = {}) {
  let host = document.getElementById('toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toasts';
    document.body.appendChild(host);
  }
  const item = document.createElement('div');
  item.className = `toast toast-${kind}`;
  item.textContent = message;
  host.appendChild(item);
  setTimeout(() => {
    item.classList.add('gone');
    setTimeout(() => item.remove(), 350);
  }, timeout);
  return item;
}
