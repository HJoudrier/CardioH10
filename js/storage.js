/* Sauvegarde locale des tracés (IndexedDB) et import/export JSON */
(function (global) {
  'use strict';

  const DB_NAME = 'cardioh10';
  const STORE = 'traces';
  const DRAFT = 'draft';
  let dbp = null;

  function open() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 2);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          if (!db.objectStoreNames.contains(DRAFT)) db.createObjectStore(DRAFT);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbp;
  }

  async function tx(mode, fn, store) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store || STORE, mode);
      const r = fn(t.objectStore(store || STORE));
      t.oncomplete = () => resolve(r && r.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  function persistable(rec) {
    const o = {
      name: rec.name, start: rec.start, fs: rec.fs, source: rec.source,
      samples: rec.samples, rr: rec.rr,
    };
    if (rec.id != null) o.id = rec.id;
    return o;
  }

  const Store = {
    /** Crée ou met à jour ; renvoie l'identifiant. */
    save: (rec) => tx('readwrite', (s) => s.put(persistable(rec))),
    list: () => tx('readonly', (s) => s.getAll()).then((a) => (a || []).sort((x, y) => y.start - x.start)),
    remove: (id) => tx('readwrite', (s) => s.delete(id)),

    /** Brouillon de l'enregistrement en cours : permet de récupérer le tracé si la page est tuée. */
    saveDraft: (rec) => tx('readwrite', (s) => s.put(persistable(rec), 'current'), DRAFT),
    loadDraft: () => tx('readonly', (s) => s.get('current'), DRAFT),
    clearDraft: () => tx('readwrite', (s) => s.delete('current'), DRAFT),

    toJSON(rec) {
      return JSON.stringify({
        format: 'cardioh10', version: 1,
        name: rec.name, start: rec.start, fs: rec.fs, source: rec.source,
        unit: 'uV', rr_ms: Array.from(rec.rr || [], (v) => Math.round(v * 10) / 10),
        samples: Array.from(rec.samples),
      });
    },

    fromJSON(text) {
      const o = JSON.parse(text);
      if (!o || o.format !== 'cardioh10' || !Array.isArray(o.samples) || !(o.fs > 0) || o.samples.length < 2) {
        throw new Error('Fichier non reconnu');
      }
      if (!o.samples.every((v) => Number.isFinite(v))) throw new Error('Échantillons invalides');
      return {
        id: null,
        name: String(o.name || '').slice(0, 200),
        start: Number(o.start) || Date.now(),
        fs: Number(o.fs),
        source: o.source === 'demo' ? 'demo' : 'H10',
        samples: Int32Array.from(o.samples),
        rr: Array.isArray(o.rr_ms) ? o.rr_ms.filter((v) => Number.isFinite(v)) : [],
      };
    },
  };

  const ns = (global.CardioH10 = global.CardioH10 || {});
  ns.Store = Store;
})(window);
