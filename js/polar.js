/* Sources de données : Polar H10 (Web Bluetooth) et générateur de démonstration.
 *
 * Les deux sources appellent les mêmes gestionnaires :
 *   onEcg(samples)         tableau d'échantillons ECG en µV (130 Hz)
 *   onHr({hr, rr})         FC (bpm) et intervalles RR (ms) reçus du capteur
 *   onStatus(texte)        message d'état
 *   onBattery(pourcent)
 *   onDisconnect()
 */
(function (global) {
  'use strict';

  const ECG_FS = 130;
  const UUID = {
    hrService: 'heart_rate',
    hrMeasurement: 'heart_rate_measurement',
    battery: 'battery_service',
    batteryLevel: 'battery_level',
    pmdService: 'fb005c80-02e7-f387-1cad-8acd2d8df0c8',
    pmdControl: 'fb005c81-02e7-f387-1cad-8acd2d8df0c8',
    pmdData: 'fb005c82-02e7-f387-1cad-8acd2d8df0c8',
  };

  const PMD_ERRORS = {
    1: 'type de mesure invalide', 2: 'paramètre invalide', 3: 'paramètres non supportés',
    4: 'capteur mal positionné / électrodes sèches', 5: 'mesure déjà en cours (autre application connectée ?)',
    6: 'mesure déjà en cours', 7: 'ressources insuffisantes', 8: 'batterie trop faible',
  };

  function supported() { return !!(global.navigator && navigator.bluetooth); }

  /* ---------- Polar H10 ---------- */

  class PolarH10 {
    constructor(h) {
      this.h = h;
      this.fs = ECG_FS;
      this.device = null;
      this.lastEndMs = null;
      this.lastValue = 0;
      this.name = '';
    }

    async connect() {
      const h = this.h;
      if (!supported()) throw new Error('Web Bluetooth indisponible (utilisez Chrome ou Edge, en HTTPS ou sur localhost).');
      h.onStatus('Recherche du capteur…');
      this.device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'Polar H10' }],
        optionalServices: [UUID.hrService, UUID.battery, UUID.pmdService],
      });
      this.name = this.device.name || 'Polar H10';
      this.device.addEventListener('gattserverdisconnected', () => h.onDisconnect());
      h.onStatus('Connexion à ' + this.name + '…');
      const server = await this.device.gatt.connect();

      try {
        const bs = await server.getPrimaryService(UUID.battery);
        const bc = await bs.getCharacteristic(UUID.batteryLevel);
        h.onBattery((await bc.readValue()).getUint8(0));
      } catch (e) { /* batterie facultative */ }

      // Fréquence cardiaque + intervalles RR
      const hrs = await server.getPrimaryService(UUID.hrService);
      const hrc = await hrs.getCharacteristic(UUID.hrMeasurement);
      hrc.addEventListener('characteristicvaluechanged', (ev) => this._onHr(ev.target.value));
      await hrc.startNotifications();

      // Flux ECG (service PMD de Polar)
      const pmd = await server.getPrimaryService(UUID.pmdService);
      const ctrl = await pmd.getCharacteristic(UUID.pmdControl);
      const data = await pmd.getCharacteristic(UUID.pmdData);
      ctrl.addEventListener('characteristicvaluechanged', (ev) => this._onControl(ev.target.value));
      await ctrl.startNotifications();
      data.addEventListener('characteristicvaluechanged', (ev) => this._onData(ev.target.value));
      await data.startNotifications();

      this.ctrl = ctrl;
      this.lastEndMs = null;
      try { await ctrl.writeValueWithResponse(new Uint8Array([0x03, 0x00])); } catch (e) { /* arrêt préalable */ }
      // Démarrage : ECG (0x00), fréquence 130 Hz (0x0082), résolution 14 bits (0x000E)
      await ctrl.writeValueWithResponse(
        new Uint8Array([0x02, 0x00, 0x00, 0x01, 0x82, 0x00, 0x01, 0x01, 0x0e, 0x00]));
      h.onStatus('Connecté à ' + this.name);
    }

    disconnect() {
      try { if (this.ctrl) this.ctrl.writeValueWithResponse(new Uint8Array([0x03, 0x00])).catch(() => {}); } catch (e) { /* ignoré */ }
      if (this.device && this.device.gatt.connected) this.device.gatt.disconnect();
    }

    _onControl(dv) {
      // réponse : 0xF0, opcode, type de mesure, statut, ...
      if (dv.byteLength >= 4 && dv.getUint8(0) === 0xf0 && dv.getUint8(3) !== 0) {
        const code = dv.getUint8(3);
        this.h.onStatus('Erreur capteur : ' + (PMD_ERRORS[code] || 'code ' + code));
      }
    }

    _onData(dv) {
      if (dv.byteLength < 13 || dv.getUint8(0) !== 0x00 || dv.getUint8(9) !== 0x00) return; // ECG, trame type 0
      const dt = 1000 / this.fs;
      const tsMs = Number(dv.getBigUint64(1, true)) / 1e6; // horodatage du dernier échantillon
      const samples = [];
      for (let i = 10; i + 2 < dv.byteLength; i += 3) {
        let v = dv.getUint8(i) | (dv.getUint8(i + 1) << 8) | (dv.getUint8(i + 2) << 16);
        if (v & 0x800000) v -= 0x1000000;
        samples.push(v);
      }
      if (!samples.length) return;
      // paquets perdus : on maintient la dernière valeur pour garder l'échelle de temps correcte
      if (this.lastEndMs != null) {
        const firstMs = tsMs - (samples.length - 1) * dt;
        const gap = Math.round((firstMs - this.lastEndMs) / dt) - 1;
        if (gap > 0 && gap <= this.fs * 5) {
          this.h.onEcg(new Array(gap).fill(this.lastValue));
        }
      }
      this.lastEndMs = tsMs;
      this.lastValue = samples[samples.length - 1];
      this.h.onEcg(samples);
    }

    _onHr(dv) {
      const flags = dv.getUint8(0);
      let i = 1, hr;
      if (flags & 0x01) { hr = dv.getUint16(i, true); i += 2; } else { hr = dv.getUint8(i); i += 1; }
      if (flags & 0x08) i += 2; // énergie dépensée
      const rr = [];
      if (flags & 0x10) {
        for (; i + 1 < dv.byteLength; i += 2) rr.push((dv.getUint16(i, true) * 1000) / 1024);
      }
      this.h.onHr({ hr, rr });
    }
  }

  /* ---------- Source de démonstration (ECG synthétique) ---------- */

  class DemoSource {
    constructor(h) {
      this.h = h;
      this.fs = ECG_FS;
      this.name = 'Démonstration';
    }

    async connect() {
      this.t = 0;          // temps simulé (s)
      this.n = 0;          // échantillons émis
      this.beats = [];     // instants des ondes R
      this.rrQueue = [];
      this.nextBeat = 0.4;
      this.t0 = performance.now();
      this.timer = setInterval(() => this._tick(), 100);
      this.h.onBattery(100);
      this.h.onStatus('Mode démonstration (signal simulé)');
    }

    disconnect() {
      clearInterval(this.timer);
      this.timer = null;
      this.h.onDisconnect();
    }

    _rr(t) {
      const hr = 72 + 6 * Math.sin(2 * Math.PI * 0.25 * t) + 3 * Math.sin(2 * Math.PI * 0.08 * t);
      return 60 / hr + (Math.random() - 0.5) * 0.012;
    }

    _wave(t) {
      // somme de gaussiennes (P, Q, R, S, T) autour de chaque onde R, en µV
      let v = 0;
      for (let b = this.beats.length - 1; b >= 0 && b > this.beats.length - 5; b--) {
        const d = t - this.beats[b];
        if (d < -0.4 || d > 0.8) continue;
        const g = (a, mu, s) => a * Math.exp(-((d - mu) * (d - mu)) / (2 * s * s));
        v += g(110, -0.17, 0.024) + g(-140, -0.028, 0.009) + g(1250, 0, 0.011)
          + g(-260, 0.03, 0.010) + g(300, 0.26, 0.048);
      }
      return v;
    }

    _tick() {
      const target = ((performance.now() - this.t0) / 1000) * this.fs;
      const out = [];
      while (this.n < target) {
        const t = this.n / this.fs;
        while (this.nextBeat < t + 0.5) {
          this.beats.push(this.nextBeat);
          const rr = this._rr(this.nextBeat);
          this.rrQueue.push({ at: this.nextBeat + 0.05, rr: rr * 1000 });
          this.nextBeat += rr;
        }
        const noise = (Math.random() - 0.5) * 25;
        const wander = 180 * Math.sin(2 * Math.PI * 0.2 * t); // dérive de la ligne de base
        out.push(Math.round(this._wave(t) + noise + wander));
        this.n++;
      }
      if (out.length) this.h.onEcg(out);
      const now = this.n / this.fs;
      while (this.rrQueue.length && this.rrQueue[0].at <= now) {
        const b = this.rrQueue.shift();
        this.h.onHr({ hr: Math.round(60000 / b.rr), rr: [b.rr] });
      }
    }
  }

  const ns = (global.CardioH10 = global.CardioH10 || {});
  ns.Polar = { PolarH10, DemoSource, supported, ECG_FS };
})(window);
