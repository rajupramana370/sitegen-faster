// sitegen-faster: a dependency-free, byte-exact reimplementation of makefun-site 1.0.0's build,
// written for speed. run(input) returns the same output tree makefun-site's build returns for
// every input: same pages, same report lines, same bytes. The hot paths differ from the
// reference: bulk HTML escaping with a no-specials fast path, a memoised slugifier with an
// ASCII fast path, first-character dispatch in the Markdown lexer instead of per-line regex
// batteries, a single-pass inline renderer whose finders jump with indexOf, indexOf-scanned
// front matter (no split/join round-trip for the body), and a template renderer that appends
// to a shared parts array instead of concatenating strings node by node.

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `text` with & < > " and ' escaped; the common no-specials case returns the input itself. */
export function escapeHtml(text) {
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) { start = i; break; }
  }
  if (start === -1) return text;
  let out = text.slice(0, start);
  let run = start;
  for (let i = start; i < text.length; i++) {
    const rep = ESCAPES[text[i]];
    if (rep !== undefined) {
      if (i > run) out += text.slice(run, i);
      out += rep;
      run = i + 1;
    }
  }
  if (run < text.length) out += text.slice(run);
  return out;
}

export const SLUG_MAX = 64;

const slugCache = new Map();

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of characters other
 * than a-z and 0-9 one "-", none at either end, at most SLUG_MAX characters (a "-" left at the
 * cut dropped), and "untitled" when nothing is left. Memoised: titles, tags and headings repeat
 * heavily across a site's hundreds of sources.
 */
export function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let out;
  let ascii = true;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 127) { ascii = false; break; }
  if (ascii) {
    // NFKD is the identity on ASCII, and ASCII holds no combining marks.
    out = '';
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === -1) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    out = '';
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  const slug = out === '' ? 'untitled' : out;
  if (slugCache.size < 8192) slugCache.set(text, slug);
  return slug;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
export function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
export function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

// ---------------------------------------------------------------- front matter

export const KEYS = Object.freeze(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const KEYSET = new Set(KEYS);

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) { // "
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw[4] === '-' && raw[7] === '-';
      if (ok) for (const i of [0, 1, 2, 3, 5, 6, 8, 9]) {
        const c = raw.charCodeAt(i);
        if (c < 48 || c > 57) { ok = false; break; }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw === '') return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      // ^[a-z0-9]+(?:-[a-z0-9]+)*$ and at most 64 characters.
      let ok = raw.length >= 1 && raw.length <= 64;
      if (ok) {
        let seg = 0;
        for (let i = 0; i < raw.length; i++) {
          const c = raw.charCodeAt(i);
          if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) seg++;
          else if (c === 45 && seg > 0) seg = 0;
          else { ok = false; break; }
        }
        if (seg === 0) ok = false;
      }
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is
 * refused. `text` has "\n" line ends. Lines are scanned by offset; the body is one slice.
 */
export function parseFrontMatter(text) {
  // Line spans [start, end) without their "\n".
  const spans = [];
  let pos = 0;
  while (true) {
    const nl = text.indexOf('\n', pos);
    if (nl === -1) { spans.push([pos, text.length]); break; }
    spans.push([pos, nl]);
    pos = nl + 1;
    if (pos > text.length) break;
    if (pos === text.length) { spans.push([pos, pos]); break; }
  }
  const lineAt = (i) => text.slice(spans[i][0], spans[i][1]);
  if (lineAt(0) !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < spans.length; i++) {
    if (spans[i][1] - spans[i][0] === 3 && lineAt(i) === '---') { close = i; break; }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lineAt(i);
    // Blank (spaces/tabs only) or a comment.
    let blank = true;
    for (let j = 0; j < line.length; j++) {
      const c = line.charCodeAt(j);
      if (c !== 32 && c !== 9) { blank = false; break; }
    }
    if (blank || line.charCodeAt(0) === 35) continue; // '#'
    // ^([a-z_]+):(?: (.*))?$
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    if (k === 0 || line[k] !== ':') return { error: `line ${i + 1} is not "key: value"` };
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line[k + 1] === ' ') raw = line.slice(k + 2);
    else return { error: `line ${i + 1} is not "key: value"` };
    const key = line.slice(0, k);
    raw = raw.replace(/[ \t]+$/, '');
    if (!KEYSET.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const bodyStart = close + 1 < spans.length ? spans[close + 1][0] : text.length;
  return { data, body: close + 1 < spans.length ? text.slice(bodyStart) : '' };
}

// ---------------------------------------------------------------- markdown

const isBlankLine = (line) => {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
};

/** A fence open: ``` + optional [A-Za-z0-9_+-]* + spaces/tabs. Returns the language or null. */
function fenceOpenOf(line) {
  if (!line.startsWith('```')) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32 || c === 9) i++;
    else return null;
  }
  return lang;
}

/** A fence close: ``` + spaces/tabs only. */
function isFenceClose(line) {
  if (!line.startsWith('```')) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null: 1-6 '#', at least one space/tab, non-empty text. */
function headingOf(line) {
  let depth = 0;
  while (depth < line.length && line[depth] === '#') depth++;
  if (depth === 0 || depth > 6) return null;
  const c = line.charCodeAt(depth);
  if (c !== 32 && c !== 9) return null;
  let end = line.length;
  while (end > depth && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  let start = depth;
  while (start < end && (line.charCodeAt(start) === 32 || line.charCodeAt(start) === 9)) start++;
  if (start >= end) return null;
  return { depth, text: line.slice(start, end) };
}

/** A thematic break: --- or *** then spaces/tabs only. */
function isHr(line) {
  let body = null;
  if (line.startsWith('---')) body = 3;
  else if (line.startsWith('***')) body = 3;
  else return false;
  for (let i = body; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A paragraph line trimmed of spaces and tabs at both ends. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlankLine(line) || fenceOpenOf(line) !== null || headingOf(line) !== null || isHr(line);
}

/** `src`'s block tokens, in order. */
export function lex(src) {
  const lines = src.split('\n');
  const tokens = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlankLine(line)) { i++; continue; }
    const fence = fenceOpenOf(line);
    if (fence !== null) {
      const body = [];
      i++;
      while (i < lines.length && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      tokens.push({ type: 'code', lang: fence, lines: body });
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      tokens.push({ type: 'heading', depth: heading.depth, text: heading.text });
      i++;
      continue;
    }
    if (isHr(line)) { tokens.push({ type: 'hr' }); i++; continue; }
    if (line.charCodeAt(0) === 62) { // '>'
      const body = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        let l = lines[i++];
        l = l.startsWith('> ') ? l.slice(2) : l.slice(1);
        body.push(l);
      }
      tokens.push({ type: 'blockquote', lines: body.map(trimLine).filter((l) => l !== '') });
      continue;
    }
    // Lists: "- " / "* " bullets, or 1-9 digits + ". ".
    let isOrdered = false;
    let start = 1;
    let itemText = null;
    const c0 = line.charCodeAt(0);
    if ((c0 === 45 || c0 === 42) && line[1] === ' ') itemText = line.slice(2);
    else if (c0 >= 48 && c0 <= 57) {
      let d = 0;
      while (d < line.length && d < 9) {
        const c = line.charCodeAt(d);
        if (c >= 48 && c <= 57) d++;
        else break;
      }
      if (d >= 1 && line[d] === '.' && line[d + 1] === ' ') {
        isOrdered = true;
        start = Number(line.slice(0, d));
        itemText = line.slice(d + 2);
      }
    }
    if (itemText !== null) {
      const items = [[trimLine(itemText)]];
      i++;
      while (i < lines.length) {
        const l = lines[i];
        let next = null;
        if (isOrdered) {
          if (l.charCodeAt(0) >= 48 && l.charCodeAt(0) <= 57) {
            let d = 0;
            while (d < l.length && d < 9) {
              const c = l.charCodeAt(d);
              if (c >= 48 && c <= 57) d++;
              else break;
            }
            if (d >= 1 && l[d] === '.' && l[d + 1] === ' ') next = l.slice(d + 2);
          }
        } else if ((l.charCodeAt(0) === 45 || l.charCodeAt(0) === 42) && l[1] === ' ') next = l.slice(2);
        if (next !== null) { items.push([trimLine(next)]); i++; continue; }
        // A continuation: two or more spaces then a non-whitespace character.
        if (l.charCodeAt(0) === 32 && l.charCodeAt(1) === 32) {
          let j = 2;
          while (j < l.length && l.charCodeAt(j) === 32) j++;
          if (j < l.length && !/\s/.test(l[j])) { items[items.length - 1].push(trimLine(l)); i++; continue; }
        }
        break;
      }
      tokens.push({ type: 'list', ordered: isOrdered, start, items: items.map((parts) => parts.join('\n')) });
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    tokens.push({ type: 'paragraph', text: body.join('\n') });
  }
  return tokens;
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const w0 = what[0];
  let j = from;
  while (j <= s.length - what.length) {
    const b = s.indexOf('\\', j);
    const t = s.indexOf(w0, j);
    if (t === -1) return -1;
    if (b === -1 || t < b) {
      if (s.startsWith(what, t)) return t;
      j = t + 1;
      continue;
    }
    // The backslash comes first: an escape pair swallows the next character.
    if (b + 1 < s.length && ESCAPABLE.has(s[b + 1])) { j = b + 2; continue; }
    j = b + 1;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = from;
  while (j < s.length) {
    const b = s.indexOf('\\', j);
    const t = s.indexOf('*', j);
    if (t === -1) return -1;
    if (b === -1 || t < b) {
      if (s[t + 1] === '*') { j = t + 2; continue; }
      return t;
    }
    if (b + 1 < s.length && ESCAPABLE.has(s[b + 1])) { j = b + 2; continue; }
    j = b + 1;
  }
  return -1;
}

/** `s` rendered inline; `env.link(target)` is a link's href. */
export function inline(s, env) {
  const out = [];
  let i = 0;
  let runStart = 0; // start of the current plain run, escaped in bulk when flushed
  const flush = (end) => { if (end > runStart) out.push(escapeHtml(s.slice(runStart, end))); };
  while (i < s.length) {
    const c = s[i];
    if (c !== '\\' && c !== '`' && c !== '*' && c !== '[') {
      // Plain run: jump straight to the next character that can open a construct.
      let next = s.length;
      for (const special of ['\\', '`', '*', '[']) {
        const at = s.indexOf(special, i + 1);
        if (at !== -1 && at < next) next = at;
      }
      i = next;
      continue;
    }
    if (c === '\\' && i + 1 < s.length && ESCAPABLE.has(s[i + 1])) {
      flush(i);
      out.push(escapeHtml(s[i + 1]));
      i += 2;
      runStart = i;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        flush(i);
        out.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        i = j + 1;
        runStart = i;
      } else i++;
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          flush(i);
          out.push('<strong>', inline(s.slice(i + 2, j), env), '</strong>');
          i = j + 2;
          runStart = i;
        } else i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        flush(i);
        out.push('<em>', inline(s.slice(i + 1, j), env), '</em>');
        i = j + 1;
        runStart = i;
      } else i++;
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        flush(i);
        out.push(`<a href="${escapeHtml(env.link(target))}">`, inline(s.slice(i + 1, k), env), '</a>');
        i = m + 1;
        runStart = i;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  flush(s.length);
  return out.join('');
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of
 * contents (every level 2 and 3 heading: level, id and its inline HTML) and its excerpt (the
 * first paragraph's inline HTML, or "").
 */
export function renderMarkdown(src, env) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  for (const t of lex(src)) {
    switch (t.type) {
      case 'heading': {
        const id = uniqueSlug(slugify(t.text), ids);
        const html = inline(t.text, env);
        blocks.push(`<h${t.depth} id="${id}">${html}</h${t.depth}>`);
        if (t.depth === 2 || t.depth === 3) toc.push({ level: t.depth, id, html });
        break;
      }
      case 'code': {
        const cls = t.lang === '' ? '' : ` class="language-${escapeHtml(t.lang)}"`;
        let inner = '';
        for (const l of t.lines) inner += `${escapeHtml(l)}\n`;
        blocks.push(`<pre><code${cls}>${inner}</code></pre>`);
        break;
      }
      case 'hr':
        blocks.push('<hr>');
        break;
      case 'blockquote':
        blocks.push(t.lines.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(t.lines.join('\n'), env)}</p>\n</blockquote>`);
        break;
      case 'list': {
        const tag = t.ordered ? 'ol' : 'ul';
        const open = t.ordered && t.start !== 1 ? `<ol start="${t.start}">` : `<${tag}>`;
        let inner = '';
        for (const item of t.items) inner += `<li>${inline(item, env)}</li>\n`;
        blocks.push(`${open}\n${inner}</${tag}>`);
        break;
      }
      case 'paragraph': {
        const html = inline(t.text, env);
        if (excerpt === null) excerpt = html;
        blocks.push(`<p>${html}</p>`);
        break;
      }
    }
  }
  let html = '';
  for (const b of blocks) html += `${b}\n`;
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

export const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

export class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    let standalone = true;
    for (let j = lineStart; j < open; j++) {
      const c = src.charCodeAt(j);
      if (c !== 32 && c !== 9) { standalone = false; break; }
    }
    if (standalone) for (let j = end; j < lineEnd; j++) {
      const c = src.charCodeAt(j);
      if (c !== 32 && c !== 9) { standalone = false; break; }
    }
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
export function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  const head = path[0];
  while (s !== null && !Object.hasOwn(s.vars, head)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[head];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered into the shared `out` parts array in `scope` ({ vars, parent }). `ctx` holds
 * the parsed templates (a Map of name to nodes), the HTML escape and the include depth.
 */
export function renderNodes(nodes, scope, ctx, depth, out) {
  for (let idx = 0; idx < nodes.length; idx++) {
    const n = nodes[idx];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(ctx.escape(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        for (let k = 0; k < len; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === len - 1, length: len } };
          renderNodes(n.body, { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- build

export const REPORT_FILE = 'build-report.txt';
export const RESERVED = Object.freeze(['posts', 'tags', 'page']);

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 || (c >= 0xA0 && /\s/.test(text[i]));
    if (!ws && !inWord) { count++; inWord = true; }
    else if (ws) inWord = false;
  }
  return count;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** One site's output tree: path -> text. The same pipeline as makefun-site 1.0.0, in order. */
export function build(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const output = {};
  const broken = new Set();

  // 1. Sources in code-unit order of path; .md line ends made "\n"; anything else static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter and the refusal chain, in order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push(`refused ${s.path}: ${fm.error}`); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) { report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
    kept.push(s);
  }

  // 3. Permalinks: slug unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), taken.get(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, links resolved (resolutions memoised per case).
  const staticPaths = new Set(statics.map((f) => f.path));
  const resolveCache = new Map();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const key = `${dir}\n${target}`;
        const hit = resolveCache.get(key);
        if (hit !== undefined) {
          if (hit === null) broken.add(`broken-link ${s.path} -> ${target}`);
          return hit === null ? target : hit;
        }
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        let resolved = null;
        if (path !== null && bySource.has(path)) resolved = `${bySource.get(path).url}${frag}`;
        else if (path !== null && staticPaths.has(path)) resolved = `${base}/${path}${frag}`;
        resolveCache.set(key, resolved);
        if (resolved === null) {
          broken.add(`broken-link ${s.path} -> ${target}`);
          return target;
        }
        return resolved;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: posts newest first, equal dates by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    return (s.data.tags ?? []).filter((name) => {
      const slug = slugify(name);
      if (seen.has(slug)) return false;
      seen.add(slug);
      return true;
    });
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) if (!s.post) {
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Layouts.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates, escape: escapeHtml };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const parts = [];
    renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, parts);
    return parts.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}

/** makefun-site 1.0.0's answer for one case's input, computed faster. */
export function run(input) {
  return build(input);
}
