/* Traitement du signal et statistiques (FC, HRV) */
(function (global) {
  'use strict';

  /* ---------- Filtres biquad (Butterworth 2e ordre) ---------- */

  class Biquad {
    constructor(b0, b1, b2, a1, a2) {
      this.b0 = b0; this.b1 = b1; this.b2 = b2; this.a1 = a1; this.a2 = a2;
      this.z1 = 0; this.z2 = 0;
    }
    process(x) {
      const y = this.b0 * x + this.z1;
      this.z1 = this.b1 * x - this.a1 * y + this.z2;
      this.z2 = this.b2 * x - this.a2 * y;
      return y;
    }
  }

  function design(type, fc, fs) {
    const w0 = 2 * Math.PI * fc / fs;
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
    const a0 = 1 + alpha;
    let b0, b1, b2;
    if (type === 'hp') {
      b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2;
    } else {
      b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2;
    }
    return new Biquad(b0 / a0, b1 / a0, b2 / a0, (-2 * cos) / a0, (1 - alpha) / a0);
  }

  /** Chaîne passe-haut (hp) / passe-bas (lp) ; les bornes sont en Hz, 0 = désactivé. */
  class FilterChain {
    constructor(fs, opts) {
      this.stages = [];
      if (opts.hp) this.stages.push(design('hp', opts.hp, fs));
      if (opts.lp && opts.lp < fs / 2) this.stages.push(design('lp', opts.lp, fs));
    }
    process(x) {
      for (const s of this.stages) x = s.process(x);
      return x;
    }
    /** Fait converger le filtre sur une valeur constante (évite le saut initial). */
    prime(x0, n) {
      for (let i = 0; i < (n || 1000); i++) this.process(x0);
    }
  }

  function applyCausal(x, fs, opts) {
    const out = new Float32Array(x.length);
    if (!x.length) return out;
    const f = new FilterChain(fs, opts);
    f.prime(x[0]);
    for (let i = 0; i < x.length; i++) out[i] = f.process(x[i]);
    return out;
  }

  /** Filtrage à phase nulle (avant + arrière), sans déformation du QRS ni du segment ST. */
  function filtfilt(x, fs, opts) {
    const n = x.length;
    if (n < 8 || (!opts.hp && !opts.lp)) return Float32Array.from(x);
    const pad = Math.min(n - 1, Math.round(3 * fs));
    const ext = new Float64Array(n + 2 * pad);
    for (let i = 0; i < pad; i++) ext[i] = 2 * x[0] - x[pad - i];
    for (let i = 0; i < n; i++) ext[pad + i] = x[i];
    for (let i = 0; i < pad; i++) ext[pad + n + i] = 2 * x[n - 1] - x[n - 2 - i];

    const pass = (arr) => {
      const f = new FilterChain(fs, opts);
      f.prime(arr[0]);
      for (let i = 0; i < arr.length; i++) arr[i] = f.process(arr[i]);
    };
    pass(ext);
    ext.reverse();
    pass(ext);
    ext.reverse();
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = ext[pad + i];
    return out;
  }

  /* ---------- Détection des ondes R (secours si le capteur ne fournit pas les RR) ---------- */

  function detectR(x, fs) {
    const n = x.length;
    if (n < fs * 2) return [];
    const y = filtfilt(x, fs, { hp: 5, lp: 15 });
    const e = new Float64Array(n);
    for (let i = 1; i < n - 1; i++) {
      const d = y[i + 1] - y[i - 1];
      e[i] = d * d;
    }
    // intégration glissante ~100 ms
    const w = Math.max(3, Math.round(0.1 * fs));
    const m = new Float64Array(n);
    let acc = 0;
    for (let i = 0; i < n; i++) {
      acc += e[i];
      if (i >= w) acc -= e[i - w];
      m[i] = acc / w;
    }
    // candidats = maxima locaux sur ±200 ms
    const half = Math.round(0.2 * fs);
    const cand = [];
    for (let i = half; i < n - half; i++) {
      let isMax = true;
      for (let j = i - half; j <= i + half; j++) {
        if (m[j] > m[i]) { isMax = false; break; }
      }
      if (isMax && m[i] > 0) cand.push(i);
    }
    if (!cand.length) return [];
    const vals = cand.map((i) => m[i]).sort((a, b) => a - b);
    const ref = vals[Math.floor(vals.length * 0.75)];
    const thr = 0.3 * ref;
    const refr = Math.round(0.25 * fs);
    const search = Math.round(0.1 * fs);
    const peaks = [];
    for (const c of cand) {
      if (m[c] < thr) continue;
      // l'intégrateur est centré sur la fenêtre -> le pic R se trouve avant c
      let best = c, bv = -1;
      for (let j = Math.max(0, c - search - w); j <= Math.min(n - 1, c + search); j++) {
        const v = Math.abs(y[j]);
        if (v > bv) { bv = v; best = j; }
      }
      if (peaks.length && best - peaks[peaks.length - 1] < refr) continue;
      peaks.push(best);
    }
    return peaks;
  }

  function rrFromPeaks(peaks, fs) {
    const rr = [];
    for (let i = 1; i < peaks.length; i++) rr.push(((peaks[i] - peaks[i - 1]) * 1000) / fs);
    return rr;
  }

  /* ---------- Statistiques FC / HRV ---------- */

  function median(a) {
    const s = a.slice().sort((p, q) => p - q);
    const k = s.length >> 1;
    return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
  }

  /** Marque les intervalles RR exploitables (plage physiologique + écart à la médiane locale). */
  function validRR(rr) {
    const inRange = rr.map((v) => v >= 300 && v <= 2000);
    return rr.map((v, i) => {
      if (!inRange[i]) return false;
      const nb = [];
      for (let j = Math.max(0, i - 3); j <= Math.min(rr.length - 1, i + 3); j++) {
        if (inRange[j]) nb.push(rr[j]);
      }
      const med = median(nb);
      return Math.abs(v - med) <= 0.35 * med;
    });
  }

  function computeStats(rr) {
    const ok = validRR(rr);
    const nn = rr.filter((_, i) => ok[i]);
    const res = { n: nn.length, hrMean: null, hrMin: null, hrMax: null, rmssd: null, sdnn: null };
    if (nn.length < 2) return res;
    const mean = nn.reduce((s, v) => s + v, 0) / nn.length;
    res.hrMean = 60000 / mean;
    let lo = Infinity, hi = -Infinity;
    for (const v of nn) {
      const hr = 60000 / v;
      if (hr < lo) lo = hr;
      if (hr > hi) hi = hr;
    }
    res.hrMin = lo;
    res.hrMax = hi;
    if (nn.length >= 3) {
      res.sdnn = Math.sqrt(nn.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (nn.length - 1));
    }
    let sum = 0, cnt = 0;
    for (let i = 0; i + 1 < rr.length; i++) {
      if (ok[i] && ok[i + 1]) {
        const d = rr[i + 1] - rr[i];
        sum += d * d;
        cnt++;
      }
    }
    if (cnt >= 2) res.rmssd = Math.sqrt(sum / cnt);
    return res;
  }

  const ns = (global.CardioH10 = global.CardioH10 || {});
  ns.Analysis = { filtfilt, applyCausal, detectR, rrFromPeaks, computeStats };
})(window);
