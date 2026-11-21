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
// Basta che due persone ne abbiano almeno uno in comune — e dalla 0.1.2 non
// serve nemmeno quello: si pubblica sui relay su cui il destinatario ha detto
// di ascoltare (vedi `relay.ts`), e se nessuno risponde c'e' la riserva.

import { SimplePool } from 'nostr-tools/pool';
import { createRumor, createSeal, unwrapEvent } from 'nostr-tools/nip59';
import { encrypt as nip44Encrypt, getConversationKey } from 'nostr-tools/nip44';
import { finalizeEvent, generateSecretKey, type Event } from 'nostr-tools/pure';
import { b64u, hex, unb64u } from './codec.js';
import type { ContactCard, Identity } from './identity.js';
import { SeenSet, type Canale, type Inbound, type Mailbox } from './mailbox.js';
import { RELAY_RISERVA, relayPerInvio, type StatoRelay } from './relay.js';
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

/** Quanto si aspetta un relay per dire se c'e'. Oltre, per noi non c'e'. */
const ATTESA_CONTROLLO_MS = 6000;

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
  /** Dove ripiegare quando nessuno dei `relays` risponde. Vuoto = nessun piano B. */
  readonly riserva?: readonly string[];
  /** Da quanto indietro ritirare al primo collegamento. Default 14 giorni. */
  readonly lookbackSeconds?: number;
  readonly onRelayError?: (relay: string, error: unknown) => void;
}

interface Misura {
  ok: boolean;
  ms: number | null;
  errore: string | null;
  errori: number;
}

export class NostrMailbox implements Mailbox {
  readonly kind = 'nostr';
  private readonly pool = new SimplePool();
  private readonly relays: string[];
  private readonly riserva: string[];
  /**
   * La riserva e' entrata in gioco. Succede quando un controllo trova giu'
   * tutti i relay normali, o quando un invio e' riuscito SOLO sulla riserva:
   * da li' in poi si ascolta anche li', perche' e' li' che l'altro, nella
   * stessa situazione, sta pubblicando.
   */
  private inRiserva = false;
  private readonly seen = new SeenSet();
  private readonly lookback: number;
  private readonly onRelayError: (relay: string, error: unknown) => void;
  private readonly selfAddress: string;
  private readonly misure = new Map<string, Misura>();
  /** Gli ascolti aperti, per poterli riaprire quando l'insieme dei relay cambia. */
  private readonly ascolti = new Map<(m: Inbound) => void, () => void>();

  constructor(private readonly identity: Identity, options: NostrMailboxOptions = {}) {
    // Prima di tutto: dove Node non ha `WebSocket` fra i globali (Electron 33
    // porta Node 20) va messo a disposizione, o nessun relay risponde.
    assicuraWebSocket();
    this.relays = [...(options.relays ?? DEFAULT_RELAYS)];
    // La riserva non ripete quelli normali: sarebbero un piano B che cade
    // insieme al piano A.
    this.riserva = [...(options.riserva ?? RELAY_RISERVA)].filter((r) => !this.relays.includes(r));
    this.lookback = options.lookbackSeconds ?? 14 * 24 * 60 * 60;
    this.onRelayError = options.onRelayError ?? (() => {});
    this.selfAddress = hex(identity.nostrPublic);
    for (const r of [...this.relays, ...this.riserva]) this.misure.set(r, { ok: false, ms: null, errore: null, errori: 0 });
  }

  get address(): string {
    return this.selfAddress;
  }

  /** Su quali relay si ascolta in questo momento. */
  private get inAscolto(): string[] {
    return this.inRiserva ? [...this.relays, ...this.riserva] : [...this.relays];
  }

  /** Vero quando si sta ascoltando anche sulla riserva. */
  get riservaAttiva(): boolean {
    return this.inRiserva;
  }

  private misura(relay: string): Misura {
    let m = this.misure.get(relay);
    if (!m) {
      m = { ok: false, ms: null, errore: null, errori: 0 };
      this.misure.set(relay, m);
    }
    return m;
  }

  private segnaErrore(relay: string, errore: unknown): void {
    const m = this.misura(relay);
    m.ok = false;
    m.errori += 1;
    m.errore = String(errore instanceof Error ? errore.message : errore).slice(0, 160);
    this.onRelayError(relay, errore);
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

  /** Pubblica su un insieme di relay e dice quanti hanno accettato. */
  private async pubblica(relays: readonly string[], evento: Event): Promise<{ ok: number; motivo: string }> {
    if (!relays.length) return { ok: 0, motivo: 'nessun relay' };
    const results = await Promise.allSettled(this.pool.publish([...relays], evento));
    let ok = 0;
    let motivo = '';
    results.forEach((r, i) => {
      const relay = relays[i] ?? '?';
      if (r.status === 'rejected') {
        this.segnaErrore(relay, r.reason);
        // Il motivo del primo rifiuto vale piu' del conteggio: distingue
        // "internet non c'e'" da "i relay ci hanno detto no".
        if (!motivo) motivo = String(r.reason).slice(0, 120);
      } else {
        ok += 1;
        this.misura(relay).ok = true;
      }
    });
    return { ok, motivo: motivo || 'motivo ignoto' };
  }

  async send(
    to: ContactCard,
    envelope: Uint8Array,
    canale: Canale = 'messaggio',
    relayDestinatario?: readonly string[]
  ): Promise<void> {
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

    // Dove lui ascolta, piu' dove ascoltiamo noi. Pubblicare su tutti e
    // accettare che qualcuno fallisca: se anche uno solo prende il messaggio,
    // la consegna resta possibile.
    const bersagli = relayPerInvio(this.inAscolto, relayDestinatario);
    const primo = await this.pubblica(bersagli, wrapped);
    if (primo.ok > 0) return;

    // Il piano B. Non per il battito: un battito perso non costa niente, e
    // mandarlo in giro per la riserva ogni quarantacinque secondi riempirebbe
    // di tentativi inutili proprio il momento in cui la rete e' in difficolta'.
    if (!presenza && this.riserva.length) {
      const secondo = await this.pubblica(this.riserva, wrapped);
      if (secondo.ok > 0) {
        // Se noi siamo finiti qui, l'altro — con gli stessi relay giu' — ci
        // finira' pure: da adesso si ascolta anche la riserva.
        this.attivaRiserva();
        return;
      }
    }
    throw new Error(`nessuno dei ${bersagli.length} relay ha accettato il messaggio — ${primo.motivo}`);
  }

  /**
   * Da qui in poi si ascolta anche sulla riserva.
   *
   * Gli ascolti aperti vengono riaperti sull'insieme nuovo: una sottoscrizione
   * gia' in corso non si allarga, si rifa'.
   */
  attivaRiserva(): void {
    if (this.inRiserva || !this.riserva.length) return;
    this.inRiserva = true;
    for (const [cb, stop] of [...this.ascolti]) {
      stop();
      this.ascolti.set(cb, this.apriAscolto(cb));
    }
  }

  /**
   * Prova ad aprire il collegamento con ogni relay e misura quanto ci mette.
   *
   * Non pubblica niente: un controllo che scrive sui relay ogni volta che si
   * apre un pannello sarebbe traffico vuoto. Se nessuno di quelli normali
   * risponde, la riserva entra in ascolto da sola.
   */
  async controlla(soloNormali = false): Promise<StatoRelay[]> {
    // All'avvio si guardano solo quelli normali: aprire tre collegamenti in
    // piu' verso la riserva a ogni accensione sarebbe usarla quando non serve.
    const tutti = soloNormali ? [...this.relays] : [...this.relays, ...this.riserva];
    await Promise.all(
      tutti.map(async (relay) => {
        const m = this.misura(relay);
        const t0 = Date.now();
        try {
          await Promise.race([
            this.pool.ensureRelay(relay, { connectionTimeout: ATTESA_CONTROLLO_MS }),
            new Promise((_, rifiuta) => setTimeout(() => rifiuta(new Error('nessuna risposta')), ATTESA_CONTROLLO_MS)),
          ]);
          m.ok = true;
          m.ms = Date.now() - t0;
          m.errore = null;
        } catch (e) {
          m.ms = null;
          this.segnaErrore(relay, e);
        }
      })
    );
    if (this.relays.every((r) => !this.misura(r).ok)) this.attivaRiserva();
    return this.stato();
  }

  /** L'ultima fotografia dei relay, senza toccare la rete. */
  stato(): StatoRelay[] {
    const riga = (url: string, riserva: boolean): StatoRelay => {
      const m = this.misura(url);
      return { url, stato: m.ok ? 'ok' : 'ko', ms: m.ms, errore: m.errore, errori: m.errori, riserva };
    };
    return [...this.relays.map((r) => riga(r, false)), ...this.riserva.map((r) => riga(r, true))];
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
    const events = await this.pool.querySync(this.inAscolto, {
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

  private apriAscolto(onMessage: (m: Inbound) => void): () => void {
    const sub = this.pool.subscribeMany(
      this.inAscolto,
      // Qui sì il battito: in tempo reale è l'unico posto dove ha senso.
      { kinds: [WRAP_KIND, WRAP_PRESENZA], '#p': [this.selfAddress], since: Math.floor(Date.now() / 1000) },
      {
        onevent: (event: Event) => {
          const inbound = this.toInbound(event);
          if (inbound) onMessage(inbound);
        },
      }
    );
    return () => sub.close();
  }

  watch(onMessage: (m: Inbound) => void): () => void {
    this.ascolti.set(onMessage, this.apriAscolto(onMessage));
    return () => {
      const stop = this.ascolti.get(onMessage);
      this.ascolti.delete(onMessage);
      stop?.();
    };
  }

  async close(): Promise<void> {
    for (const stop of this.ascolti.values()) {
      try {
        stop();
      } catch {
        /* gia' chiusa */
      }
    }
    this.ascolti.clear();
    this.pool.close([...this.relays, ...this.riserva]);
  }
}
