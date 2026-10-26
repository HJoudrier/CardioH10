/* Alertes de fréquence cardiaque côté spectateur.
 *
 * Une alarme (sonnerie + notification + vibration) se déclenche quand la FC reste hors de [min, max]
 * pendant HOLD_MS. Elle n'est évaluée que si le capteur est réellement connecté : lien avec le poste
 * distant établi, capteur connecté d'après le poste distant, et mesures de FC fraîches.
 * Sans capteur connecté, aucune alerte ne se déclenche et une alarme en cours est coupée.
 */
(function (global) {
  'use strict';

  const KEY = 'cardioh10.alerts';
  const HOLD_MS = 3000;     // durée hors limites avant déclenchement (évite les valeurs isolées)
  const STALE_MS = 10000;   // sans mesure de FC pendant ce délai : signal perdu
  const SNOOZE_MS = 60000;  // « Acquitter » coupe l'alarme pendant ce délai si la FC reste hors limites
  const FC_MIN = 20, FC_MAX = 250;
  const DEFAULTS = { enabled: false, min: 50, max: 120, sound: true, notif: true };

  function load() {
    try {
      const v = JSON.parse(localStorage.getItem(KEY));
      if (v && typeof v === 'object') return Object.assign({}, DEFAULTS, v);
    } catch (e) { /* ignoré */ }
    return Object.assign({}, DEFAULTS);
  }

  function save(cfg) {
    try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (e) { /* ignoré */ }
  }

  /** Message d'erreur si les limites sont inutilisables, sinon ''. */
  function validate(cfg) {
    const { min, max } = cfg;
    if (!Number.isFinite(min) || !Number.isFinite(max)) return 'Renseignez FC min et FC max.';
    if (min < FC_MIN || max > FC_MAX) return 'Les limites doivent être comprises entre ' + FC_MIN + ' et ' + FC_MAX + ' bpm.';
    if (min >= max) return 'FC min doit être inférieure à FC max.';
    return '';
  }

  /* ---------- Sonnerie ---------- */

  class Siren {
    constructor() { this.ctx = null; this.timer = null; }

    /** À appeler depuis un geste de l'utilisateur : les navigateurs interdisent le son sinon. */
    unlock() {
      try {
        if (!this.ctx) {
          const AC = global.AudioContext || global.webkitAudioContext;
          if (!AC) return false;
          this.ctx = new AC();
        }
        if (this.ctx.state !== 'running') this.ctx.resume();
        return true;
      } catch (e) { return false; }
    }

    get ready() { return !!this.ctx && this.ctx.state === 'running'; }

    beep() {
      const c = this.ctx;
      if (!c || c.state !== 'running') return;
      const t = c.currentTime;
      for (let i = 0; i < 3; i++) {
        const t0 = t + i * 0.25;
        const o = c.createOscillator();
        const g = c.createGain();
        o.type = 'square';
        o.frequency.value = 988;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.4, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
        o.connect(g);
        g.connect(c.destination);
        o.start(t0);
        o.stop(t0 + 0.22);
      }
    }

    start() {
      if (this.timer) return;
      this.beep();
      this.timer = setInterval(() => this.beep(), 1500);
    }

    stop() {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /* ---------- Notification ---------- */

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  /** Via le service worker (seul moyen sur Android), sinon directement. */
  async function notify(title, body) {
    if (!('Notification' in global) || Notification.permission !== 'granted') return;
    const opts = {
      body, tag: 'cardioh10-alerte', renotify: true, requireInteraction: true,
      vibrate: [300, 150, 300, 150, 300],
    };
    try {
      if (navigator.serviceWorker) {
        const reg = await Promise.race([navigator.serviceWorker.ready, sleep(1500)]);
        if (reg && reg.showNotification) { await reg.showNotification(title, opts); return; }
      }
    } catch (e) { /* repli ci-dessous */ }
    try { new Notification(title, opts); } catch (e) { /* non supporté */ }
  }

  /* ---------- Surveillance ---------- */

  class Monitor {
    /** @param o {onUpdate(view)} appelé chaque seconde et à chaque changement */
    constructor(o) {
      this.o = o;
      this.cfg = load();
      this.siren = new Siren();
      this.link = false;      // lien avec le poste distant
      this.live = false;      // capteur connecté d'après le poste distant
      this.liveSince = 0;
      this.hr = null;
      this.hrAt = 0;
      this.breach = null;     // 'low' | 'high' | null
      this.since = 0;
      this.ringing = false;
      this.snoozeUntil = 0;
      this.timer = setInterval(() => this.eval(), 1000);
      this.eval();
    }

    setLink(ok) {
      this.link = !!ok;
      if (!ok) this.hr = null;
      this.eval();
    }

    setLive(live) {
      live = !!live;
      if (live && !this.live) this.liveSince = Date.now();
      this.live = live;
      if (!live) this.hr = null;
      this.eval();
    }

    setHr(hr) {
      this.hr = Number.isFinite(hr) ? hr : null;
      this.hrAt = Date.now();
      this.eval();
    }

    setConfig(patch) {
      this.cfg = Object.assign({}, this.cfg, patch);
      save(this.cfg);
      this.eval();
    }

    ack() {
      if (!this.ringing) return;
      this.snoozeUntil = Date.now() + SNOOZE_MS;
      this.eval();
    }

    /** Sonnerie + notification d'essai, pour vérifier que l'appareil est bien réglé. */
    test() {
      this.siren.unlock();
      this.siren.beep();
      notify('Test d\'alerte CardioH10', 'Les alertes de fréquence cardiaque s\'afficheront ainsi.');
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    }

    eval() {
      const now = Date.now();
      const cfg = this.cfg;
      let sensor;
      if (!this.link) sensor = 'unknown';
      else if (!this.live) sensor = 'off';
      else if (now - Math.max(this.hrAt, this.liveSince) > STALE_MS) sensor = 'stale';
      else sensor = 'ok';

      const hr = sensor === 'ok' && this.hr > 0 ? this.hr : null;
      const error = validate(cfg);
      let breach = null;
      if (cfg.enabled && !error && hr !== null) breach = hr < cfg.min ? 'low' : hr > cfg.max ? 'high' : null;
      if (breach !== this.breach) { this.breach = breach; this.since = now; this.snoozeUntil = 0; }

      const ringing = !!breach && now - this.since >= HOLD_MS && now >= this.snoozeUntil;
      if (ringing && !this.ringing) this._fire(breach, hr);
      if (!ringing && this.ringing) this.siren.stop();
      this.ringing = ringing;

      this.o.onUpdate({
        cfg, error, sensor, hr, breach, ringing,
        snoozed: !!breach && now - this.since >= HOLD_MS && now < this.snoozeUntil,
        snoozeLeft: Math.max(0, Math.ceil((this.snoozeUntil - now) / 1000)),
        audioReady: this.siren.ready,
        permission: 'Notification' in global ? Notification.permission : 'unsupported',
      });
    }

    _fire(breach, hr) {
      const cfg = this.cfg;
      const body = breach === 'low'
        ? 'FC basse : ' + hr + ' bpm (limite ' + cfg.min + ' bpm)'
        : 'FC élevée : ' + hr + ' bpm (limite ' + cfg.max + ' bpm)';
      if (cfg.sound) this.siren.start();
      if (cfg.notif) notify('Alerte fréquence cardiaque', body);
      if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 400]);
    }
  }

  const ns = (global.CardioH10 = global.CardioH10 || {});
  ns.Alerts = { Monitor, validate, FC_MIN, FC_MAX, HOLD_MS, STALE_MS, SNOOZE_MS };
})(window);
