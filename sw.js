/* Service worker minimal : permet d'afficher les notifications d'alerte (obligatoire sur Android)
 * et de ramener l'application au premier plan au toucher. Aucune mise en cache. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if ('focus' in c) return c.focus();
    return undefined;
  }));
});
