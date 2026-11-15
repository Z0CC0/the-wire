// Numeri casuali, senza chiedere niente a Node.
//
// Il cuore girava solo dentro Electron, quindi `node:crypto` andava benissimo.
// Ora deve girare anche dentro un browser — sul telefono non c'e' Node — e
// quell'import lo terrebbe fuori.
//
// `globalThis.crypto` e' la stessa cosa in tutti e due i posti: e' Web Crypto,
// che i browser hanno da sempre e che Node espone fra i globali dalla 19. Non
// e' un ripiego: e' lo stesso generatore del sistema operativo che usava
// `randomBytes`, chiamato per il nome che vale ovunque.

interface Generatore {
  getRandomValues<T extends ArrayBufferView>(a: T): T;
  randomUUID?: () => string;
}

/** Il generatore, cercato una volta sola e con un errore che dice cosa manca. */
function generatore(): Generatore {
  const c = (globalThis as { crypto?: Generatore }).crypto;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error('manca Web Crypto: serve Node 19 o superiore, oppure un browser');
  }
  return c;
}

/** Byte imprevedibili. Sostituisce `randomBytes` di Node. */
export function casuali(quanti: number): Uint8Array {
  if (!Number.isInteger(quanti) || quanti < 0) throw new Error('quantita di byte non valida');
  const out = new Uint8Array(quanti);
  // Web Crypto rifiuta richieste sopra i 65536 byte in un colpo solo, quindi
  // si riempie a fette. Nessuno qui ne chiede tanti, ma un limite che scatta
  // solo con input grandi e' il genere di cosa che si scopre tardi.
  const g = generatore();
  for (let i = 0; i < out.length; i += 65536) {
    g.getRandomValues(out.subarray(i, Math.min(i + 65536, out.length)));
  }
  return out;
}

/**
 * Identificativo unico. Sostituisce `randomUUID` di Node.
 *
 * `crypto.randomUUID` esiste in Node e nei browser, ma nei browser SOLO su
 * origini sicure: su `http://` non protetto non c'e'. Qui viene servito da
 * HTTPS o da localhost, quindi c'e' — ma se un giorno non ci fosse, meglio un
 * identificativo costruito a mano che un errore.
 */
export function identificativo(): string {
  const c = generatore();
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  const b = casuali(16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
