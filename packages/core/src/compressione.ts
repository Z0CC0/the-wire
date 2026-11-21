// Comprimere, dove si puo'.
//
// Lo storico che passa al dispositivo nuovo e' JSON: si stringe di quattro o
// cinque volte, e su una mailbox che fa 59 KB al secondo quattro volte meno
// byte sono quattro volte meno attesa. `CompressionStream` c'e' in Node 20,
// in Chromium e in Safari dal 16.4, cioe' ovunque giri questo programma —
// ma e' un globale del runtime, non una libreria, e un runtime che non lo ha
// manda il contenuto com'e' invece di fallire.
//
// I tipi sono dichiarati qui al minimo: il cuore compila con la sola libreria
// ES2022, senza i tipi del DOM, e tirarli dentro per due funzioni sarebbe
// sproporzionato.

interface Lettore {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
}
interface Scrittore {
  write(pezzo: Uint8Array): Promise<void>;
  close(): Promise<void>;
}
interface Flusso {
  readonly readable: { getReader(): Lettore };
  readonly writable: { getWriter(): Scrittore };
}
type CostruttoreFlusso = new (formato: 'gzip') => Flusso;

function costruttore(nome: 'CompressionStream' | 'DecompressionStream'): CostruttoreFlusso | undefined {
  return (globalThis as Record<string, unknown>)[nome] as CostruttoreFlusso | undefined;
}

async function leggiTutto(lettore: Lettore): Promise<Uint8Array> {
  const pezzi: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await lettore.read();
    if (done) break;
    if (value) pezzi.push(value);
  }
  const out = new Uint8Array(pezzi.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of pezzi) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

async function attraversa(Costruttore: CostruttoreFlusso, dati: Uint8Array): Promise<Uint8Array> {
  const flusso = new Costruttore('gzip');
  // Si comincia a leggere PRIMA di scrivere: con un flusso che ha un tetto di
  // byte in attesa, scrivere tutto e poi leggere si blocca a meta'.
  const lettura = leggiTutto(flusso.readable.getReader());
  const scrittore = flusso.writable.getWriter();
  await scrittore.write(dati);
  await scrittore.close();
  return lettura;
}

/** gzip, o null dove il runtime non sa farlo. */
export async function comprimi(dati: Uint8Array): Promise<Uint8Array | null> {
  const C = costruttore('CompressionStream');
  if (!C) return null;
  return attraversa(C, dati);
}

/** L'inverso. Qui un runtime che non sa farlo e' un errore: i byte sono compressi, e non si leggono altrimenti. */
export async function decomprimi(dati: Uint8Array): Promise<Uint8Array> {
  const D = costruttore('DecompressionStream');
  if (!D) throw new Error('questo dispositivo non sa decomprimere: aggiorna il browser');
  return attraversa(D, dati);
}
