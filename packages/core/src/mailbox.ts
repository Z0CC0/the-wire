// La mailbox: dove finiscono i messaggi quando l'altro e' offline.
//
// Il trasporto sta dietro un'interfaccia apposta. Oggi e' Nostr — gratis, senza
// registrazione, senza infrastruttura nostra — ma se un giorno i relay pubblici
// non bastano, si scrive una seconda implementazione e si cambia una riga di
// configurazione: il resto dell'app non se ne accorge.
//
// Quello che passa di qui e' gia' cifrato dal ratchet. La mailbox non e' un
// livello di sicurezza, e' un livello di consegna.

import { hex } from './codec.js';
import type { ContactCard } from './identity.js';

/**
 * Su quale corsia viaggia una busta.
 *
 * `messaggio` e' il traffico vero: cifrato dal ratchet, conservato dai relay,
 * recuperabile anche giorni dopo. `presenza` e' il battito che dice "ci sono":
 * non passa dal ratchet e non viene mai ripescato all'avvio. La distinzione non
 * e' cosmetica — vedi il commento su `send`.
 */
export type Canale = 'messaggio' | 'presenza';

export interface Inbound {
  /** Identificativo del trasporto: serve solo a non processare due volte lo stesso. */
  readonly id: string;
  readonly envelope: Uint8Array;
  readonly sentAt: number;
  /** Indirizzo di mailbox del mittente. Serve solo a instradare in fretta:
   *  la verita' su chi ha scritto la stabilisce il ratchet, non questo campo. */
  readonly from?: string;
  /** Assente vale `messaggio`: il caso normale. */
  readonly canale?: Canale;
}

export interface Mailbox {
  readonly kind: string;
  /**
   * Consegna una busta. Non garantisce che l'altro sia online.
   *
   * Il canale `presenza` esiste per una ragione precisa: il battito, se
   * passasse dal ratchet, ne consumerebbe una chiave ogni volta. Chi resta
   * spento un giorno tornerebbe con centinaia di chiavi da recuperare, e oltre
   * MAX_SKIP la sessione si rompe per sempre. Un battito perso non deve costare
   * niente, quindi viaggia fuori dal ratchet e nessuno lo va a ripescare.
   */
  send(to: ContactCard, envelope: Uint8Array, canale?: Canale): Promise<void>;
  /**
   * Ritira quello che e' arrivato mentre eravamo via.
   * `dopo` (secondi epoch) limita la finestra: senza, si ripescano sempre
   * settimane di roba gia' vista. Riguarda solo il canale `messaggio`: un
   * battito vecchio non dice niente di utile su chi e' online adesso.
   */
  receive(dopo?: number): Promise<Inbound[]>;
  /** Consegna in tempo reale finche' la funzione restituita non viene chiamata. */
  watch(onMessage: (m: Inbound) => void): () => void;
  close(): Promise<void>;
}

/**
 * Deduplica: pubblichiamo su piu' relay in parallelo, quindi lo stesso messaggio
 * torna indietro piu' volte. Tetto sulla dimensione per non crescere all'infinito
 * in una sessione lunga.
 */
export class SeenSet {
  private readonly order: string[] = [];
  private readonly set = new Set<string>();

  /** Nasce vuota, o da quello che era stato salvato l'ultima volta. */
  constructor(
    private readonly max = 5000,
    iniziali: readonly string[] = []
  ) {
    for (const id of iniziali.slice(-max)) this.add(id);
  }

  /** true se e' nuovo (e lo registra), false se gia' visto. */
  add(id: string): boolean {
    if (this.set.has(id)) return false;
    this.set.add(id);
    this.order.push(id);
    if (this.order.length > this.max) {
      const old = this.order.shift();
      if (old) this.set.delete(old);
    }
    return true;
  }

  /** Solo una domanda, senza registrare niente. */
  has(id: string): boolean {
    return this.set.has(id);
  }

  get size(): number {
    return this.set.size;
  }

  /** Da mettere nel deposito: senza, a ogni riavvio si riparte da zero e i
   *  messaggi gia' ricevuti tornano indietro come se fossero nuovi. */
  elenco(): string[] {
    return [...this.order];
  }
}

// ---------- implementazione in memoria, per i test ----------

/** Finto trasporto in-processo: stesso contratto, zero rete. */
export class MemoryMailbox implements Mailbox {
  readonly kind = 'memoria';
  private static boxes = new Map<string, Inbound[]>();
  private static watchers = new Map<string, Set<(m: Inbound) => void>>();
  private static counter = 0;
  private closed = false;

  constructor(private readonly ownAddress: string) {}

  static reset(): void {
    MemoryMailbox.boxes.clear();
    MemoryMailbox.watchers.clear();
    MemoryMailbox.counter = 0;
  }

  async send(to: ContactCard, envelope: Uint8Array, canale: Canale = 'messaggio'): Promise<void> {
    if (this.closed) throw new Error('mailbox chiusa');
    const address = hex(to.nostrPublic);
    const item: Inbound = {
      id: `mem-${++MemoryMailbox.counter}`,
      envelope,
      sentAt: Date.now(),
      from: this.ownAddress,
      canale,
    };
    // Come un relay vero: il messaggio resta depositato E viene spinto a chi
    // sta ascoltando. Chi riceve due volte lo stesso deve saperlo scartare.
    // Il battito no: se nessuno ascolta in questo momento, e' semplicemente
    // perso, ed e' quello che deve succedere anche qui — altrimenti i test
    // vedrebbero online chi non lo e'.
    if (canale === 'messaggio') {
      const box = MemoryMailbox.boxes.get(address) ?? [];
      box.push(item);
      MemoryMailbox.boxes.set(address, box);
    }
    for (const cb of MemoryMailbox.watchers.get(address) ?? []) cb(item);
  }

  async receive(dopo?: number): Promise<Inbound[]> {
    const box = MemoryMailbox.boxes.get(this.ownAddress) ?? [];
    // Come un relay vero: le buste RESTANO, leggerle non le consuma. Svuotare
    // la cassetta qui renderebbe questo doppio piu' comodo dell'originale, e
    // nasconderebbe proprio i difetti che deve far emergere — un messaggio che
    // non si e' potuto trattare al primo giro deve poter tornare al secondo.
    const da = dopo ? dopo * 1000 - 300_000 : 0;
    return box.filter((m) => m.sentAt >= da);
  }

  watch(onMessage: (m: Inbound) => void): () => void {
    const set = MemoryMailbox.watchers.get(this.ownAddress) ?? new Set();
    set.add(onMessage);
    MemoryMailbox.watchers.set(this.ownAddress, set);
    return () => set.delete(onMessage);
  }

  async close(): Promise<void> {
    this.closed = true;
    MemoryMailbox.watchers.delete(this.ownAddress);
  }
}
