/* Générateur PDF vectoriel minimal (A4 paysage, échelle 1:1, Helvetica) */
(function (global) {
  'use strict';

  const K = 72 / 25.4;          // points par mm
  const PAGE_W = 297 * K;
  const PAGE_H = 210 * K;

  // caractères hors Latin-1 présents dans WinAnsi (cp1252)
  const CP1252 = {
    '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88,
    '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93,
    '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b,
    'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
  };

  function encode(s) {
    let o = '';
    for (const ch of s) {
      const c = ch.codePointAt(0);
      let b;
      if (c < 0x20) b = 0x20;
      else if (c < 0x80 || (c >= 0xa0 && c <= 0xff)) b = c;
      else if (CP1252[ch] !== undefined) b = CP1252[ch];
      else b = 0x3f;
      if (b === 0x28 || b === 0x29 || b === 0x5c) o += '\\';
      o += String.fromCharCode(b);
    }
    return o;
  }

  const num = (v) => (Math.round(v * 100) / 100).toString();
  const X = (x) => num(x * K);
  const Y = (y) => num(PAGE_H - y * K);

  function rgb(hex) {
    const v = parseInt(hex.slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => (c / 255).toFixed(3)).join(' ');
  }

  class PdfBackend {
    constructor(measure) {
      this.pages = [];
      this.out = null;
      this.paper = false; // pas de fond teinté : le papier blanc fait office de fond
      this._measure = measure;
    }
    beginPage() {
      this.out = ['1 j 1 J'];
      this.pages.push(this.out);
    }
    measure(s, pt, bold) { return this._measure(s, pt, bold); }
    fillRect(x, y, w, h, color) {
      this.out.push(rgb(color) + ' rg ' + X(x) + ' ' + Y(y + h) + ' ' + num(w * K) + ' ' + num(h * K) + ' re f');
    }
    strokeRect(x, y, w, h, o) {
      this.out.push(rgb(o.color) + ' RG ' + num(o.width * K) + ' w ' +
        X(x) + ' ' + Y(y + h) + ' ' + num(w * K) + ' ' + num(h * K) + ' re S');
    }
    lines(segs, o) {
      if (!segs.length) return;
      const p = [rgb(o.color) + ' RG ' + num(o.width * K) + ' w'];
      for (let i = 0; i < segs.length; i += 4) {
        p.push(X(segs[i]) + ' ' + Y(segs[i + 1]) + ' m ' + X(segs[i + 2]) + ' ' + Y(segs[i + 3]) + ' l');
      }
      p.push('S');
      this.out.push(p.join('\n'));
    }
    path(pts, o) {
      if (pts.length < 4) return;
      const p = [rgb(o.color) + ' RG ' + num(o.width * K) + ' w', X(pts[0]) + ' ' + Y(pts[1]) + ' m'];
      for (let i = 2; i < pts.length; i += 2) p.push(X(pts[i]) + ' ' + Y(pts[i + 1]) + ' l');
      p.push('S');
      this.out.push(p.join('\n'));
    }
    text(s, x, y, o) {
      let tx = x;
      if (o.align === 'right') tx = x - this.measure(s, o.size, o.bold);
      else if (o.align === 'center') tx = x - this.measure(s, o.size, o.bold) / 2;
      this.out.push('BT ' + rgb(o.color || '#111111') + ' rg /' + (o.bold ? 'F2' : 'F1') + ' ' + num(o.size) +
        ' Tf ' + X(tx) + ' ' + Y(y) + ' Td (' + encode(s) + ') Tj ET');
    }

    /** Assemble le document et renvoie un Uint8Array. */
    build() {
      const objs = [];
      const n = this.pages.length;
      objs[1] = '<< /Type /Catalog /Pages 2 0 R /ViewerPreferences << /PrintScaling /None >> >>';
      const kids = [];
      for (let i = 0; i < n; i++) kids.push((6 + i * 2) + ' 0 R');
      objs[2] = '<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + n + ' >>';
      objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
      objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
      objs[5] = '<< /Title (Electrocardiogramme) /Producer (CardioH10) >>';
      this.pages.forEach((ops, i) => {
        const content = ops.join('\n');
        objs[6 + i * 2] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + num(PAGE_W) + ' ' + num(PAGE_H) +
          '] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ' + (7 + i * 2) + ' 0 R >>';
        objs[7 + i * 2] = '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream';
      });

      let pdf = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
      const offsets = [];
      for (let i = 1; i < objs.length; i++) {
        offsets[i] = pdf.length;
        pdf += i + ' 0 obj\n' + objs[i] + '\nendobj\n';
      }
      const xref = pdf.length;
      pdf += 'xref\n0 ' + objs.length + '\n0000000000 65535 f \n';
      for (let i = 1; i < objs.length; i++) pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
      pdf += 'trailer\n<< /Size ' + objs.length + ' /Root 1 0 R /Info 5 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';

      const bytes = new Uint8Array(pdf.length);
      for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 255;
      return bytes;
    }
  }

  const ns = (global.CardioH10 = global.CardioH10 || {});
  ns.Pdf = { PdfBackend };
})(window);
