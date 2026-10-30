const paper = document.getElementById('paper');
const syncDot = document.getElementById('sync');

let lines = [];
let cfg = null;
let active = false;
let focusedAt = 0;
let editing = null;       // { id, isNew }
let pendingRemote = null; // пришло с сервера во время редактирования

const BINDING_H = 34;
const PAPER_PAD = 20;

// ---------- Цвета из одного hex ----------
function hexToHsl(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16) / 255, g = parseInt(h.slice(2, 4), 16) / 255, b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let hue = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    hue = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    hue *= 60;
  }
  return [hue, s * 100, l * 100];
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const hsl = (h, s, l, a = 1) => `hsla(${(h + 360) % 360}, ${clamp(s, 0, 100)}%, ${clamp(l, 0, 100)}%, ${a})`;

function palette(hex, theme) {
  const [h, s, l] = hexToHsl(hex);
  if (theme === 'dark') {
    return {
      field: hsl(h, s * 0.3, 15),
      binding: hsl(h, s * 0.35, 9),
      rule: hsl(h, s * 0.4, 24),
      margin: hsl(h - 20, s * 0.55, 34, 0.75),
      ink: hsl(h, s * 0.45, 87),
      'ink-soft': hsl(h, s * 0.3, 55),
      edge: hsl(h, s, Math.max(l, 62)),
      hover: hsl(h, s * 0.5, 40, 0.25),
      error: '#FF8A7A',
      strong: '#FFFFFF',
    };
  }
  const lightPaper = l >= 50;
  return {
    field: hsl(h, s, l),
    binding: hsl(h, s + 8, l - 16),
    rule: hsl(h, s, l - 13, 0.8),
    margin: hsl(h - 20, s + 10, l - 30, 0.5),
    ink: lightPaper ? hsl(h, Math.min(s, 40), 14) : hsl(h, 30, 94),
    'ink-soft': lightPaper ? hsl(h, Math.min(s, 30), 38) : hsl(h, 20, 75),
    edge: lightPaper ? hsl(h, s + 5, Math.max(l - 54, 10)) : hsl(h, s, Math.min(l + 45, 90)),
    hover: hsl(h, s, l - 22, 0.25),
    error: '#A3271A',
    strong: lightPaper ? '#000000' : '#FFFFFF',
  };
}

function applyConfig(c) {
  cfg = c;
  const root = document.documentElement.style;
  for (const [k, v] of Object.entries(palette(c.color, c.theme))) root.setProperty('--' + k, v);
  root.setProperty('--font', `"${c.font_main}", "Segoe UI", sans-serif`);
  root.setProperty('--fs', c.font_size + 'px');
  root.setProperty('--lh', c.line_height + 'px');
  root.setProperty('--op-field', c.opacity_idle);
  root.setProperty('--op-binding', c.binding_opacity_idle);
  render();
}

// ---------- Отрисовка ----------
let rendering = false;
function render() {
  if (!cfg) return;
  rendering = true; // перерисовка снимает фокус со старого поля — это не должно завершать редактирование
  paper.textContent = '';

  if (lines.length === 0) {
    const row = document.createElement('div');
    row.className = 'row';
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Пусто. Нажми + чтобы добавить строку';
    row.append(empty);
    paper.append(row);
  }

  for (const line of lines) {
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.id = line.id;
    if (line.bold) row.classList.add('bold');

    if (editing && editing.id === line.id) {
      row.classList.add('editing');
      const input = document.createElement('input');
      input.className = 'edit';
      input.value = line.text;
      input.spellcheck = false;
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commitAndNext(input.value); }
        else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.ctrlKey && !e.altKey && !e.shiftKey) {
          e.preventDefault();
          moveLine(line.id, e.key === 'ArrowUp' ? -1 : 1, input);
        }
        // e.code, а не e.key — чтобы работало и в русской раскладке
        else if (e.ctrlKey && !e.altKey && e.code === 'KeyB') { e.preventDefault(); toggleBold(line.id, input); }
      });
      input.addEventListener('blur', () => {
        if (!rendering && input.isConnected && editing && editing.id === line.id) commit(input.value);
      });
      row.append(input);
      const caret = editing.caret ?? input.value.length;
      requestAnimationFrame(() => { input.focus(); input.setSelectionRange(caret, caret); });
    } else {
      const text = document.createElement('div');
      text.className = 'text';
      text.textContent = line.text;
      text.addEventListener('click', () => {
        if (!active || Date.now() - focusedAt < 250) return; // первый клик только активирует стикер
        startEdit(line.id, false);
      });
      row.append(text);
    }

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '−';
    del.title = 'Двойной клик — удалить';
    del.tabIndex = -1;
    del.addEventListener('dblclick', () => removeLine(line.id, row));
    row.append(del);

    paper.append(row);
  }

  rendering = false;
  markClipped();
  fit();
}

// Длинные строки обрезаются; полный текст — во всплывающей подсказке, только у активного стикера.
function markClipped() {
  for (const el of paper.querySelectorAll('.text')) {
    const clipped = el.scrollWidth > el.clientWidth + 1;
    el.classList.toggle('clipped', clipped);
    if (clipped && active) el.title = el.textContent; else el.removeAttribute('title');
  }
}

function fit() {
  const rows = Math.max(lines.length, 1);
  window.api.resize(BINDING_H + rows * cfg.line_height + PAPER_PAD);
}

// ---------- Действия ----------
function save() {
  window.api.setNotes(lines);
}

function startEdit(id, isNew) {
  editing = { id, isNew };
  render();
}

function commit(value) {
  if (!editing) return;
  const { id } = editing;
  editing = null;
  const text = value.replace(/\s+$/, '');
  const i = lines.findIndex(l => l.id === id);
  if (i >= 0) {
    if (text.trim() === '') lines.splice(i, 1);
    else lines[i] = { ...lines[i], text };
  }
  save();
  afterEdit();
}

// Enter: сохраняет строку и сразу открывает новую под ней. На пустой строке — просто выходит из редактирования.
function commitAndNext(value) {
  if (!editing) return;
  const id = editing.id;
  if (value.trim() === '') { commit(value); return; }
  commit(value);
  const i = lines.findIndex(l => l.id === id);
  const nid = crypto.randomUUID();
  lines.splice(i + 1, 0, { id: nid, text: '' });
  startEdit(nid, true);
}

// Стрелки вверх/вниз в редактируемой строке переставляют её; редактирование и курсор сохраняются.
function moveLine(id, dir, input) {
  const i = lines.findIndex(l => l.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= lines.length) return;
  lines[i] = { ...lines[i], text: input.value };
  [lines[i], lines[j]] = [lines[j], lines[i]];
  editing = { ...editing, caret: input.selectionStart };
  if (input.value.trim() !== '') save();
  render();
}

// Ctrl+B: строка становится чёрной и жирнее, повторно — обратно.
function toggleBold(id, input) {
  const i = lines.findIndex(l => l.id === id);
  if (i < 0) return;
  const { bold, ...rest } = lines[i];
  lines[i] = bold ? { ...rest, text: input.value } : { ...rest, text: input.value, bold: true };
  editing = { ...editing, caret: input.selectionStart };
  if (input.value.trim() !== '') save();
  render();
}

function cancel() {
  if (!editing) return;
  const { id, isNew } = editing;
  editing = null;
  if (isNew) { lines = lines.filter(l => l.id !== id); save(); }
  afterEdit();
}

function afterEdit() {
  if (pendingRemote) { lines = pendingRemote.lines; pendingRemote = null; }
  render();
}

function addLine() {
  if (editing) {
    const input = paper.querySelector('.edit');
    commit(input ? input.value : '');
  }
  const id = crypto.randomUUID();
  lines.push({ id, text: '' });
  startEdit(id, true);
}

function removeLine(id, row) {
  row.classList.add('removing');
  setTimeout(() => {
    lines = lines.filter(l => l.id !== id);
    if (editing && editing.id === id) editing = null;
    save();
    render();
  }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180);
}

function setActive(v) {
  active = v;
  if (v) focusedAt = Date.now();
  document.body.classList.toggle('active', v);
  if (!v && editing) {
    const input = paper.querySelector('.edit');
    commit(input ? input.value : '');
  }
  markClipped();
}

function showSync(s) {
  if (!s) return;
  syncDot.className = 'sync ' + (s.state === 'ok' ? 'ok' : s.state === 'error' ? 'error' : '');
  const time = s.at ? new Date(s.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : null;
  syncDot.title = s.state === 'ok'
    ? `Синхронизировано в ${time}`
    : s.state === 'error'
      ? `Нет связи с сервером: ${s.error}${time ? `. Последняя синхронизация в ${time}` : ''}. Заметки сохранены локально.`
      : 'Синхронизация ещё не выполнялась';
}

// ---------- Кнопки переплёта ----------
document.getElementById('add').addEventListener('click', addLine);
document.getElementById('hide').addEventListener('click', () => window.api.hide());
document.getElementById('theme').addEventListener('click', () => window.api.toggleTheme());

// Enter на активном стикере без редактирования — новая строка в конце.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && active && !editing && !(e.target instanceof HTMLButtonElement)) {
    e.preventDefault();
    addLine();
  }
});

// ---------- События из main ----------
window.api.on('active', setActive);
window.api.on('config', applyConfig);
window.api.on('sync', showSync);
window.api.on('notes', (data) => {
  if (editing) pendingRemote = data;
  else { lines = data.lines; render(); }
});

window.api.init().then(({ config, notes, sync }) => {
  lines = notes.lines;
  setActive(document.hasFocus());
  applyConfig(config);
  showSync(sync);
});
