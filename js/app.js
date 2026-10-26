/* Interface : connexion, tracé en direct, enregistrement, rapport, exports */
(function () {
  'use strict';

  const { Analysis, Render, Pdf, Polar, Store, Share } = window.CardioH10;
  const $ = (id) => document.getElementById(id);

  const FS = Polar.ECG_FS;
  const FILTER = { hp: 0.5, lp: 40 };
  const LIVE_KEEP = FS * 14;       // secondes conservées pour le défilement
  const MIN_REC_SEC = 3;

  const S = {
    src: null,         // source active (H10 ou démo)
    live: [],          // derniers échantillons bruts (µV)
    hr: null,
    buf: null,         // mémoire tampon : dernières secondes reçues du capteur
    current: null,     // tracé affiché dans le rapport
    page: 0,
    liveQueued: false,
    share: null,       // diffuseur de partage en direct
    viewer: null,      // spectateur (mode ?watch=)
    wake: null,
    lastDraft: 0,
    lock: null,
    full: false,       // tracé en direct en plein écran
  };

  /* ---------- Utilitaires ---------- */

  let toastTimer = null;
  function toast(msg, isErr) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = ''; }, isErr ? 6000 : 3000);
  }

  function setStatus(text, mode) {
    $('statusText').textContent = text;
    $('statusText').title = text;
    $('statusDot').className = 'dot' + (mode ? ' ' + mode : '');
  }

  const p2 = (n) => (n < 10 ? '0' : '') + n;
  function stamp(ms) {
    const d = new Date(ms);
    return d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '_' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
  }
  function slug(s) {
    return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  }
  function fileBase(rec) {
    const nm = slug(rec.name);
    return 'ECG_' + (nm ? nm + '_' : '') + stamp(rec.start);
  }
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }
  function fmtDuration(sec) {
    return sec < 60 ? Math.round(sec) + ' s' : Math.floor(sec / 60) + ' min ' + p2(Math.round(sec % 60)) + ' s';
  }

  /* ---------- Source de données ---------- */

  const handlers = {
    onEcg(samples) {
      for (let i = 0; i < samples.length; i++) S.live.push(samples[i]);
      if (S.live.length > LIVE_KEEP) S.live.splice(0, S.live.length - LIVE_KEEP);
      if (S.src) {
        // nouvelle source : nouvelle mémoire tampon (l'ancienne reste disponible jusque-là)
        if (!S.buf || S.buf.src !== S.src) newBuffer();
        const b = S.buf;
        for (let i = 0; i < samples.length; i++) b.samples.push(samples[i]);
        b.total += samples.length;
        b.lastAt = Date.now();
        trimBuffer();
        updateProgress();
        saveDraftIfDue();
      }
      if (S.share) S.share.send({ t: 'ecg', s: samples });
      queueLive();
    },
    onHr({ hr, rr }) {
      S.hr = hr;
      $('hrNow').textContent = hr;
      if (S.buf && S.buf.src === S.src) for (const v of rr) S.buf.rr.push({ at: S.buf.total, v });
      if (S.share) S.share.send({ t: 'hr', hr });
    },
    onReconnecting() {
      toast('Liaison avec le capteur perdue, reconnexion en cours…', true);
      if (S.share) S.share.send({ t: 'state', live: false });
    },
    onReconnected() {
      toast('Capteur reconnecté.');
      setStatus('Connecté · ' + S.src.name, 'on');
      shareState();
    },
    onStatus(text) { setStatus(text, S.src ? 'on' : ''); },
    onBattery(p) {
      const b = $('battery');
      b.hidden = false;
      b.textContent = 'Batterie ' + p + ' %';
    },
    onDisconnect() {
      S.src = null;
      if (S.buf && S.buf.samples.length >= MIN_REC_SEC * FS) {
        toast('Capteur déconnecté. La mémoire tampon (' + fmtDuration(S.buf.samples.length / FS) +
          ') reste disponible : « Enregistrer » pour la sauvegarder.');
      }
      S.hr = null;
      updateWake();
      $('hrNow').textContent = '--';
      $('battery').hidden = true;
      setStatus('Non connecté', '');
      shareState();
      updateButtons();
      queueLive();
    },
  };

  async function startSource(kind) {
    if (S.src) return;
    const src = kind === 'demo' ? new Polar.DemoSource(handlers) : new Polar.PolarH10(handlers);
    S.live = [];
    $('btHelp').hidden = true;
    $('btnConnect').disabled = true;
    $('btnDemo').disabled = true;
    try {
      S.src = src; // les gestionnaires s'appuient sur S.src
      await src.connect();
      setStatus(kind === 'demo' ? 'Démonstration (signal simulé)' : 'Connecté · ' + src.name, 'on');
      shareState();
      updateWake();
    } catch (e) {
      try { src.disconnect(); } catch (e2) { /* ignoré */ }
      S.src = null;
      if (e && e.name === 'NotFoundError') {
        toast('Aucun capteur sélectionné.');
        setStatus('Non connecté', '');
      } else {
        const msg = e && e.message ? e.message : String(e);
        toast('Connexion impossible : ' + msg, true);
        setStatus('Échec : ' + msg, '');
        $('btHelp').hidden = false;
      }
    }
    updateButtons();
  }

  function stopSource() {
    if (!S.src) return;
    S.src.disconnect(); // déclenche onDisconnect
  }

  function updateButtons() {
    const on = !!S.src;
    $('btnConnect').hidden = on;
    $('btnDemo').hidden = on;
    $('btnConnect').disabled = false;
    $('btnDemo').disabled = false;
    $('btnDisconnect').hidden = !on;
    $('btnRec').disabled = $('btnRecFs').disabled = !S.buf;
  }

  /* ---------- Tracé en direct ---------- */

  function sizeCanvas(canvas, aspect) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.parentElement.clientWidth;
    const cw = Math.max(1, Math.round(w * dpr));
    const ch = Math.max(1, Math.round((w / aspect) * dpr));
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;
    canvas.style.height = (w / aspect) + 'px';
    return cw;
  }

  function queueLive() {
    if (S.liveQueued) return;
    S.liveQueued = true;
    requestAnimationFrame(drawLive);
  }

  /** Plein écran : le canvas remplit son cadre, le papier garde au moins 10 s × 60 mm visibles. */
  function sizeLiveFull(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const box = canvas.parentElement;
    const bw = Math.max(1, box.clientWidth), bh = Math.max(1, box.clientHeight);
    const k = Math.min(bw / Render.LIVE.w, bh / Render.LIVE.h); // px CSS par mm
    const cw = Math.round(bw * dpr), ch = Math.round(bh * dpr);
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;
    canvas.style.height = '';
    return { k: k * dpr, w: bw / k, h: bh / k };
  }

  function drawLive() {
    S.liveQueued = false;
    const canvas = $('liveCanvas');
    let k, w = Render.LIVE.w, h = Render.LIVE.h;
    if (S.full) ({ k, w, h } = sizeLiveFull(canvas));
    else k = sizeCanvas(canvas, w / h) / w;
    const g = new Render.CanvasBackend(canvas, k, { minPx: 0.7 });
    const win = S.live.slice(-Math.round(11 * FS));
    const sig = $('filterOn').checked ? Analysis.applyCausal(win, FS, FILTER) : Float32Array.from(win);
    Render.drawLive(g, sig, FS, w, h);
  }

  /* ---------- Plein écran (paysage) ---------- */

  const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement;

  function leaveNativeFull() {
    try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) { /* ignoré */ }
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (fsElement() && exit) Promise.resolve(exit.call(document)).catch(() => {});
  }

  /**
   * Le bloc du tracé couvre la fenêtre (CSS) ; la page passe aussi en plein écran natif et
   * l'écran est verrouillé en paysage quand le navigateur le permet (Android). Sinon (iPhone…),
   * si l'écran reste en portrait, le CSS fait pivoter le bloc de 90°.
   */
  async function enterFull() {
    if (S.full) return;
    S.full = true;
    setFullUi();
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    try {
      if (req && !fsElement()) await req.call(el, { navigationUI: 'hide' });
      if (!S.full) { leaveNativeFull(); return; } // quitté pendant la demande
      if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape');
    } catch (e) { /* refusé ou non pris en charge : le pivotement CSS prend le relais */ }
  }

  function exitFull() {
    if (!S.full) return;
    S.full = false;
    setFullUi();
    leaveNativeFull();
  }

  function setFullUi() {
    $('liveCard').classList.toggle('fs', S.full);
    document.body.classList.toggle('fs-open', S.full);
    // les messages suivent le bloc (et son pivotement éventuel)
    (S.full ? $('liveCard') : document.body).appendChild($('toast'));
    const label = S.full ? 'Quitter le plein écran' : 'Plein écran (paysage)';
    $('btnFull').setAttribute('aria-label', label);
    $('btnFull').title = label;
    queueLive();
  }

  function initFull() {
    $('btnFull').onclick = () => (S.full ? exitFull() : enterFull());
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') exitFull(); });
    // sortie du plein écran natif par le navigateur (Échap, geste retour)
    const onChange = () => { if (!fsElement()) exitFull(); };
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
  }

  /* ---------- Mémoire tampon et enregistrement ---------- */

  /** Durée choisie, en secondes (0 : sans limite, tout depuis la connexion). */
  const bufLimit = () => parseInt($('duration').value, 10) || 0;

  function newBuffer() {
    S.buf = {
      src: S.src,
      source: S.src instanceof Polar.DemoSource ? 'demo' : 'H10',
      samples: [],
      rr: [],        // { at: index absolu de réception, v: intervalle RR en ms }
      first: 0,      // index absolu du premier échantillon conservé
      total: 0,      // nombre d'échantillons reçus depuis la connexion
      lastAt: 0,     // heure de réception du dernier paquet
    };
    S.lastDraft = 0;
    updateButtons();
  }

  /** Ne garde que les dernières secondes choisies. */
  function trimBuffer() {
    const b = S.buf, lim = bufLimit() * FS;
    if (!b || !lim || b.samples.length <= lim) return;
    const drop = b.samples.length - lim;
    b.samples.splice(0, drop);
    b.first += drop;
    // intervalles RR dont le battement de départ est sorti de la mémoire
    let k = 0;
    while (k < b.rr.length && b.rr[k].at - (b.rr[k].v * FS) / 1000 < b.first) k++;
    if (k) b.rr.splice(0, k);
  }

  function updateProgress() {
    const b = S.buf;
    $('recProgress').hidden = !b;
    if (!b) return;
    const sec = b.samples.length / FS, lim = bufLimit();
    $('recText').textContent = 'Mémoire tampon ' + (lim ? fmtDuration(sec) + ' / ' + fmtDuration(lim) : fmtDuration(sec));
    $('recBar').style.width = (lim ? Math.min(100, (sec / lim) * 100) : 0) + '%';
  }

  /** Contenu actuel de la mémoire tampon, sous forme de tracé. */
  function bufferRecord() {
    const b = S.buf;
    return {
      id: null,
      name: $('patientName').value.trim(),
      start: Math.round(b.lastAt - (b.samples.length / FS) * 1000),
      fs: FS,
      source: b.source,
      samples: Int32Array.from(b.samples),
      rr: b.rr.map((r) => r.v),
    };
  }

  /** « Enregistrer » : sauvegarde le contenu de la mémoire tampon, qui continue de se remplir. */
  async function saveBuffer() {
    const b = S.buf;
    if (!b) return;
    if (b.samples.length < MIN_REC_SEC * FS) {
      toast('Mémoire tampon trop courte (moins de ' + MIN_REC_SEC + ' s), patientez quelques secondes.', true);
      return;
    }
    try { localStorage.setItem('cardioh10.name', $('patientName').value); } catch (e) { /* ignoré */ }
    const rec = bufferRecord();
    showRecord(rec);
    $('reportCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    try {
      rec.id = await Store.save(rec);
      toast('Enregistrement de ' + fmtDuration(rec.samples.length / FS) + ' sauvegardé.' +
        (b.src === S.src ? ' La mémoire tampon continue de se remplir.' : ''));
    } catch (e) {
      toast('Sauvegarde impossible : ' + (e && e.message ? e.message : e), true);
    }
    if (S.current === rec) renderPreview();
    refreshSaved();
  }

  /* ---------- Rapport ---------- */

  function getView(rec) {
    const filtered = $('filterOn').checked;
    if (rec._view && rec._view.filtered === filtered) return rec._view;
    const sig = filtered ? Analysis.filtfilt(rec.samples, rec.fs, FILTER) : Float32Array.from(rec.samples);
    let rr = rec.rr || [];
    let how = 'capteur';
    if (rr.length < 3) {
      rr = Analysis.rrFromPeaks(Analysis.detectR(sig, rec.fs), rec.fs);
      how = 'détection des ondes R';
    }
    const stats = Analysis.computeStats(rr);
    rec._view = {
      filtered, sig, stats, how,
      filterLabel: filtered ? 'Filtre 0,5–40 Hz' : 'Sans filtre',
    };
    return rec._view;
  }

  function showRecord(rec) {
    S.current = rec;
    S.page = 0;
    $('reportName').value = rec.name || '';
    $('reportEmpty').hidden = true;
    $('reportBody').hidden = false;
    renderPreview();
  }

  function renderPreview() {
    const rec = S.current;
    if (!rec) return;
    const view = getView(rec);
    const pages = Render.pageCount(rec);
    S.page = Math.min(S.page, pages - 1);
    const canvas = $('pageCanvas');
    const cw = sizeCanvas(canvas, Render.L.pageW / Render.L.pageH);
    const g = new Render.CanvasBackend(canvas, cw / Render.L.pageW, { minPx: 0.7 });
    g.fillRect(0, 0, Render.L.pageW, Render.L.pageH, '#ffffff');
    Render.drawReport(g, rec, view, S.page, pages);

    $('pager').hidden = pages < 2;
    $('pageInfo').textContent = (S.page + 1) + ' / ' + pages;
    $('pagePrev').disabled = S.page === 0;
    $('pageNext').disabled = S.page >= pages - 1;
    $('btnPng').textContent = pages > 1 ? 'Exporter PNG (page ' + (S.page + 1) + ')' : 'Exporter PNG';
    $('btnSave').textContent = rec.id != null ? 'Mettre à jour' : 'Sauvegarder';
    const st = view.stats;
    $('statsNote').textContent = 'FC et HRV calculées à partir des intervalles RR (' + view.how + ', ' + st.n +
      ' battements retenus).' + (st.rmssd == null ? ' Enregistrement trop court pour une HRV fiable.' : '');
  }

  function exportPng() {
    const rec = S.current;
    if (!rec) return;
    const view = getView(rec);
    const pages = Render.pageCount(rec);
    const k = 300 / 25.4; // 300 dpi
    const c = document.createElement('canvas');
    c.width = Math.round(Render.L.pageW * k);
    c.height = Math.round(Render.L.pageH * k);
    const g = new Render.CanvasBackend(c, k, { minPx: 1 });
    g.fillRect(0, 0, Render.L.pageW, Render.L.pageH, '#ffffff');
    Render.drawReport(g, rec, view, S.page, pages);
    c.toBlob(async (blob) => {
      if (!blob) { toast('Export PNG impossible.', true); return; }
      const buf = new Uint8Array(await blob.arrayBuffer());
      const out = setPngDpi(buf, 300);
      download(new Blob([out], { type: 'image/png' }), fileBase(rec) + (pages > 1 ? '_p' + (S.page + 1) : '') + '.png');
    }, 'image/png');
  }

  /** Insère le chunk pHYs pour que le PNG s'imprime à la bonne taille (A4 à 300 dpi). */
  function setPngDpi(png, dpi) {
    const ppm = Math.round(dpi / 0.0254);
    const chunk = new Uint8Array(21);
    const dv = new DataView(chunk.buffer);
    dv.setUint32(0, 9);
    chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
    dv.setUint32(8, ppm);
    dv.setUint32(12, ppm);
    chunk[16] = 1; // mètre
    dv.setUint32(17, crc32(chunk.subarray(4, 17)));
    const at = 33; // signature (8) + IHDR (25)
    const out = new Uint8Array(png.length + chunk.length);
    out.set(png.subarray(0, at), 0);
    out.set(chunk, at);
    out.set(png.subarray(at), at + chunk.length);
    return out;
  }

  let crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
      }
    }
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function exportPdf() {
    const rec = S.current;
    if (!rec) return;
    const view = getView(rec);
    const pages = Render.pageCount(rec);
    const pdf = new Pdf.PdfBackend(Render.measure);
    for (let p = 0; p < pages; p++) {
      pdf.beginPage();
      Render.drawReport(pdf, rec, view, p, pages);
    }
    download(new Blob([pdf.build()], { type: 'application/pdf' }), fileBase(rec) + '.pdf');
  }

  function exportJson() {
    const rec = S.current;
    if (!rec) return;
    download(new Blob([Store.toJSON(rec)], { type: 'application/json' }), fileBase(rec) + '.json');
  }

  /* ---------- Tracés sauvegardés ---------- */

  async function saveCurrent() {
    const rec = S.current;
    if (!rec) return;
    try {
      rec.id = await Store.save(rec);
      toast('Tracé sauvegardé sur cet appareil.');
      renderPreview();
      refreshSaved();
    } catch (e) {
      toast('Sauvegarde impossible : ' + (e && e.message ? e.message : e), true);
    }
  }

  async function refreshSaved() {
    let items = [];
    try { items = await Store.list(); } catch (e) { /* stockage indisponible */ }
    const ul = $('savedList');
    ul.textContent = '';
    $('savedEmpty').hidden = items.length > 0;
    for (const rec of items) {
      const li = document.createElement('li');
      const meta = document.createElement('div');
      meta.className = 'meta';
      const strong = document.createElement('strong');
      strong.textContent = rec.name || 'Sans nom';
      const span = document.createElement('span');
      const d = new Date(rec.start);
      span.textContent = d.toLocaleDateString('fr-FR') + ' ' + d.toLocaleTimeString('fr-FR') + ' · ' +
        fmtDuration(rec.samples.length / rec.fs) + (rec.source === 'demo' ? ' · démonstration' : '');
      meta.append(strong, span);
      const actions = document.createElement('div');
      actions.className = 'actions';
      const open = document.createElement('button');
      open.className = 'small';
      open.textContent = 'Ouvrir';
      open.onclick = () => {
        showRecord(rec);
        $('reportCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
      const del = document.createElement('button');
      del.className = 'small danger';
      del.textContent = 'Supprimer';
      del.onclick = async () => {
        if (!confirm('Supprimer ce tracé ?')) return;
        await Store.remove(rec.id);
        if (S.current && S.current.id === rec.id) S.current.id = null;
        refreshSaved();
        renderPreview();
      };
      actions.append(open, del);
      li.append(meta, actions);
      ul.append(li);
    }
  }

  async function importJson(file) {
    try {
      const rec = Store.fromJSON(await file.text());
      showRecord(rec);
      toast('Fichier importé. Cliquez sur « Sauvegarder » pour le conserver.');
      $('reportCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      toast('Import impossible : ' + (e && e.message ? e.message : e), true);
    }
  }


  /* ---------- Partage en direct ---------- */

  function shareName() {
    return $('shareName').checked ? $('patientName').value.trim() : '';
  }
  function shareState() {
    if (S.share) S.share.send({ t: 'state', live: !!S.src });
  }
  function shareInfo() {
    if (S.share) S.share.send({ t: 'info', name: shareName() });
  }

  async function startShare() {
    if (S.share) return;
    if (!Share.available()) { toast('Partage indisponible (bibliothèque non chargée).', true); return; }
    $('btnShare').disabled = true;
    const b = new Share.Broadcaster({
      getInfo: () => ({ fs: FS, live: !!S.src, name: shareName() }),
      getBuffer: () => S.live.slice(-Math.round(11 * FS)),
      onViewers: (n) => {
        $('shareStatus').textContent = n ? n + ' spectateur' + (n > 1 ? 's' : '') + ' connecté' + (n > 1 ? 's' : '') + '.' : 'En attente de spectateur…';
      },
      onError: (msg) => toast(msg, true),
    });
    try {
      const id = await b.start();
      S.share = b;
      const url = location.origin + location.pathname + '?watch=' + id;
      $('shareLink').value = url;
      Share.drawQr($('qrCanvas'), url);
      $('sharePanel').hidden = false;
      $('shareStatus').textContent = 'En attente de spectateur…';
      $('btnNativeShare').hidden = !navigator.share;
      $('btnShare').hidden = true;
      updateWake();
    } catch (e) {
      b.stop();
      toast(e.message, true);
    }
    $('btnShare').disabled = false;
  }

  function stopShare() {
    if (S.share) S.share.stop();
    S.share = null;
    updateWake();
    $('sharePanel').hidden = true;
    $('btnShare').hidden = false;
  }

  async function copyLink() {
    const url = $('shareLink').value;
    try {
      await navigator.clipboard.writeText(url);
      toast('Lien copié.');
    } catch (e) {
      $('shareLink').select();
      toast('Sélectionnez le lien et copiez-le (Ctrl+C).');
    }
  }

  /* ---------- Mode spectateur (?watch=…) ---------- */

  function startViewer(id) {
    document.body.classList.add('viewer');
    $('liveTitle').textContent = 'Tracé en direct (spectateur)';
    $('viewerBar').hidden = false;
    $('footNote').hidden = true;
    let live = false, name = '';
    const info = () => {
      $('viewerInfo').textContent = [name ? 'Patient : ' + name : '', live ? '' : 'en attente du capteur…']
        .filter(Boolean).join(' · ');
    };
    S.viewer = new Share.Viewer({
      onStatus: (text, ok) => {
        setStatus(text, ok ? 'on' : '');
        if (!ok) { S.live = []; $('hrNow').textContent = '--'; queueLive(); }
      },
      onHello: (m) => { live = !!m.live; name = String(m.name || '').slice(0, 80); S.live = []; info(); },
      onEcg: (samples) => handlers.onEcg(samples),
      onHr: (m) => handlers.onHr(m),
      onState: (m) => {
        live = !!m.live;
        if (!live) { S.live = []; $('hrNow').textContent = '--'; queueLive(); }
        info();
      },
      onInfo: (m) => { name = String(m.name || '').slice(0, 80); info(); },
    });
    S.viewer.connect(id);
  }


  /* ---------- Veille de l'écran et reprise après interruption ---------- */

  /**
   * Un verrou Web Locks détenu pendant la session empêche Chrome de geler ou de décharger l'onglet
   * quand il passe en arrière-plan : la réception Bluetooth et l'enregistrement continuent.
   */
  function updateLock() {
    if (!navigator.locks) return;
    const want = !!(S.src || S.share);
    if (want && !S.lock) {
      const me = (S.lock = {});
      navigator.locks.request('cardioh10-live', () => new Promise((res) => {
        if (S.lock === me) me.release = res; else res();
      })).catch(() => {});
    } else if (!want && S.lock) {
      const me = S.lock;
      S.lock = null;
      if (me.release) me.release();
    }
  }

  /** Garde l'écran allumé tant qu'un capteur est connecté ou qu'un partage est actif. */
  async function updateWake() {
    updateLock();
    const want = !!(S.src || S.share) && $('keepAwake').checked;
    try {
      if (want && !S.wake && navigator.wakeLock && document.visibilityState === 'visible') {
        S.wake = await navigator.wakeLock.request('screen');
        S.wake.addEventListener('release', () => { S.wake = null; });
      } else if (!want && S.wake) {
        const w = S.wake;
        S.wake = null;
        await w.release();
      }
    } catch (e) { S.wake = null; /* refusé (économie d'énergie…) : facultatif */ }
  }

  /** Copie la mémoire tampon dans IndexedDB toutes les ~10 s. */
  function saveDraftIfDue() {
    const b = S.buf;
    if (!b || b.total - S.lastDraft < 10 * FS) return;
    S.lastDraft = b.total;
    Store.saveDraft(bufferRecord()).catch(() => {});
  }

  /** Au démarrage : un brouillon existe si la page a été fermée ou tuée capteur connecté. */
  async function recoverDraft() {
    let d = null;
    try { d = await Store.loadDraft(); } catch (e) { return; }
    if (!d) return;
    try { await Store.clearDraft(); } catch (e) { /* ignoré */ }
    if (!d.samples || d.samples.length < MIN_REC_SEC * d.fs) return;
    d.rr = Array.from(d.rr || []);
    d.id = null;
    showRecord(d);
    toast('Mémoire tampon de la session précédente récupérée (' + fmtDuration(d.samples.length / d.fs) +
      ') : « Sauvegarder » pour la conserver.');
  }

  /* ---------- Initialisation ---------- */

  function init() {
    initFull();
    const watch = new URLSearchParams(location.search).get('watch');
    if (watch !== null) {
      if (!Share.ID_RE.test(watch)) {
        document.body.classList.add('viewer');
        setStatus('Lien de partage invalide', '');
        drawLive();
        return;
      }
      window.addEventListener('resize', queueLive);
      $('filterOn').checked = true;
      drawLive();
      startViewer(watch);
      return;
    }
    if (!Polar.supported()) {
      $('btWarn').hidden = false;
      $('btnConnect').disabled = true;
    }
    try { $('patientName').value = localStorage.getItem('cardioh10.name') || ''; } catch (e) { /* ignoré */ }

    $('btnConnect').onclick = () => startSource('h10');
    $('btnDemo').onclick = () => startSource('demo');
    $('btnDisconnect').onclick = stopSource;
    $('btnRec').onclick = saveBuffer;
    $('btnRecFs').onclick = saveBuffer;
    $('duration').onchange = () => { trimBuffer(); updateProgress(); };
    $('keepAwake').onchange = updateWake;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { updateWake(); queueLive(); }
    });
    $('btnShare').onclick = startShare;
    $('btnStopShare').onclick = stopShare;
    $('btnCopy').onclick = copyLink;
    $('btnNativeShare').onclick = () => {
      navigator.share({ title: 'Tracé ECG en direct', url: $('shareLink').value }).catch(() => {});
    };
    $('shareName').onchange = shareInfo;
    $('patientName').addEventListener('input', shareInfo);
    $('filterOn').onchange = () => {
      if (S.current) S.current._view = null;
      renderPreview();
      queueLive();
    };
    $('reportName').oninput = (e) => {
      if (!S.current) return;
      S.current.name = e.target.value;
      renderPreview();
    };
    $('pagePrev').onclick = () => { S.page = Math.max(0, S.page - 1); renderPreview(); };
    $('pageNext').onclick = () => { S.page++; renderPreview(); };
    $('btnSave').onclick = saveCurrent;
    $('btnPng').onclick = exportPng;
    $('btnPdf').onclick = exportPdf;
    $('btnJson').onclick = exportJson;
    $('importFile').onchange = (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) importJson(f);
    };

    let rz = null;
    window.addEventListener('resize', () => {
      clearTimeout(rz);
      rz = setTimeout(() => { queueLive(); renderPreview(); }, 100);
    });

    updateButtons();
    drawLive();
    refreshSaved();
    recoverDraft();
  }

  init();
})();
