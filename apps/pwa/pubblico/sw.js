// Service worker: serve a tre cose, e a nessuna quarta.
//
// La prima: rendere l'app installabile. Senza un service worker registrato, il
// telefono non la considera un'app e non la mette sulla schermata Home — e
// senza quello, su iOS il deposito puo' essere cancellato dopo qualche
// settimana di inattivita'.
//
// La seconda: farla aprire anche senza rete. I messaggi non arriveranno, ma
// rubrica e storico stanno nel telefono e restano leggibili.
//
// La terza, che e' una scelta di sicurezza e non una comodita': **l'app parte
// sempre dalla copia gia' installata**, mai da quella sul sito. Questa app e'
// pubblicata su un indirizzo web, e chi mette le mani su quell'indirizzo
// potrebbe sostituirla con una che manda le chiavi altrove. Riscaricandola a
// ogni apertura — com'era prima — una manomissione arriverebbe subito e ogni
// volta. Cosi' invece raggiunge solo chi installa in quel momento: chi ce l'ha
// gia' resta con la sua copia, e un aggiornamento entra solo quando qualcuno
// lo accetta.
//
// Cosa NON fa: non tocca i messaggi, non tiene niente in sottofondo, non parla
// con nessun server oltre a quello da cui e' stata scaricata.

const CACHE = 'the-wire-0.1.2';
const FILE = [
  './',
  './index.html',
  './app.css',
  './tokens.css',
  './aggiornamenti.css',
  './app.js',
  './aggiornamenti.js',
  './ponte.js',
  // Il lettore di QR e le icone: senza, l'app aperta senza rete non riesce a
  // collegare un dispositivo e la schermata Home resta senza figura.
  './qr.js',
  './icona-192.png',
  './icona-512.png',
  './manifest.webmanifest',
  // Le impronte: sono il metro per accorgersi che sul sito e' cambiato
  // qualcosa. Vanno tenute insieme ai file a cui si riferiscono.
  './IMPRONTE.txt',
];

self.addEventListener('install', (e) => {
  // `addAll` fallisce tutto se un file solo manca: e' voluto, un'app a meta'
  // e' peggio di un'installazione fallita.
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  // Le versioni vecchie se ne vanno, o il telefono resta su una copia di ieri.
  e.waitUntil(
    caches
      .keys()
      .then((nomi) => Promise.all(nomi.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Solo i file dell'app, e solo le letture. Tutto il resto — in particolare i
  // relay — non passa di qui: metterli in cache significherebbe conservare
  // traffico cifrato senza motivo.
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    // Prima la copia installata. La rete si tocca solo per cio' che non c'e'.
    caches.match(e.request).then((copia) => {
      if (copia) return copia;
      return fetch(e.request).then((r) => {
        if (r.ok) {
          const clone = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone)).catch(() => {});
        }
        return r;
      });
    })
  );
});

/**
 * Le impronte pubblicate adesso sul sito, senza passare da nessuna copia.
 *
 * `cache: 'no-store'` in tutti e due i posti che potrebbero conservarla: la
 * nostra e quella del browser. Una risposta vecchia direbbe "niente di nuovo"
 * proprio quando qualcosa e' cambiato.
 */
async function improntePubblicate() {
  const r = await fetch('./IMPRONTE.txt?t=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) throw new Error('non raggiungibile');
  return r.text();
}

async function improntenstallate() {
  const c = await caches.open(CACHE);
  const r = await c.match('./IMPRONTE.txt');
  return r ? r.text() : '';
}

/** Scarica la versione nuova, e la mette al posto di quella installata. */
async function applicaAggiornamento() {
  // In una cache a parte: se il telefono perde la rete a meta', quella
  // installata resta intera e l'app continua a funzionare.
  const nome = CACHE + '-nuova';
  await caches.delete(nome);
  const nuova = await caches.open(nome);
  await nuova.addAll(FILE.map((f) => f + '?t=' + Date.now()));

  // Riuscito: si sostituisce, ricopiando sotto i nomi veri.
  const vecchia = await caches.open(CACHE);
  for (const f of FILE) {
    const r = await nuova.match(f + '?t=' + Date.now());
    if (r) await vecchia.put(f, r.clone());
  }
  await caches.delete(nome);
}

self.addEventListener('message', (e) => {
  const rispondi = (dati) => e.source?.postMessage(dati);

  if (e.data === 'cerca-aggiornamento') {
    e.waitUntil(
      Promise.all([improntePubblicate(), improntenstallate()])
        .then(([suSito, installate]) => {
          // Il confronto e' sulle impronte, non sulla data: cosi' si accorge
          // anche di un file cambiato senza che la versione sia cambiata —
          // che e' esattamente come si presenterebbe una manomissione.
          rispondi({ tipo: 'aggiornamento', diverso: Boolean(installate) && suSito.trim() !== installate.trim() });
        })
        // Senza rete non si sa, e non si dice niente: un avviso a vuoto
        // insegna a ignorare gli avvisi.
        .catch(() => rispondi({ tipo: 'aggiornamento', diverso: false }))
    );
    return;
  }

  if (e.data === 'applica-aggiornamento') {
    e.waitUntil(
      applicaAggiornamento()
        .then(() => rispondi({ tipo: 'aggiornato', riuscito: true }))
        .catch(() => rispondi({ tipo: 'aggiornato', riuscito: false }))
    );
  }
});
