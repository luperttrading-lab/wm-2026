// Service Worker für WM-2026-Push-Benachrichtigungen  (v2 – Abo-Selbstpflege)
const WORKER_URL   = 'https://wm2026-push.lupert-trading.workers.dev';
const VAPID_PUBLIC = 'BN4D-4wP9HRIVODTcIujObUQxfkUqy56KCLP9MZxln7arr1gchpqWQv8BG9m0xwqXASCkfNwUr6ta5jx6FUGJS4';

// base64url -> Uint8Array (für applicationServerKey beim Neu-Abonnieren)
function u8(b64){
  var pad='='.repeat((4-b64.length%4)%4);
  var s=(b64+pad).replace(/-/g,'+').replace(/_/g,'/');
  var raw=atob(s); var a=new Uint8Array(raw.length);
  for(var i=0;i<raw.length;i++) a[i]=raw.charCodeAt(i);
  return a;
}

// Abo (erneut) beim Worker registrieren – idempotent (serverseitig gleicher subId-Schlüssel,
// also kein Doppel-Abo). Netzfehler werden bewusst verschluckt (still).
function registerSub(sub){
  if(!sub) return Promise.resolve();
  return fetch(WORKER_URL + '/subscribe', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(sub)
  }).catch(function(){});
}

self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch(_) { data = { title: 'WM 2026', body: event.data ? event.data.text() : '' }; }
  const title = data.title || '⚽ WM 2026';
  const options = {
    body: data.body || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: data.tag || 'wm2026',
    renotify: true,
    data: data
  };
  // Notification zeigen UND bei dieser Gelegenheit das Abo "warm halten":
  // Solange Pushes fließen (Spielserien, tagsüber), meldet sich das Gerät bei jedem
  // Push erneut an -> der Worker verliert es nicht durch einen einzelnen 410-Ausrutscher.
  event.waitUntil(
    self.registration.showNotification(title, options).then(function(){
      return self.registration.pushManager.getSubscription().then(registerSub);
    })
  );
});

// Feuert, wenn der Browser das Abo austauscht/erneuert (z. B. kurz vor Ablauf).
// Dann sofort ein frisches Abo lösen und ohne Nutzeraktion nachmelden.
// Hinweis: Safaris Unterstützung dieses Events ist lückenhaft – wenn es feuert, fangen
// wir den Ablauf ab; wenn nicht, greift weiterhin die Re-Registrierung beim App-Start.
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil(
    self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: u8(VAPID_PUBLIC)
    }).then(registerSub).catch(function(){})
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow('./index.html');
    })
  );
});
