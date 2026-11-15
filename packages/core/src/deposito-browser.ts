// Deposito dentro il browser, per il telefono.
//
// IndexedDB e non `localStorage`: `localStorage` tiene solo stringhe, ha un
// tetto intorno ai cinque megabyte, ed e' sincrono — scriverci un deposito di
// chiavi bloccherebbe la pagina. IndexedDB tiene byte, non ha quel tetto, e
// non ferma niente.
//
// Nessun `import` da Node qui dentro, apposta: questo file deve poter essere
// caricato da una pagina web.
//
// Cosa NON garantisce, e va detto: un browser puo' buttare via IndexedDB per
// fare spazio. Su iOS succede dopo qualche settimana in cui il sito non viene
// aperto — a meno che non sia installato sulla schermata Home, che e' il
// motivo per cui l'app va aggiunta li' e non usata come pagina qualunque.

import { chiaveValida, type Deposito } from './deposito.js';

const DEPOSITO = 'the-wire';
const TAVOLA = 'dati';

/** Il minimo di IndexedDB che serve, descritto qui per non tirare dentro i
 *  tipi del DOM in un pacchetto che deve compilare anche per Node. */
interface RichiestaIDB<T> {
  result: T;
  error: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onupgradeneeded?: (() => void) | null;
}
interface DatabaseIDB {
  objectStoreNames: { contains(nome: string): boolean };
  createObjectStore(nome: string): unknown;
  transaction(nome: string, modo: string): { objectStore(nome: string): TavolaIDB };
}
interface TavolaIDB {
  get(chiave: string): RichiestaIDB<unknown>;
  put(valore: unknown, chiave: string): RichiestaIDB<unknown>;
  delete(chiave: string): RichiestaIDB<unknown>;
}

function attesa<T>(r: RichiestaIDB<T>): Promise<T> {
  return new Promise((risolvi, rifiuta) => {
    r.onsuccess = () => risolvi(r.result);
    r.onerror = () => rifiuta(r.error instanceof Error ? r.error : new Error('deposito: operazione fallita'));
  });
}

export class DepositoBrowser implements Deposito {
  private db: DatabaseIDB | null = null;

  /** Un solo database per tutta l'app, aperto alla prima richiesta. */
  private async apri(): Promise<DatabaseIDB> {
    if (this.db) return this.db;
    const idb = (globalThis as { indexedDB?: { open(n: string, v: number): RichiestaIDB<DatabaseIDB> } }).indexedDB;
    if (!idb) throw new Error('questo browser non ha IndexedDB: il deposito non si puo aprire');
    const richiesta = idb.open(DEPOSITO, 1);
    richiesta.onupgradeneeded = () => {
      const db = richiesta.result;
      if (!db.objectStoreNames.contains(TAVOLA)) db.createObjectStore(TAVOLA);
    };
    this.db = await attesa(richiesta);
    return this.db;
  }

  private async tavola(modo: 'readonly' | 'readwrite'): Promise<TavolaIDB> {
    return (await this.apri()).transaction(TAVOLA, modo).objectStore(TAVOLA);
  }

  async leggi(chiave: string): Promise<Uint8Array | null> {
    const v = await attesa((await this.tavola('readonly')).get(chiaveValida(chiave)));
    if (v === undefined || v === null) return null;
    // IndexedDB restituisce un ArrayBuffer, non la vista che avevamo messo.
    return v instanceof Uint8Array ? v : new Uint8Array(v as ArrayBuffer);
  }

  async scrivi(chiave: string, dati: Uint8Array): Promise<void> {
    // Si salva l'ArrayBuffer, non la Uint8Array: una vista puo' guardare solo
    // una fetta di un buffer piu' grande, e finirebbe salvata per intero.
    const copia = Uint8Array.from(dati);
    await attesa((await this.tavola('readwrite')).put(copia.buffer, chiaveValida(chiave)));
  }

  /**
   * IndexedDB non sa accodare: si rilegge, si unisce, si riscrive.
   *
   * Sullo storico questo rende la scrittura piu' cara man mano che la
   * conversazione cresce, ed e' il prezzo di non avere un file. Diventa un
   * problema con storici molto lunghi, e la soluzione — spezzare lo storico in
   * blocchi — non serve finche' non serve.
   */
  async accoda(chiave: string, dati: Uint8Array): Promise<void> {
    const prima = await this.leggi(chiave);
    if (!prima) return this.scrivi(chiave, dati);
    const out = new Uint8Array(prima.length + dati.length);
    out.set(prima, 0);
    out.set(dati, prima.length);
    await this.scrivi(chiave, out);
  }

  async elimina(chiave: string): Promise<void> {
    await attesa((await this.tavola('readwrite')).delete(chiaveValida(chiave)));
  }

  async esiste(chiave: string): Promise<boolean> {
    return (await this.leggi(chiave)) !== null;
  }
}
