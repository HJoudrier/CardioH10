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

  /* ---------- Sonnerie et maintien en arrière-plan ----------
   *
   * Une page web est gelée par le navigateur quand l'écran se verrouille ou que l'onglet passe en
   * arrière-plan, sauf si elle lit un média. Tant que les alertes sont actives, un élément <audio>
   * lit donc en boucle un signal inaudible (mode « veille ») ; en cas d'alarme, il bascule sur la
   * sonnerie. Un seul élément, démarré par un geste de l'utilisateur, évite le blocage d'autoplay
   * quand l'alarme se déclenche plus tard, écran verrouillé.
   */

  const RATE = 8000;

  function wavUrl(samples) {
    const n = samples.length;
    const buf = new ArrayBuffer(44 + n * 2);
    const dv = new DataView(buf);
    const str = (o, t) => { for (let i = 0; i < t.length; i++) dv.setUint8(o + i, t.charCodeAt(i)); };
    str(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, RATE, true); dv.setUint32(28, RATE * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    str(36, 'data'); dv.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.round(samples[i] * 32767), true);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }

  /** Veille : sinusoïde de 20 Hz à très faible niveau (inaudible, mais pas un silence numérique). */
  function quietSamples() {
    const a = new Float32Array(RATE * 2);
    for (let i = 0; i < a.length; i++) a[i] = 0.02 * Math.sin(2 * Math.PI * 20 * i / RATE);
    return a;
  }

  /** Sonnerie : trois bips à 988 Hz puis un silence, 1,5 s en boucle. */
  function alarmSamples() {
    const a = new Float32Array(Math.round(RATE * 1.5));
    for (let k = 0; k < 3; k++) {
      const t0 = Math.round(k * 0.25 * RATE);
      const len = Math.round(0.2 * RATE);
      for (let i = 0; i < len; i++) {
        const env = Math.min(1, i / (0.01 * RATE), (len - i) / (0.01 * RATE));
        a[t0 + i] = 0.8 * env * (Math.sin(2 * Math.PI * 988 * i / RATE) > 0 ? 1 : -1);
      }
    }
    return a;
  }

  class Siren {
    /** @param onPauseAction appelé si l'utilisateur appuie sur « pause » dans les commandes média */
    constructor(onPauseAction) {
      this.onPauseAction = onPauseAction;
      this.el = null;
      this.urls = null;
      this.mode = 'off';      // 'off' | 'quiet' | 'alarm'
      this.alarmOn = false;
      this.testTimer = null;
    }

    _init() {
      if (this.el) return true;
      try {
        this.urls = { quiet: wavUrl(quietSamples()), alarm: wavUrl(alarmSamples()) };
        const a = new Audio();
        a.loop = true;
        a.preload = 'auto';
        a.setAttribute('playsinline', '');
        this.el = a;
        if ('mediaSession' in navigator) {
          navigator.mediaSession.metadata = new global.MediaMetadata({ title: 'Surveillance de la fréquence cardiaque', artist: 'CardioH10' });
          navigator.mediaSession.setActionHandler('pause', () => { if (this.onPauseAction) this.onPauseAction(); this.resume(); });
        }
        return true;
      } catch (e) { return false; }
    }

    _play(mode) {
      if (!this.el) return;
      if (this.mode !== mode) { this.mode = mode; this.el.src = this.urls[mode]; }
      try {
        const p = this.el.play();
        if (p && p.catch) p.catch(() => { /* bloqué : se relancera au prochain geste */ });
      } catch (e) { /* ignoré */ }
    }

    /** À appeler depuis un geste de l'utilisateur : démarre le mode veille (page maintenue en vie). */
    unlock() {
      if (!this._init()) return false;
      if (this.mode === 'off') this._play('quiet');
      else if (this.el.paused) this._play(this.mode);
      return true;
    }

    /** Arrête tout (alertes désactivées). */
    release() {
      clearTimeout(this.testTimer);
      this.alarmOn = false;
      if (!this.el) return;
      this.el.pause();
      this.mode = 'off';
      try { if ('mediaSession' in navigator) navigator.mediaSession.metadata = null; } catch (e) { /* ignoré */ }
    }

    /** Relance la lecture si le système l'a interrompue (appel téléphonique, etc.). */
    resume() {
      if (this.el && this.mode !== 'off' && this.el.paused) this._play(this.mode);
    }

    get ready() { return !!this.el && this.mode !== 'off' && !this.el.paused; }

    /** Sonnerie brève d'essai. */
    beep() {
      if (!this.unlock()) return;
      this._play('alarm');
      clearTimeout(this.testTimer);
      this.testTimer = setTimeout(() => { if (!this.alarmOn && this.mode === 'alarm') this._play('quiet'); }, 1600);
    }

    start() {
      if (!this._init()) return;
      this.alarmOn = true;
      this._play('alarm');
    }

    stop() {
      this.alarmOn = false;
      if (this.mode === 'alarm') this._play('quiet');
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
      this.siren = new Siren(() => this.ack());
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
      if (!this.cfg.enabled) this.siren.release();
      this.eval();
    }

    ack() {
      if (!this.ringing) return;
      this.snoozeUntil = Date.now() + SNOOZE_MS;
      this.eval();
    }

    /** Sonnerie + notification d'essai, pour vérifier que l'appareil est bien réglé. */
    test() {
      this.siren.beep();
      // alertes désactivées : l'essai ne doit pas laisser la lecture de veille en route
      if (!this.cfg.enabled) setTimeout(() => { if (!this.cfg.enabled) this.siren.release(); }, 1800);
      notify('Test d\'alerte CardioH10', 'Les alertes de fréquence cardiaque s\'afficheront ainsi.');
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    }

    eval() {
      const now = Date.now();
      if (this.cfg.enabled) this.siren.resume();
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
