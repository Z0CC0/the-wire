// Costruisce la PWA: una cartella di file statici, da mettere ovunque.
//
// Niente di piu' di questo. Non c'e' un server da avviare, non c'e' un
// pacchetto da firmare, non c'e' uno store da attraversare: la cartella
// prodotta qui, messa su un indirizzo HTTPS, E' l'app — sia su Android sia su
// iPhone.
import { build } from 'esbuild';
import { cp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const qui = dirname(fileURLToPath(import.meta.url));
const radice = join(qui, '..', '..');
const fuori = join(qui, 'sito');

await rm(fuori, { recursive: true, force: true });
await mkdir(fuori, { recursive: true });

// Il cuore e il ponte, in un file solo. `deposito-file` e `lock` restano fuori:
// importano Node, e qui non c'e'. Restano import dinamici che il browser non
// esegue mai, perche' ci si passa solo da una cartella su disco.
await build({
  entryPoints: [join(qui, 'dist', 'ponte.js')],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: ['es2022'],
  external: ['./deposito-file.js', './lock.js'],
  outfile: join(fuori, 'ponte.js'),
  minify: true,
});

// Il lettore di QR, a parte: lo carica solo la PWA. Sul computer non serve —
// li' il codice si mostra — e tenerlo fuori evita di spedire una libreria di
// lettura a chi non inquadra niente.
await build({
  entryPoints: [join(qui, 'src', 'lettore-qr.ts')],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: ['es2022'],
  outfile: join(fuori, 'qr.js'),
  minify: true,
});

// L'interfaccia, la stessa del computer.
for (const f of ['app.js', 'app.css', 'tokens.css']) {
  await cp(join(radice, 'ui', f), join(fuori, f));
}
for (const f of ['manifest.webmanifest', 'sw.js', 'aggiornamenti.js', 'aggiornamenti.css']) {
  await cp(join(qui, 'pubblico', f), join(fuori, f));
}
await cp(join(radice, 'build', 'icon.png'), join(fuori, 'icona-512.png'));
await cp(join(radice, 'build', 'icon.png'), join(fuori, 'icona-192.png'));

// La pagina: la stessa dell'app, con il ponte al posto del preload di Electron
// e le due righe che la rendono installabile.
let html = await readFile(join(radice, 'ui', 'index.html'), 'utf8');
html = html
  .replace(/[ \t]*<script src="diretto\.js"><\/script>\r?\n?/g, '')
  .replace(
    '</head>',
    `  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self' wss:; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'" />
    <link rel="manifest" href="manifest.webmanifest" />
    <meta name="theme-color" content="#000000" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black" />
    <meta name="apple-mobile-web-app-title" content="THE WIRE" />
    <link rel="apple-touch-icon" href="icona-192.png" />
    <link rel="stylesheet" href="aggiornamenti.css" />
  </head>`
  )
  .replace(
    '<script src="app.js"></script>',
    `<script type="module" src="ponte.js"></script>
    <script defer src="qr.js"></script>
    <script defer src="app.js"></script>
    <!-- Registra il service worker e avvisa quando i file sul sito cambiano.
         Solo su questa strada: sul computer e nell'app Android non c'e' nessun
         sito da cui l'app possa cambiare sotto i piedi. -->
    <script defer src="aggiornamenti.js"></script>`
  );
await writeFile(join(fuori, 'index.html'), html);

// I due documenti che viaggiano con la cartella: le istruzioni per pubblicarla
// e lo stato della sicurezza. Copiati qui perche' questa cartella si svuota a
// ogni costruzione, e una volta se li e' gia' portati via.
for (const [da, a] of [
  [join(qui, 'LEGGIMI-telefono-pubblicazione.md'), 'LEGGIMI-PRIMA.md'],
  [join(radice, 'SICUREZZA.md'), 'SICUREZZA.md'],
]) {
  await cp(da, join(fuori, a));
}

// Le impronte di quello che si pubblica.
//
// Servono a rispondere a una domanda sola: cio' che sta sul sito e' cio' che e'
// uscito da qui? Chi mette le mani sull'indirizzo dove l'app e' pubblicata puo'
// cambiarla, e nessuno se ne accorgerebbe. Con questo file si controlla, e il
// controllo si puo' rifare da chiunque, in qualunque momento.
const impronte = [];
for (const f of (await readdir(fuori)).sort()) {
  if (f === 'IMPRONTE.txt') continue;
  const byte = await readFile(join(fuori, f));
  impronte.push(`${createHash('sha256').update(byte).digest('hex')}  ${f}`);
}
await writeFile(
  join(fuori, 'IMPRONTE.txt'),
  [
    '# Impronte SHA-256 dei file pubblicati.',
    '#',
    '# Per controllare che il sito non sia stato toccato, da una cartella con i',
    '# file scaricati:  sha256sum -c IMPRONTE.txt',
    '# Su Windows, per un file alla volta:  certutil -hashfile <file> SHA256',
    '#',
    "# Se un'impronta non torna, quel file non e' quello costruito qui.",
    '',
    ...impronte,
    '',
  ].join(String.fromCharCode(10))
);

console.log('sito pronto in apps/pwa/sito');
console.log(impronte.length, 'file, impronte in IMPRONTE.txt');
