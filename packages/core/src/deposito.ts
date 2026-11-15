// Dove il cuore mette le cose, senza sapere cos'e' un file.
//
// Fino a ieri il cuore girava solo dentro Electron e scriveva su disco con
// `node:fs`. Sul telefono non c'e' un disco a cui accedere cosi': c'e'
// IndexedDB, che e' un'altra cosa con un'altra forma. Invece di riempire il
// cuore di `if (siamo nel browser)`, il cuore chiede a un deposito, e chi lo
// avvia decide quale.
//
// Il contratto e' volutamente povero — leggi, scrivi, accoda, elimina — perche'
// e' tutto quello che serve, e perche' ogni verbo in piu' sarebbe un verbo da
// implementare due volte. `accoda` non e' un lusso: lo storico e' un registro
// in sola aggiunta, e riscriverlo tutto a ogni messaggio lo renderebbe piu'
// lento man mano che la conversazione cresce.

export interface Deposito {
  /** null se non c'e'. Non un errore: "non c'e'" e' una risposta normale. */
  leggi(chiave: string): Promise<Uint8Array | null>;
  scrivi(chiave: string, dati: Uint8Array): Promise<void>;
  accoda(chiave: string, dati: Uint8Array): Promise<void>;
  elimina(chiave: string): Promise<void>;
  esiste(chiave: string): Promise<boolean>;
}

/**
 * Le chiavi sono nomi, non percorsi.
 *
 * Un identificativo che arriva dall'altra parte non deve poter decidere dove
 * si scrive: `../../qualcosa` non e' un nome, e' un attacco. Qui si controlla
 * una volta sola, e vale per tutti i depositi.
 */
export function chiaveValida(chiave: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(chiave)) throw new Error(`nome non valido nel deposito: ${chiave.slice(0, 40)}`);
  if (chiave === '.' || chiave === '..') throw new Error('nome non valido nel deposito');
  return chiave;
}

// ---------- in memoria, per i test ----------

/** Deposito che non tocca niente. Serve ai test e a chi prova l'app a vuoto. */
export class DepositoMemoria implements Deposito {
  private readonly dati = new Map<string, Uint8Array>();

  async leggi(chiave: string): Promise<Uint8Array | null> {
    return this.dati.get(chiaveValida(chiave)) ?? null;
  }

  async scrivi(chiave: string, dati: Uint8Array): Promise<void> {
    this.dati.set(chiaveValida(chiave), Uint8Array.from(dati));
  }

  async accoda(chiave: string, dati: Uint8Array): Promise<void> {
    const prima = this.dati.get(chiaveValida(chiave));
    if (!prima) return this.scrivi(chiave, dati);
    const out = new Uint8Array(prima.length + dati.length);
    out.set(prima, 0);
    out.set(dati, prima.length);
    this.dati.set(chiave, out);
  }

  async elimina(chiave: string): Promise<void> {
    this.dati.delete(chiaveValida(chiave));
  }

  async esiste(chiave: string): Promise<boolean> {
    return this.dati.has(chiaveValida(chiave));
  }
}
