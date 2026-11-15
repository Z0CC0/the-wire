// Mailbox su relay Nostr pubblici.
//
// Perche' Nostr e non un server nostro: niente registrazione, niente carta di
// credito, niente macchina da tenere accesa. I relay conservano il messaggio
// finche' il destinatario non lo ritira.
//
// Il relay NON vede: il contenuto (doppia cifratura, ratchet piu' NIP-44), ne'
// chi scrive a chi (l'involucro NIP-59 e' firmato da una chiave usa-e-getta, e
// l'unico riferimento visibile e' il destinatario).
//
// Pubblichiamo su piu' relay in parallelo: sono volontari, sparire e' normale.
// Basta che due persone ne abbiano almeno uno in comune.

import { SimplePool } from 'nostr-tools/pool';
import { createRumor, createSeal, unwrapEvent } from 'nostr-tools/nip59';
import { encrypt as nip44Encrypt, getConversationKey } from 'nostr-tools/nip44';
import { finalizeEvent, generateSecretKey, type Event } from 'nostr-tools/pure';
import { b64u, hex, unb64u } from './codec.js';
import type { ContactCard, Identity } from './identity.js';
import { SeenSet, type Canale, type Inbound, type Mailbox } from './mailbox.js';
import { assicuraWebSocket } from './websocket.js';

/** Kind 14 = messaggio privato NIP-17: ci confondiamo col traffico normale. */
const RUMOR_KIND = 14;
const WRAP_KIND = 1059;

/**
 * Il battito viaggia su numeri suoi, nella fascia 20000-29999 che per NIP-01 e'
 * "effimera": i relay la ritrasmettono a chi e' collegato in quel momento e non
 * sono tenuti a conservarla. Provato sui cinque relay: tutti e cinque
 * accettano e ritrasmettono, uno conserva comunque. Non e' un problema, perche'
 * il recupero all'avvio chiede solo il kind 1059 e questi numeri li ignora — un
 * battito di ieri non lo va a leggere nessuno.
 */
const RUMOR_PRESENZA = 20014;
const WRAP_PRESENZA = 20059;

/** Cinque minuti di margine sul punto di ripresa: gli orologi non coincidono. */
const MARGINE_SECONDI = 300;

/**
 * Scelti fra quelli che rispondono davvero: provati uno per uno, tenuti quelli
 * che accettano un evento gift wrap in tempi ragionevoli. Averne di piu' non
 * aggiunge ridondanza se poi vanno in timeout — aggiunge solo attesa.
 */
export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://nostr.mom',
  'wss://relay.snort.social',
] as const;

export interface NostrMailboxOptions {
  readonly relays?: readonly string[];
  /** Da quanto indietro ritirare al primo collegamento. Default 14 giorni. */
  readonly lookbackSeconds?: number;
  readonly onRelayError?: (relay: string, error: unknown) => void;
}

export class NostrMailbox implements Mailbox {
  readonly kind = 'nostr';
  private readonly pool = new SimplePool();
  private readonly relays: string[];
  private readonly seen = new SeenSet();
  private readonly lookback: number;
  private readonly onRelayError: (relay: string, error: unknown) => void;
  private readonly selfAddress: string;
  private closers: Array<() => void> = [];

  constructor(private readonly identity: Identity, options: NostrMailboxOptions = {}) {
    // Prima di tutto: dove Node non ha `WebSocket` fra i globali (Electron 33
    // porta Node 20) va messo a disposizione, o nessun relay risponde.
    assicuraWebSocket();
    this.relays = [...(options.relays ?? DEFAULT_RELAYS)];
    this.lookback = options.lookbackSeconds ?? 14 * 24 * 60 * 60;
    this.onRelayError = options.onRelayError ?? (() => {});
    this.selfAddress = hex(identity.nostrPublic);
  }

  get address(): string {
    return this.selfAddress;
  }

  /**
   * Involucro NIP-59 fatto a mano, per poter scegliere il kind esterno.
   * Identico a quello della libreria salvo due cose: il numero, e l'orario.
   * La libreria sposta `created_at` fino a due giorni indietro per confondere
   * le acque, che sui messaggi va benissimo; su un battito significherebbe
   * farsi scartare dai relay che applicano il filtro `since`, e un battito
   * datato ieri non vuol dire niente.
   */
  private involucro(seal: Event, destinatario: string, kind: number): Event {
    const usaEGetta = generateSecretKey();
    return finalizeEvent(
      {
        kind,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', destinatario]],
        content: nip44Encrypt(JSON.stringify(seal), getConversationKey(usaEGetta, destinatario)),
      },
      usaEGetta
    );
  }

  async send(to: ContactCard, envelope: Uint8Array, canale: Canale = 'messaggio'): Promise<void> {
    const destinatario = hex(to.nostrPublic);
    const presenza = canale === 'presenza';
    const rumor = createRumor(
      {
        kind: presenza ? RUMOR_PRESENZA : RUMOR_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', destinatario]],
        content: b64u(envelope),
      },
      this.identity.nostrSecret
    );
    const seal = createSeal(rumor, this.identity.nostrSecret, destinatario);
    const wrapped = this.involucro(seal, destinatario, presenza ? WRAP_PRESENZA : WRAP_KIND);

    // Pubblicare su tutti e accettare che qualcuno fallisca: se anche uno solo
    // dei relay prende il messaggio, la consegna resta possibile.
    const results = await Promise.allSettled(this.pool.publish(this.relays, wrapped));
    results.forEach((r, i) => {
      if (r.status === 'rejected') this.onRelayError(this.relays[i] ?? '?', r.reason);
    });
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    if (ok === 0) {
      // Il motivo del primo rifiuto vale piu' del conteggio: distingue "internet
      // non c'e'" da "i relay ci hanno detto no".
      const primo = results.find((r) => r.status === 'rejected');
      const motivo = primo && primo.status === 'rejected' ? String(primo.reason).slice(0, 120) : 'motivo ignoto';
      throw new Error(`nessuno dei ${this.relays.length} relay ha accettato il messaggio — ${motivo}`);
    }
  }

  private toInbound(event: Event): Inbound | null {
    if (!this.seen.add(event.id)) return null;
    try {
      const rumor = unwrapEvent(event, this.identity.nostrSecret);
      if (rumor.kind !== RUMOR_KIND && rumor.kind !== RUMOR_PRESENZA) return null;
      return {
        id: event.id,
        envelope: unb64u(rumor.content),
        sentAt: rumor.created_at * 1000,
        from: rumor.pubkey,
        canale: rumor.kind === RUMOR_PRESENZA ? 'presenza' : 'messaggio',
      };
    } catch {
      // Involucro non per noi, o malformato. Non e' un errore: sui relay
      // pubblici passa di tutto.
      return null;
    }
  }

  async receive(dopo?: number): Promise<Inbound[]> {
    // Da dove riprendere: l'ultimo ritiro riuscito, meno un margine per gli
    // orologi che non coincidono e per i relay che consegnano in ritardo.
    // Senza un punto di ripresa si ripescano sempre 14 giorni.
    const minimo = Math.floor(Date.now() / 1000) - this.lookback;
    const since = dopo ? Math.max(minimo, dopo - MARGINE_SECONDI) : minimo;
    const events = await this.pool.querySync(this.relays, {
      kinds: [WRAP_KIND],
      '#p': [this.selfAddress],
      since,
    });
    const out: Inbound[] = [];
    for (const event of events) {
      const inbound = this.toInbound(event);
      if (inbound) out.push(inbound);
    }
    return out.sort((a, b) => a.sentAt - b.sentAt);
  }

  watch(onMessage: (m: Inbound) => void): () => void {
    const sub = this.pool.subscribeMany(
      this.relays,
      // Qui sì il battito: in tempo reale è l'unico posto dove ha senso.
      { kinds: [WRAP_KIND, WRAP_PRESENZA], '#p': [this.selfAddress], since: Math.floor(Date.now() / 1000) },
      {
        onevent: (event: Event) => {
          const inbound = this.toInbound(event);
          if (inbound) onMessage(inbound);
        },
      }
    );
    const stop = () => sub.close();
    this.closers.push(stop);
    return stop;
  }

  async close(): Promise<void> {
    for (const stop of this.closers) {
      try {
        stop();
      } catch {
        /* gia' chiusa */
      }
    }
    this.closers = [];
    this.pool.close(this.relays);
  }
}
