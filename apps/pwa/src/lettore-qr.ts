// Il lettore di QR del telefono.
//
// Sta qui e non nell'interfaccia perche' e' l'unico pezzo che esiste solo
// sulla PWA: sul computer il QR si MOSTRA, non si inquadra. `app.js` e' lo
// stesso file nei due posti, e chiede a questo globale se c'e'.
//
// Perche' una libreria e non il browser: `BarcodeDetector` leggerebbe i QR
// senza aggiungere niente, ma su iOS non esiste — e il telefono e' proprio il
// posto dove serve. jsQR e' JavaScript puro, Apache-2.0, ~35 KB, e legge da un
// `ImageData` qualunque: nessun permesso in piu' oltre alla fotocamera.

// jsQR e' un pacchetto CommonJS con i tipi scritti in stile ESM: sotto
// `module: NodeNext` l'import predefinito arriva come oggetto del modulo,
// non come funzione. Si prende la funzione da dentro, invece di allentare le
// regole del compilatore per tutto il progetto.
import * as moduloJsQr from 'jsqr';

type LettoreQr = (
  dati: Uint8ClampedArray,
  larghezza: number,
  altezza: number,
  opzioni?: { inversionAttempts?: 'dontInvert' | 'onlyInvert' | 'attemptBoth' | 'invertFirst' }
) => { data: string } | null;

const jsQR: LettoreQr =
  (moduloJsQr as unknown as { default?: LettoreQr }).default ?? (moduloJsQr as unknown as LettoreQr);

/**
 * Cerca un QR in un fotogramma. Restituisce il testo, o null.
 *
 * `attemptBoth` perche' uno schermo inquadrato di sbieco, o con la luminosita'
 * alta, capita spesso invertito: senza, si resta a fissare il codice senza che
 * succeda niente.
 */
function leggi(dati: Uint8ClampedArray, larghezza: number, altezza: number): string | null {
  const trovato = jsQR(dati, larghezza, altezza, { inversionAttempts: 'attemptBoth' });
  return trovato?.data ?? null;
}

(globalThis as { wireQr?: unknown }).wireQr = { leggi };
