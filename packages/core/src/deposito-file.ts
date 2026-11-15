// Deposito su disco, per il computer.
//
// Sta in un file a parte da `deposito.ts` apposta: questo importa `node:fs`, e
// un browser che lo caricasse morirebbe subito. Chi costruisce la versione per
// il telefono importa il contratto e l'implementazione IndexedDB, e questo file
// non lo tocca mai.

import { mkdir, readFile, rename, rm, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { chiaveValida, type Deposito } from './deposito.js';

/**
 * Dove vivono i dati, secondo le convenzioni di ciascun sistema.
 *
 * `THE WIRE 2` e non `THE WIRE`: la versione precedente e' ancora installata e
 * usa quell'altra cartella. Condividerla vorrebbe dire due programmi con due
 * idee diverse dello stesso file — questa ci scrive account e dispositivi, che
 * la precedente non sa cosa siano. Chi ha tutte e due tiene due identita'
 * separate, ed e' la cosa giusta finche' questa e' in prova.
 */
export function cartellaPredefinita(): string {
  // `THE_WIRE_DATI` sposta la cartella per intero: serve a chi prova due
  // programmi sullo stesso computer (due identita', due depositi, due lock) e a
  // chi vuole i dati su un altro disco. Vuota o assente, valgono le convenzioni.
  const scelta = process.env['THE_WIRE_DATI'];
  if (scelta && scelta.trim()) return scelta.trim();
  if (platform() === 'win32') {
    return join(process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming'), 'THE WIRE 2');
  }
  if (platform() === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'THE WIRE 2');
  }
  return join(process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'), 'the-wire-2');
}

export class DepositoFile implements Deposito {
  constructor(private readonly cartella: string) {}

  private dove(chiave: string): string {
    return join(this.cartella, chiaveValida(chiave));
  }

  /** La cartella si crea alla prima scrittura, non all'avvio: chi apre un
   *  deposito che non esiste non deve trovarselo creato a meta'. */
  private async pronta(): Promise<void> {
    await mkdir(this.cartella, { recursive: true });
  }

  async leggi(chiave: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.dove(chiave)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  /** Una coda per chiave: le scritture sullo stesso file escono nell'ordine
   *  in cui sono state chieste. Senza, due salvataggi vicini — un nome cambiato
   *  e una verifica, o un messaggio arrivato mentre si salva — possono
   *  invertirsi, e sul disco resta lo stato piu' vecchio. */
  private readonly code = new Map<string, Promise<void>>();

  /**
   * Scrittura in due tempi: prima accanto, poi al posto giusto.
   *
   * Una scrittura interrotta a meta' sul file del deposito e' un'identita'
   * persa per sempre. Si scrive tutto su un file temporaneo e poi lo si
   * RINOMINA sopra quello vero: la rinomina e' atomica sia su NTFS sia su
   * APFS/ext4, quindi in ogni istante sul disco c'e' o il vecchio intero o il
   * nuovo intero. Prima si riscriveva il file vero con `writeFile`, che lo
   * tronca e poi lo riempie: un'interruzione in quel punto lasciava un
   * deposito vuoto, esattamente cio' che questa funzione dice di evitare.
   *
   * Il temporaneo ha un nome diverso a ogni scrittura: due scritture nello
   * stesso istante con lo stesso `.tmp` facevano fallire la seconda rinomina
   * (il file era gia' stato spostato dalla prima) — visto davvero, su
   * `wire.vault`, con un nome cambiato e una verifica chiesti insieme.
   */
  async scrivi(chiave: string, dati: Uint8Array): Promise<void> {
    const nome = chiaveValida(chiave);
    const prima = this.code.get(nome) ?? Promise.resolve();
    const mia = prima.catch(() => {}).then(() => this.scriviDavvero(nome, dati));
    this.code.set(nome, mia);
    try {
      await mia;
    } finally {
      if (this.code.get(nome) === mia) this.code.delete(nome);
    }
  }

  private async scriviDavvero(nome: string, dati: Uint8Array): Promise<void> {
    await this.pronta();
    const tmp = this.dove(`${nome}.${process.pid.toString(16)}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`);
    const vero = this.dove(nome);
    try {
      await writeFile(tmp, dati);
      await rename(tmp, vero);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }

  async accoda(chiave: string, dati: Uint8Array): Promise<void> {
    await this.pronta();
    await appendFile(this.dove(chiave), dati);
  }

  async elimina(chiave: string): Promise<void> {
    await rm(this.dove(chiave), { force: true });
  }

  async esiste(chiave: string): Promise<boolean> {
    return (await this.leggi(chiave)) !== null;
  }
}
