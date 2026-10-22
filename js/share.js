/* Partage du tracé en direct, de poste à poste (WebRTC via PeerJS).
 *
 * Les données ECG circulent directement entre les deux navigateurs, chiffrées (DTLS).
 * Le serveur de signalisation public de PeerJS ne sert qu'à mettre les deux postes en relation
 * (il voit l'identifiant du partage, pas les mesures).
 *
 * Messages (JSON) du diffuseur vers le spectateur :
 *   {t:'hello', fs, live, name}   à la connexion
 *   {t:'ecg', s:[µV,…]}           échantillons ECG
 *   {t:'hr', hr, rr:[ms,…]}       fréquence cardiaque
 *   {t:'state', live}             capteur connecté ou non
 *   {t:'info', name}              nom affiché
 */
(function (global) {
  'use strict';

  const ID_RE = /^ch10-[a-z0-9]{12}$/;

  function randomId() {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const r = crypto.getRandomValues(new Uint8Array(12));
    return 'ch10-' + Array.from(r, (v) => alphabet[v % 36]).join('');
  }

  /** Options PeerJS ; surchargeables via window.CARDIOH10_PEER (serveur de signalisation, TURN…). */
  function peerOptions() { return Object.assign({ debug: 0 }, global.CARDIOH10_PEER); }

  function available() { return typeof global.Peer === 'function'; }

  /* ---------- Côté poste équipé du capteur ---------- */

  class Broadcaster {
    /**
     * @param o {getInfo(): {fs, live, name}, getBuffer(): number[], onViewers(n), onError(msg)}
     */
    constructor(o) {
      this.o = o;
      this.conns = new Set();
      this.peer = null;
      this.id = null;
      this.closed = false;
    }

    start() {
      return new Promise((resolve, reject) => {
        let opened = false;
        const id = randomId();
        const peer = new global.Peer(id, peerOptions());
        this.peer = peer;
        peer.on('open', () => { opened = true; this.id = id; resolve(id); });
        peer.on('error', (e) => {
          if (!opened) { reject(new Error(explain(e))); return; }
          if (e.type !== 'peer-unavailable') this.o.onError(explain(e));
        });
        // perte du serveur de signalisation : les spectateurs déjà connectés ne sont pas affectés,
        // mais le lien ne fonctionnerait plus pour de nouveaux venus
        peer.on('disconnected', () => {
          if (!this.closed && !peer.destroyed) setTimeout(() => { try { peer.reconnect(); } catch (e) { /* ignoré */ } }, 2000);
        });
        peer.on('connection', (conn) => {
          conn.on('open', () => {
            this.conns.add(conn);
            const info = this.o.getInfo();
            conn.send({ t: 'hello', fs: info.fs, live: info.live, name: info.name });
            const buf = this.o.getBuffer();
            if (buf.length) conn.send({ t: 'ecg', s: buf });
            this.o.onViewers(this.conns.size);
          });
          const drop = () => { if (this.conns.delete(conn)) this.o.onViewers(this.conns.size); };
          conn.on('close', drop);
          conn.on('error', drop);
        });
      });
    }

    send(msg) {
      for (const c of this.conns) {
        try { if (c.open) c.send(msg); } catch (e) { /* spectateur déconnecté */ }
      }
    }

    stop() {
      this.closed = true;
      for (const c of this.conns) { try { c.close(); } catch (e) { /* ignoré */ } }
      this.conns.clear();
      if (this.peer) this.peer.destroy();
      this.peer = null;
    }
  }

  /* ---------- Côté spectateur ---------- */

  class Viewer {
    /**
     * @param o {onHello(msg), onEcg(samples), onHr(msg), onState(msg), onInfo(msg), onStatus(texte, ok)}
     */
    constructor(o) {
      this.o = o;
      this.peer = null;
      this.conn = null;
      this.timer = null;
      this.stopped = false;
    }

    connect(id) {
      this.id = id;
      this._open();
    }

    _open() {
      if (this.stopped) return;
      this.o.onStatus('Connexion au poste distant…', false);
      const peer = new global.Peer(peerOptions());
      this.peer = peer;
      peer.on('open', () => {
        const conn = peer.connect(this.id, { serialization: 'json', reliable: true });
        this.conn = conn;
        conn.on('open', () => this.o.onStatus('Connecté au poste distant', true));
        conn.on('data', (m) => this._onData(m));
        conn.on('close', () => this._retry('Connexion perdue, nouvelle tentative…'));
        conn.on('error', () => this._retry('Connexion perdue, nouvelle tentative…'));
      });
      peer.on('error', (e) => {
        this._retry(e.type === 'peer-unavailable'
          ? 'Le partage n\'est pas (ou plus) en ligne. Nouvelle tentative…'
          : explain(e) + ' Nouvelle tentative…');
      });
    }

    _retry(msg) {
      if (this.stopped || this.timer) return;
      this.o.onStatus(msg, false);
      try { if (this.peer) this.peer.destroy(); } catch (e) { /* ignoré */ }
      this.peer = this.conn = null;
      this.timer = setTimeout(() => { this.timer = null; this._open(); }, 4000);
    }

    _onData(m) {
      if (!m || typeof m !== 'object') return;
      const o = this.o;
      switch (m.t) {
        case 'hello': o.onHello(m); break;
        case 'ecg': if (Array.isArray(m.s)) o.onEcg(m.s.filter(Number.isFinite)); break;
        case 'hr': o.onHr({ hr: Number(m.hr), rr: [] }); break;
        case 'state': o.onState(m); break;
        case 'info': o.onInfo(m); break;
        default: break;
      }
    }

    stop() {
      this.stopped = true;
      clearTimeout(this.timer);
      try { if (this.peer) this.peer.destroy(); } catch (e) { /* ignoré */ }
    }
  }

  function explain(e) {
    const t = e && e.type;
    if (t === 'network' || t === 'server-error' || t === 'socket-error' || t === 'socket-closed') {
      return 'Serveur de mise en relation injoignable (réseau).';
    }
    if (t === 'webrtc') return 'Connexion directe impossible (pare-feu ou réseau d\'entreprise).';
    return 'Erreur de partage : ' + ((e && e.message) || t || e);
  }

  /** Dessine le QR code de `text` dans un canvas. */
  function drawQr(canvas, text) {
    const qr = global.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const quiet = 4;
    const cell = Math.max(2, Math.floor(280 / (n + quiet * 2)));
    const size = (n + quiet * 2) * cell;
    canvas.width = canvas.height = size;
    const c = canvas.getContext('2d');
    c.fillStyle = '#fff';
    c.fillRect(0, 0, size, size);
    c.fillStyle = '#000';
    for (let r = 0; r < n; r++) {
      for (let k = 0; k < n; k++) {
        if (qr.isDark(r, k)) c.fillRect((k + quiet) * cell, (r + quiet) * cell, cell, cell);
      }
    }
  }

  const ns = (global.CardioH10 = global.CardioH10 || {});
  ns.Share = { Broadcaster, Viewer, drawQr, available, ID_RE };
})(window);
