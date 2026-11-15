// La stessa app, preparata per stare dentro un'app Android.
//
// Differenza con `costruisci.mjs`: qui non si pubblica niente da nessuna parte.
// I file finiscono dentro il pacchetto, e Capacitor li serve da
// `https://localhost` — che il browser considera contesto sicuro. E' il motivo
// per cui funzionano la fotocamera (per inquadrare il QR) e le primitive
// crittografiche, senza un solo indirizzo esterno e senza certificati.
//
// Cosa NON serve qui, e va tolto:
//   - il service worker, che dentro un'app serve solo a conservare una copia
//     di file che sono gia' sul telefono, e che complica gli aggiornamenti;
//   - il manifest di installazione, perche' l'app e' gia' installata.
//
// Parte da `sito`, quindi `sito` deve essere appena stato costruito: lo script
// `telefono` in package.json fa prima `npm run pwa` apposta. Senza, l'APK
// impacchettava un `sito` vecchio — successo davvero: APK del 14 settembre con
// dentro il cuore del 1 settembre — e nessun errore lo diceva.
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const qui = dirname(fileURLToPath(import.meta.url));
const da = join(qui, 'sito');
const a = join(qui, 'android-www');

await rm(a, { recursive: true, force: true });
await mkdir(a, { recursive: true });

const FUORI = new Set(['sw.js', 'manifest.webmanifest', 'LEGGIMI-PRIMA.md', 'SICUREZZA.md']);
for (const f of await readdir(da)) {
  if (FUORI.has(f)) continue;
  await cp(join(da, f), join(a, f));
}

let html = await readFile(join(da, 'index.html'), 'utf8');
html = html
  .replace(/[ \t]*<link rel="manifest"[^>]*>\r?\n?/g, '')
  // Il pezzo che registra il service worker: dentro l'app non ha piu' oggetto.
  .replace(/[ \t]*<script>\s*\/\/ Il service worker[\s\S]*?<\/script>\r?\n?/g, '')
  // `connect-src` deve permettere i relay: dentro l'app la pagina parla
  // direttamente con loro, e senza questo non partirebbe un messaggio.
  .replace("connect-src 'self' wss:", "connect-src 'self' https://localhost wss:");
await writeFile(join(a, 'index.html'), html);

console.log('app Android pronta in apps/pwa/android-www');
