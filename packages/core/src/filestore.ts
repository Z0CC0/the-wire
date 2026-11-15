// Dove finiscono i file ricevuti dalla mailbox.
//
// Un file arrivato non puo' restare in chiaro nella cartella dei dati: tutto il
// resto di questo programma esiste per non lasciare niente di leggibile su
// disco, e un'immagine ricevuta e' esattamente il genere di cosa che si vuole
// proteggere. Qui ogni file e' cifrato per conto suo, con una chiave derivata
// da quella del deposito — mai la stessa, mai scritta da nessuna parte.
//
// Solo i file piccoli passano di qui, quelli che arrivano dalla mailbox e
// stanno in memoria. Il trasferimento diretto puo' portare gigabyte, e quelli
// vanno dove dice chi li riceve, senza passare da questo magazzino: tenerne
// una seconda copia cifrata nella cartella dei dati vorrebbe dire raddoppiare
// lo spazio occupato senza che nessuno l'abbia chiesto.

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { casuali } from './casuale.js';
import type { Deposito } from './deposito.js';
import { cat, equalCT, te } from './codec.js';

const MAGIC = te.encode('WIREFL');
const VERSION = 1;
const NONCE_BYTES = 24;

/** Sottochiave per i file: derivata, mai la stessa del deposito ne' dello storico. */
export function fileKey(vaultKey: Uint8Array): Uint8Array {
  return hkdf(sha256, vaultKey, new Uint8Array(32), te.encode('WIRE-FILE-1'), 32);
}

/**
 * Il nome nel deposito non e' quello del file.
 *
 * Due ragioni. La prima e' che un nome scelto dall'altra parte non deve poter
 * decidere dove si scrive: `../../qualcosa` non e' un nome, e' un attacco. La
 * seconda e' che l'elenco della cartella non deve raccontare cosa contiene —
 * chi apre la cartella vede identificativi, non "referto.pdf".
 */
function nome(id: string): string {
  if (!/^[0-9a-f]{8,128}$/.test(id)) throw new Error('identificativo di file non valido');
  return `file-${id}`;
}

export class FileStore {
  constructor(
    private readonly deposito: Deposito,
    private readonly key: Uint8Array
  ) {}

  /**
   * Struttura:  "WIREFL" | versione(1) | nonce(24) | testo cifrato
   * L'intestazione in chiaro fa da dato autenticato, come nel deposito.
   */
  async scrivi(id: string, dati: Uint8Array): Promise<void> {
    const nonce = casuali(NONCE_BYTES);
    const testa = cat(MAGIC, Uint8Array.of(VERSION), nonce);
    const cifrato = xchacha20poly1305(this.key, nonce, testa).encrypt(dati);
    await this.deposito.scrivi(nome(id), cat(testa, cifrato));
  }

  async leggi(id: string): Promise<Uint8Array> {
    const bytes = await this.deposito.leggi(nome(id));
    if (!bytes) throw new Error('file non presente');
    const lunghezzaTesta = MAGIC.length + 1 + NONCE_BYTES;
    if (bytes.length < lunghezzaTesta + 16) throw new Error('file troncato');
    if (!equalCT(bytes.subarray(0, MAGIC.length), MAGIC)) throw new Error('non e un file di THE WIRE');
    if (bytes[MAGIC.length] !== VERSION) throw new Error(`file di versione ${bytes[MAGIC.length]}`);
    const nonce = bytes.subarray(MAGIC.length + 1, lunghezzaTesta);
    const testa = bytes.subarray(0, lunghezzaTesta);
    return xchacha20poly1305(this.key, nonce, testa).decrypt(bytes.subarray(lunghezzaTesta));
  }

  async esiste(id: string): Promise<boolean> {
    return this.deposito.esiste(nome(id));
  }

  async elimina(id: string): Promise<void> {
    await this.deposito.elimina(nome(id));
  }
}
