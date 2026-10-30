// Локальная копия заметок и состояние окна. Всё лежит в %APPDATA%\Sticker.
const fs = require('fs');
const path = require('path');
const { writeAtomic } = require('./config');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function cleanLines(lines) {
  if (!Array.isArray(lines)) return [];
  return lines
    .filter(l => l && typeof l.text === 'string')
    .map(l => {
      const out = { id: String(l.id || Math.random().toString(36).slice(2)), text: l.text };
      if (l.bold === true) out.bold = true;
      return out;
    });
}

class NotesStore {
  constructor(dir) {
    this.file = path.join(dir, 'notes.json');
    this.backup = path.join(dir, 'notes.backup.json');
    let d = readJson(this.file, null);
    if (!d) d = readJson(this.backup, { updated_at: 0, lines: [] });
    this.data = { updated_at: Number(d.updated_at) || 0, lines: cleanLines(d.lines) };
  }
  // Локальная правка: время берём сейчас.
  setLocal(lines) {
    this.data = { updated_at: Date.now(), lines: cleanLines(lines) };
    this.write();
  }
  // Пришло с сервера: время берём серверное.
  setRemote(d) {
    this.data = { updated_at: Number(d.updated_at) || 0, lines: cleanLines(d.lines) };
    this.write();
  }
  write() {
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.backup);
    writeAtomic(this.file, JSON.stringify(this.data, null, 2));
  }
}

class StateStore {
  constructor(dir) {
    this.file = path.join(dir, 'state.json');
    this.data = readJson(this.file, {});
  }
  set(patch) {
    this.data = { ...this.data, ...patch };
    writeAtomic(this.file, JSON.stringify(this.data, null, 2));
  }
}

module.exports = { NotesStore, StateStore, cleanLines };
