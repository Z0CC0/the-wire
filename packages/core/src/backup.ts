// Il backup: il deposito intero in un file solo, cosi' com'e'.
//
// Non si ricifra niente, apposta. Il deposito e' GIA' cifrato con la
// passphrase (Argon2id, XChaCha20), lo storico e i file con chiavi derivate da
// quella e mai scritte da nessuna parte: copiarli dentro un unico file lascia
// la protezione esattamente dov'era. Un secondo strato con una seconda
// passphrase sarebbe una seconda cosa da ricordare per non proteggere niente
// di piu'.
//
// Quindi il file di backup si apre solo con la passphrase dell'account, e si
// ripristina su un dispositivo che non ha ancora un deposito: e' il modo di
// riportare l'account su un computer nuovo quando il vecchio non c'e' piu'.
// Se il vecchio c'e' ancora, la strada giusta e' COLLEGA UN DISPOSITIVO, non
// questa: due copie dello stesso deposito accese insieme fanno avanzare gli
// stessi ratchet da due parti, ed e' il difetto che rende mute le
// conversazioni.

import { chiaveValida } from './deposito.js';
import { cat, equalCT, readU32, td, te, u32 } from './codec.js';

const MAGIC = te.encode('WIREBK');
const VERSION = 1;
/** Un indice piu' lungo di cosi' non e' un indice: e' un file che non e' un backup. */
const MAX_INDICE = 1024 * 1024;
/** Oltre questo numero di voci qualcosa non torna: un deposito ha un vault, uno storico e i file. */
const MAX_VOCI = 10000;

export interface VoceBackup {
  readonly nome: string;
  readonly dati: Uint8Array;
}

export interface Backup {
  /** Quando e' stato fatto, orario di chi lo ha fatto. */
  readonly creato: number;
  readonly voci: readonly VoceBackup[];
}

/**
 * Il nome che dice "questo deposito e' appena stato ripristinato".
 *
 * Lo scrive il ripristino, lo legge e lo toglie la prima apertura. Serve a
 * fare una cosa sola: aprire sessioni nuove per scrivere, perche' quelle nel
 * backup sono ferme al momento in cui e' stato fatto e i contatti, da allora,
 * sono andati avanti. Scrivere con una sessione vecchia significherebbe
 * riusare numeri di messaggio gia' usati, e l'altro li rifiuterebbe.
 */
export const SEGNO_RIPRISTINO = 'wire.ripristino';

/**
 * Struttura del file:
 *   "WIREBK" | versione(1) | lunghezza indice(4) | indice JSON | voce | voce | ...
 * L'indice elenca nome e lunghezza di ogni voce, nell'ordine in cui seguono.
 */
export function impacchetta(voci: readonly VoceBackup[], creato = Date.now()): Uint8Array {
  const indice = te.encode(
    JSON.stringify({
      v: VERSION,
      creato,
      voci: voci.map((v) => ({ nome: chiaveValida(v.nome), lunghezza: v.dati.length })),
    })
  );
  return cat(MAGIC, Uint8Array.of(VERSION), u32(indice.length), indice, ...voci.map((v) => v.dati));
}

export function spacchetta(bytes: Uint8Array): Backup {
  const testa = MAGIC.length + 1 + 4;
  if (bytes.length < testa) throw new Error('non e un backup di THE WIRE');
  if (!equalCT(bytes.subarray(0, MAGIC.length), MAGIC)) throw new Error('non e un backup di THE WIRE');
  const versione = bytes[MAGIC.length]!;
  if (versione !== VERSION) throw new Error(`backup di versione ${versione}, questa build legge la ${VERSION}`);
  const lunghezzaIndice = readU32(bytes, MAGIC.length + 1);
  if (lunghezzaIndice === 0 || lunghezzaIndice > MAX_INDICE || testa + lunghezzaIndice > bytes.length) {
    throw new Error('backup troncato o corrotto');
  }
  let indice: { creato?: unknown; voci?: unknown };
  try {
    indice = JSON.parse(td.decode(bytes.subarray(testa, testa + lunghezzaIndice))) as typeof indice;
  } catch {
    throw new Error('indice del backup illeggibile');
  }
  if (!Array.isArray(indice.voci) || indice.voci.length > MAX_VOCI) throw new Error('indice del backup non valido');

  const voci: VoceBackup[] = [];
  let off = testa + lunghezzaIndice;
  for (const v of indice.voci as Array<{ nome?: unknown; lunghezza?: unknown }>) {
    const nome = chiaveValida(String(v.nome ?? ''));
    const lunghezza = v.lunghezza;
    if (typeof lunghezza !== 'number' || !Number.isInteger(lunghezza) || lunghezza < 0 || off + lunghezza > bytes.length) {
      throw new Error('backup troncato o corrotto');
    }
    voci.push({ nome, dati: bytes.subarray(off, off + lunghezza) });
    off += lunghezza;
  }
  if (off !== bytes.length) throw new Error('backup con byte in piu dopo l ultima voce');
  const creato = typeof indice.creato === 'number' && Number.isFinite(indice.creato) ? indice.creato : 0;
  return { creato, voci };
}

/** Il nome del file come lo si propone a chi salva. */
export function nomeFileBackup(quando = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `THE-WIRE-backup-${quando.getFullYear()}-${p(quando.getMonth() + 1)}-${p(quando.getDate())}.wirebk`;
}
