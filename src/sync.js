// Синхронизация с сервером: побеждает версия с более свежим updated_at.
class Sync {
  constructor({ getConfig, notes, onRemote, onStatus }) {
    this.getConfig = getConfig;
    this.notes = notes;
    this.onRemote = onRemote;
    this.onStatus = onStatus;
    this.timer = null;
    this.pushTimer = null;
    this.running = false;
    this.again = false;
    this.status = { state: 'idle', at: null, error: null };
  }

  endpoint() {
    let url = (this.getConfig().server_url || '').trim();
    if (!url) return null;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    if (!/\.php$/i.test(url) && !url.endsWith('/')) url += '/';
    return url;
  }

  start() {
    this.stop();
    const sec = this.getConfig().sync_interval_sec || 30;
    this.timer = setInterval(() => this.run(), sec * 1000);
    this.run();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  // После локальной правки отправляем чуть позже, чтобы не слать каждую букву.
  schedulePush() {
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => this.run(), 1500);
  }

  async run() {
    if (this.running) { this.again = true; return; }
    this.running = true;
    try {
      await this.once();
      this.setStatus({ state: 'ok', at: Date.now(), error: null });
    } catch (e) {
      let msg = e.message || String(e);
      if (e.name === 'TimeoutError') msg = 'сервер не ответил за 10 секунд';
      else if (msg === 'fetch failed') msg = 'сервер недоступен';
      else if (/\b40[13]\b/.test(msg)) msg = 'неверный api_key';
      this.setStatus({ state: 'error', at: this.status.at, error: msg });
    } finally {
      this.running = false;
      if (this.again) { this.again = false; this.run(); }
    }
  }

  async once() {
    const url = this.endpoint();
    if (!url) throw new Error('не задан server_url');
    const headers = { 'X-Api-Key': this.getConfig().api_key, 'Content-Type': 'application/json' };

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`сервер ответил ${res.status}`);
    const remote = await res.json();
    const remoteAt = Number(remote.updated_at) || 0;
    const localAt = this.notes.data.updated_at;

    if (remoteAt > localAt) {
      this.notes.setRemote(remote);
      this.onRemote(this.notes.data);
    } else if (localAt > remoteAt) {
      const put = await fetch(url, {
        method: 'POST', headers, body: JSON.stringify(this.notes.data), signal: AbortSignal.timeout(10000),
      });
      if (!put.ok) throw new Error(`сохранение на сервер: ${put.status}`);
      // Сервер отказал: у него версия не старше нашей — сразу заберём её следующим проходом.
      const ans = await put.json().catch(() => ({}));
      if (ans.ok === false) this.again = true;
    }
  }

  setStatus(s) {
    this.status = s;
    this.onStatus(s);
  }
}

module.exports = { Sync };
