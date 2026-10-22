/* Mise en page ECG (papier millimétré, 25 mm/s, 10 mm/mV) et rendu sur canvas.
 * Toutes les coordonnées sont en millimètres, origine en haut à gauche. */
(function (global) {
  'use strict';

  const SPEED = 25;          // mm par seconde
  const MM_PER_UV = 10 / 1000; // 10 mm par mV

  const L = {
    pageW: 297, pageH: 210,   // A4 paysage
    gridX: 11, gridW: 275,    // 55 grands carreaux
    gridY: 42, rowH: 50, rows: 3,
    calW: 25,                 // zone d'étalonnage au début de chaque ligne
    rowSec: 10,               // 10 s par ligne -> 30 s par page
    baseY: 30,                // ligne de base dans une rangée (mm depuis le haut)
  };
  L.pageSec = L.rows * L.rowSec;

  const COL = {
    paper: '#fff7f7', minor: '#f2bcbc', major: '#e48a8a',
    ink: '#111111', grey: '#666666', rule: '#999999',
  };
  const FONT = 'Helvetica, Arial, "Liberation Sans", sans-serif';
  const PT = 25.4 / 72; // 1 pt en mm

  const mCtx = document.createElement('canvas').getContext('2d');
  function measure(s, pt, bold) {
    mCtx.font = (bold ? 'bold ' : '') + '100px ' + FONT;
    return (mCtx.measureText(s).width * pt * PT) / 100;
  }

  /* ---------- Backend canvas ---------- */

  class CanvasBackend {
    constructor(canvas, pxPerMm, opts) {
      this.ctx = canvas.getContext('2d');
      this.k = pxPerMm;
      this.minW = ((opts && opts.minPx) || 0) / pxPerMm;
      this.paper = !opts || opts.paper !== false;
      this.ctx.setTransform(pxPerMm, 0, 0, pxPerMm, 0, 0);
      this.ctx.lineJoin = 'round';
      this.ctx.lineCap = 'round';
    }
    measure(s, pt, bold) { return measure(s, pt, bold); }
    fillRect(x, y, w, h, color) {
      this.ctx.fillStyle = color;
      this.ctx.fillRect(x, y, w, h);
    }
    strokeRect(x, y, w, h, o) {
      this.ctx.strokeStyle = o.color;
      this.ctx.lineWidth = Math.max(o.width, this.minW);
      this.ctx.strokeRect(x, y, w, h);
    }
    lines(segs, o) {
      const c = this.ctx;
      c.strokeStyle = o.color;
      c.lineWidth = Math.max(o.width, this.minW);
      c.beginPath();
      for (let i = 0; i < segs.length; i += 4) {
        c.moveTo(segs[i], segs[i + 1]);
        c.lineTo(segs[i + 2], segs[i + 3]);
      }
      c.stroke();
    }
    path(pts, o) {
      if (pts.length < 4) return;
      const c = this.ctx;
      c.strokeStyle = o.color;
      c.lineWidth = Math.max(o.width, this.minW);
      c.beginPath();
      c.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1]);
      c.stroke();
    }
    text(s, x, y, o) {
      const c = this.ctx;
      c.font = (o.bold ? 'bold ' : '') + o.size * PT + 'px ' + FONT;
      c.fillStyle = o.color || COL.ink;
      c.textAlign = o.align || 'left';
      c.textBaseline = 'alphabetic';
      c.fillText(s, x, y);
    }
  }

  /* ---------- Éléments de dessin ---------- */

  function drawGrid(g, x, y, w, h) {
    if (g.paper) g.fillRect(x, y, w, h, COL.paper);
    const minor = [], major = [];
    for (let i = 0; i <= w; i++) (i % 5 ? minor : major).push(x + i, y, x + i, y + h);
    for (let j = 0; j <= h; j++) (j % 5 ? minor : major).push(x, y + j, x + w, y + j);
    g.lines(minor, { color: COL.minor, width: 0.1 });
    g.lines(major, { color: COL.major, width: 0.22 });
  }

  /** Impulsion d'étalonnage : 1 mV = 10 mm, 0,2 s = 5 mm. */
  function drawCal(g, x, yb) {
    g.path([x + 2, yb, x + 4, yb, x + 4, yb - 10, x + 9, yb - 10, x + 9, yb, x + 11, yb],
      { color: COL.ink, width: 0.3 });
    g.text('1 mV', x + 2, yb + 4.5, { size: 5, color: COL.grey });
  }

  function drawTrace(g, sig, i0, i1, xFn, yb, yMin, yMax) {
    const pts = [];
    for (let i = i0; i <= i1; i++) {
      let y = yb - sig[i] * MM_PER_UV;
      if (y < yMin) y = yMin; else if (y > yMax) y = yMax;
      pts.push(xFn(i), y);
    }
    g.path(pts, { color: COL.ink, width: 0.3 });
  }

  function fmtClock(sec) {
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  /* ---------- Dates en français ---------- */

  const DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
  const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août',
    'septembre', 'octobre', 'novembre', 'décembre'];
  const p2 = (n) => (n < 10 ? '0' : '') + n;
  function dateShort(d) { return p2(d.getDate()) + '/' + p2(d.getMonth() + 1) + '/' + d.getFullYear(); }
  function timeLong(d) { return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()); }
  function dateLong(d) {
    return DAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear();
  }

  function fit(g, s, pt, bold, maxMm) {
    if (g.measure(s, pt, bold) <= maxMm) return s;
    while (s.length > 1 && g.measure(s + '…', pt, bold) > maxMm) s = s.slice(0, -1);
    return s + '…';
  }

  function pageCount(rec) {
    return Math.max(1, Math.ceil(rec.samples.length / rec.fs / L.pageSec - 1e-9));
  }

  /* ---------- Page de rapport ---------- */

  /**
   * @param view {sig: Float32Array, stats, filterLabel}
   */
  function drawReport(g, rec, view, page, pages) {
    const fs = rec.fs;
    const n = view.sig.length;
    const start = new Date(rec.start);
    const st = view.stats;

    // En-tête
    g.text('Électrocardiogramme', L.gridX, 12.5, { size: 16, bold: true });
    const tw = g.measure('Électrocardiogramme', 16, true);
    g.text('Capteur Polar H10 · dérivation unique', L.gridX + tw + 4, 12.5, { size: 9, color: COL.grey });
    g.text('25 mm/s · 10 mm/mV', L.gridX + L.gridW, 12.5, { size: 9, color: COL.grey, align: 'right' });
    g.lines([L.gridX, 15.5, L.gridX + L.gridW, 15.5], { color: COL.rule, width: 0.2 });

    const field = (label, value, x, y, big) => {
      g.text(label.toUpperCase(), x, y, { size: 6.5, color: COL.grey, bold: true });
      g.text(value, x, y + 6, { size: big ? 13 : 12, bold: true });
    };
    const name = (rec.name || '').trim() || '—';
    field('Nom', fit(g, name, 13, true, 130), L.gridX, 20, true);
    field('Date', dateShort(start), 150, 20);
    field('Durée', n / fs < 60 ? Math.round(n / fs) + ' s' : fmtClock(n / fs) + ' min', 215, 20);

    const int = (v, unit) => (v == null ? '—' : Math.round(v) + ' ' + unit);
    const cols = [11, 66, 121, 176, 231];
    field('FC moyenne', int(st.hrMean, 'bpm'), cols[0], 31.5);
    field('FC min', int(st.hrMin, 'bpm'), cols[1], 31.5);
    field('FC max', int(st.hrMax, 'bpm'), cols[2], 31.5);
    field('HRV · RMSSD', int(st.rmssd, 'ms'), cols[3], 31.5);
    field('HRV · SDNN', int(st.sdnn, 'ms'), cols[4], 31.5);

    // Papier millimétré
    drawGrid(g, L.gridX, L.gridY, L.gridW, L.rows * L.rowH);

    for (let r = 0; r < L.rows; r++) {
      const rowIdx = page * L.rows + r;
      const tStart = rowIdx * L.rowSec;
      const i0 = Math.round(tStart * fs);
      if (i0 >= n) break;
      const i1 = Math.min(n - 1, Math.round((tStart + L.rowSec) * fs));
      const y0 = L.gridY + r * L.rowH;
      const yb = y0 + L.baseY;
      const x0 = L.gridX + L.calW;

      drawCal(g, L.gridX, yb);

      // repères de temps (1 s = 25 mm)
      const ticks = [];
      for (let s = 0; s < L.rowSec; s++) {
        const x = x0 + s * SPEED;
        ticks.push(x, y0, x, y0 + 2.5);
        g.text(fmtClock(tStart + s), x + 0.8, y0 + 3.6, { size: 5, color: COL.grey });
      }
      g.lines(ticks, { color: COL.ink, width: 0.25 });

      drawTrace(g, view.sig, i0, i1, (i) => x0 + (i / fs - tStart) * SPEED, yb, y0 + 0.5, y0 + L.rowH - 0.5);
    }

    // Pied de page : date et heure de l'enregistrement
    const yf = L.gridY + L.rows * L.rowH;
    g.lines([L.gridX, yf + 3.5, L.gridX + L.gridW, yf + 3.5], { color: COL.rule, width: 0.2 });
    g.text('Date et heure : ' + dateLong(start) + ' à ' + timeLong(start), L.gridX, yf + 9.5,
      { size: 10.5, bold: true });
    g.text('Page ' + (page + 1) + '/' + pages, L.gridX + L.gridW, yf + 9.5,
      { size: 10, color: COL.grey, align: 'right' });
    g.text('Vitesse 25 mm/s · Amplitude 10 mm/mV · ' + view.filterLabel, L.gridX, yf + 14.5,
      { size: 6.5, color: COL.grey });
    g.text('Capteur grand public (Polar H10), non certifié dispositif médical. Document à titre informatif.',
      L.gridX + L.gridW, yf + 14.5, { size: 6.5, color: COL.grey, align: 'right' });
  }

  /* ---------- Bandeau en direct (10 s défilantes) ---------- */

  const LIVE = { w: L.gridW, h: 60, baseY: 30 };

  function drawLive(g, sig, fs) {
    drawGrid(g, 0, 0, LIVE.w, LIVE.h);
    drawCal(g, 0, LIVE.baseY);
    const len = sig.length;
    if (len < 2) return;
    const span = Math.floor(((LIVE.w - L.calW) / SPEED) * fs);
    const i0 = Math.max(0, len - 1 - span);
    drawTrace(g, sig, i0, len - 1, (i) => LIVE.w - ((len - 1 - i) / fs) * SPEED, LIVE.baseY, 0.5, LIVE.h - 0.5);
  }

  const ns = (global.CardioH10 = global.CardioH10 || {});
  ns.Render = { L, LIVE, COL, CanvasBackend, drawReport, drawLive, pageCount, measure };
})(window);
