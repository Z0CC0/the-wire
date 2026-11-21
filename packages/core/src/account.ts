// Account: l'oggetto che usano entrambe le facce, la finestra sul PC e il telefono.
//
// Tiene insieme identita', contatti, gruppi, sessioni, storico e mailbox. Sopra
// di lui non c'e' nessuna logica di protocollo: la finestra e il server per il
// telefono chiamano gli stessi metodi e ottengono lo stesso comportamento, per
// costruzione.

import type { Deposito } from './deposito.js';
import { identificativo } from './casuale.js';
import { cat, hex, te, unhex, b64u, unb64u } from './codec.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { codiceFromUri, codiceToUri, nuovoCodice } from './collegamento.js';
import { MAX_DISPOSITIVI, dispositivoValido, type ChiaveAccount } from './dispositivi.js';
import {
  cardAccountFromUri,
  cardAccountToUri,
  creaChiaveAccount,
  daTrasporto,
  dispositiviValidi,
  firmaDispositivo,
  improntaAccount,
  numeroDaImpronte,
  perTrasporto,
  type CardAccount,
  type Dispositivo,
} from './dispositivi.js';
import {
  addressOf,
  cardFromUri,
  cardOf,
  cardToUri,
  createIdentity,
  decodeCard,
  encodeCard,
  safetyNumber,
  verifyCard,
  type ContactCard,
  type Identity,
} from './identity.js';
import { historyKey, openVaultKeyed, resealVault, sealVault, type Vault } from './keystore.js';
import { validaTurn, type ServerTurn } from './turn.js';
import { RELAY_RISERVA, normalizzaRelay, type StatoRelay } from './relay.js';
import { SEGNO_RIPRISTINO, impacchetta, spacchetta, type VoceBackup } from './backup.js';
import { comprimi, decomprimi } from './compressione.js';
import { FileStore, fileKey } from './filestore.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { History, type Message } from './history.js';
import { decodeEnvelope } from './envelope.js';
import { Session } from './session.js';
import { DEFAULT_RELAYS, NostrMailbox } from './mailbox-nostr.js';
import { SeenSet, type Inbound, type Mailbox } from './mailbox.js';
/**
 * Cio' che l'Account chiede a una serratura: solo di potersi aprire.
 *
 * Il tipo sta qui e non in `lock.ts` perche' quel file importa `node:fs`, e
 * importarlo in cima terrebbe l'intero cuore fuori da un browser. Sul telefono
 * la serratura non serve — c'e' una scheda sola per deposito — e si passa una
 * serratura che non fa niente.
 */
export interface Serratura {
  release(): Promise<void>;
}

/** Serratura per chi non ne ha bisogno: il browser. */
export const SENZA_SERRATURA: Serratura = { release: async () => {} };
import {
  decodePayload,
  encodePayload,
  type FileOfferPayload,
  type Payload,
  type RosterEntry,
  type RtcPayload,
  type StoricoOfferPayload,
} from './payload.js';
import {
  DEFAULT_TOPIC,
  findTopic,
  mergeGroup,
  newGroupId,
  newTopicId,
  stateOf,
  type Group,
  type GroupTopic,
} from './group.js';

export interface Contact {
  /** Identificativo della PERSONA: esadecimale della sua chiave d'account. */
  readonly id: string;
  readonly name: string;
  /** La sua chiave d'account. */
  readonly account: Uint8Array;
  /** Tutti i suoi dispositivi. A ciascuno si scrive separatamente. */
  readonly dispositivi: readonly Dispositivo[];
  /** null finche' il numero di sicurezza non e' stato confrontato a voce. */
  readonly verifiedAt: number | null;
}

/** Versione del registro dei ritiri. Alzarla svuota il registro all'apertura
 *  successiva: serve quando quel registro e' stato riempito male. */
const RIPRESA_VERSIONE = 2;

/**
 * Ogni quanto si annuncia, e per quanto vale un annuncio ricevuto.
 *
 * La finestra e' larga piu' del doppio del battito apposta: un battito perso
 * (sui relay pubblici capita) non deve far sparire nessuno dall'elenco. Serve
 * mancarne tre di fila, e a quel punto e' vero che dall'altra parte non c'e'
 * piu' nessuno.
 */
export const BATTITO_MS = 45_000;
export const FINESTRA_ONLINE_MS = 150_000;
/**
 * Oltre questo peso il file non passa piu' dalla mailbox.
 *
 * Non e' un numero scelto a sentimento. Misurato sui cinque relay: passano
 * 16 KB utili per evento (54 KB sul filo, dopo doppia cifratura e base64) e
 * la velocita' sostenuta e' di circa 59 KB/s. Cinque megabyte sono gia' un
 * minuto e mezzo e trecentoventi eventi su infrastruttura di volontari.
 * Sopra, si passa dal collegamento diretto, che vuole entrambi collegati.
 */
export const SOGLIA_MAILBOX = 5 * 1024 * 1024;
/** Misurato: 16 KB utili sono accettati da tutti e cinque i relay, 32 solo da tre. */
export const PEZZO_FILE = 16 * 1024;

/**
 * Il deposito su cartella, caricato solo quando serve.
 *
 * L'import e' dentro la funzione apposta: `deposito-file.ts` importa
 * `node:fs`, e un browser che caricasse `account.ts` morirebbe al primo
 * import se stesse in cima al file. Cosi' invece quel modulo viene toccato
 * solo da chi passa da una cartella, cioe' mai sul telefono.
 */
async function depositoPerCartella(dir: string): Promise<Deposito> {
  const { DepositoFile } = await import('./deposito-file.js');
  return new DepositoFile(dir);
}

/** Anche la serratura vive dietro Node, e si carica solo su una cartella. */
async function serraturaPerCartella(dir: string): Promise<Serratura> {
  const { VaultLock } = await import('./lock.js');
  return VaultLock.acquire(dir);
}

export const VAULT_FILE = 'wire.vault';
export const HISTORY_FILE = 'wire.history';

/**
 * Dove vivono i dati sul computer.
 *
 * Sta in `deposito-file.ts`, che e' il file che gia' parla con Node, e si
 * raggiunge solo passando di li'. Qui resta il nome, perche' il resto del
 * programma lo chiama cosi' da sempre.
 */
export async function defaultDataDir(): Promise<string> {
  const { cartellaPredefinita } = await import('./deposito-file.js');
  return cartellaPredefinita();
}

/** Un trasferimento dalla mailbox mentre e' ancora a meta'. */
interface InArrivo {
  readonly offerta: FileOfferPayload;
  readonly da: string;
  readonly messaggio: string;
  readonly pezzi: (Uint8Array | undefined)[];
  arrivati: number;
}

/** Lo storico che sta arrivando da un proprio dispositivo, a pezzi. */
interface StoricoInArrivo {
  readonly offerta: StoricoOfferPayload;
  readonly pezzi: (Uint8Array | undefined)[];
  arrivati: number;
}

/** Cosa viaggia dal primo dispositivo a quello nuovo, dentro `storico.*`. */
interface PaccoStorico {
  readonly v: 1;
  readonly messaggi: readonly Message[];
  readonly gruppi: readonly Group[];
  readonly nome: string;
}

export class Account {
  private mailbox: Mailbox | null = null;
  /** La mailbox l'ha creata questo account, e puo' rifarla da capo quando i
   *  relay cambiano. Quella passata dai test no: non si tocca. */
  private mailboxInterna = false;
  private mailboxLive = true;
  private unwatch: (() => void) | null = null;
  private readonly storiciInArrivo = new Map<string, StoricoInArrivo>();
  private readonly osservatoriStorico = new Set<(quanti: number) => void>();
  /** I trasferimenti diretti che stanno avvenendo adesso: vivono qui e non
   *  sul disco, perche' l'avanzamento non serve piu' un minuto dopo. */
  private inTransito = new Map<string, Message>();

  private readonly listeners = new Set<(m: Message) => void>();
  /**
   * Le sessioni aperte con ciascun contatto. Piu' di una, apposta.
   *
   * Se due persone si scrivono per prime nello stesso momento, ciascuna apre
   * una sessione sua con X3DH. Tenendone una sola per contatto, accettare
   * quella dell'altro cancellava la propria: da quel momento ognuno cifrava
   * con una sessione che l'altro non aveva piu', e nessun messaggio si apriva
   * — mentre il pallino restava acceso, perche' il battito non passa dal
   * ratchet. Ora si tiene la propria per scrivere e si accettano le altre per
   * leggere; la prima dell'elenco e' quella con cui si manda.
   */
  private readonly sessions = new Map<string, Session[]>();
  /** Oltre questo numero non si accetta piu': un contatto che apre sessioni
   *  all'infinito non deve poter far crescere il deposito senza limite. */
  private static readonly MAX_SESSIONI = 8;
  /** Lo stesso messaggio puo' arrivare due volte: dalla consegna in tempo reale
   *  e dal recupero all'avvio. Il ratchet lo scarterebbe comunque, ma scartarlo
   *  qui costa un confronto invece di una decifratura fallita. */
  private readonly seen: SeenSet;
  /** Ultimo segno di vita per contatto, con l'orologio nostro. */
  private readonly presenze = new Map<string, number>();
  private battito: ReturnType<typeof setInterval> | null = null;
  private readonly osservatori = new Set<(id: string, at: number) => void>();
  private readonly files: FileStore;
  /** Trasferimenti dalla mailbox ancora a meta'. Vivono in memoria: un
   *  trasferimento interrotto da un riavvio si rifa', non si ricuce. */
  private readonly inArrivo = new Map<string, InArrivo>();
  private readonly segnalatori = new Set<(da: string, p: RtcPayload) => void>();

  private constructor(
    private readonly deposito: Deposito,
    /** Solo quando il deposito e' una cartella vera. */
    private readonly cartella: string | null,
    private vault: Vault,
    private readonly vaultKey: Uint8Array,
    private readonly vaultSalt: Uint8Array,
    private readonly history: History,
    /** Il deposito e' preso finche' questo account e' aperto. */
    private readonly lock: Serratura
  ) {
    // Una versione precedente segnava le buste come viste PRIMA di provare ad
    // aprirle: quelle arrivate da uno sconosciuto, o quando la sessione non era
    // pronta, sono finite nel registro senza essere mai state lette, e cosi'
    // sono sparite. Il registro di quella versione non e' attendibile: si butta
    // una volta sola, e si riguarda indietro nella mailbox.
    const registro = vault.mailbox ?? { seen: [], since: 0 };
    if ((registro.v ?? 0) < RIPRESA_VERSIONE) {
      registro.seen = [];
      registro.since = 0;
      registro.v = RIPRESA_VERSIONE;
    }
    // Cosa era gia' arrivato: senza ripartire da qui, i relay riconsegnano le
    // ultime due settimane e ogni avvio sembra una valanga di messaggi nuovi.
    this.seen = new SeenSet(5000, registro.seen);

    for (const [id, at] of Object.entries(vault.presenze ?? {})) {
      if (typeof at === 'number' && Number.isFinite(at)) this.presenze.set(id, at);
    }

    this.files = new FileStore(deposito, fileKey(vaultKey));

    for (const [id, elenco] of Object.entries(vault.sessions)) {
      const aperte: Session[] = [];
      for (const json of elenco) {
        try {
          aperte.push(Session.restore(json));
        } catch {
          // Sessione di una versione precedente o corrotta: si salta questa,
          // non tutte quelle del contatto.
        }
      }
      if (aperte.length) this.sessions.set(id, aperte);
    }
  }

  // ---------- apertura ----------

  static async create(passphrase: string, dir?: string, nomeDispositivo?: string): Promise<Account> {
    const cartella = dir ?? (await defaultDataDir());
    const deposito = await depositoPerCartella(cartella);
    const lock = await serraturaPerCartella(cartella);
    try {
      const identity = createIdentity();
      // L'account nasce col primo dispositivo, e da li' in poi e' lui a tenere
      // insieme tutti gli altri. La sua chiave privata viene passata ai
      // dispositivi che colleghi: e' cio' che permette a ciascuno di firmare
      // l'aggiunta dei successivi.
      const chiave = creaChiaveAccount();
      const primo = firmaDispositivo(chiave, cardOf(identity), nomeDispositivo ?? 'primo dispositivo');
      const vault: Vault = {
        identity,
        account: { secret: hex(chiave.secret), publicKey: hex(chiave.publicKey) },
        dispositivi: [perTrasporto(primo)],
        sessions: {},
        contacts: {},
        groups: {},
        mailbox: { seen: [], since: 0, v: RIPRESA_VERSIONE },
        viste: {},
        profile: { name: '' },
        presenze: {},
        rete: { turn: null, relay: null },
      };
      // Se c'e' gia' un deposito, fallire invece di sovrascrivere l'identita'.
      if (await deposito.esiste(VAULT_FILE)) throw new Error('esiste gia un deposito in questa cartella');
      await deposito.scrivi(VAULT_FILE, sealVault(vault, passphrase));
      return await Account.apri(passphrase, deposito, lock, cartella);
    } catch (e) {
      await lock.release();
      throw e;
    }
  }

  /**
   * Il deposito si prende PRIMA di leggerlo: due programmi che avanzano lo
   * stesso ratchet bruciano gli stessi numeri di messaggio, e quei messaggi
   * il destinatario li rifiuta per sempre.
   */
  static async open(passphrase: string, dir?: string): Promise<Account> {
    const cartella = dir ?? (await defaultDataDir());
    const deposito = await depositoPerCartella(cartella);
    const lock = await serraturaPerCartella(cartella);
    try {
      return await Account.apri(passphrase, deposito, lock, cartella);
    } catch (e) {
      await lock.release();
      throw e;
    }
  }

  /**
   * Apre un deposito gia' esistente, qualunque esso sia.
   *
   * Da qui in giu' l'Account non sa piu' se sta scrivendo su un disco o dentro
   * il browser di un telefono: chiede a un deposito, e basta. E' cio' che
   * permette allo stesso cuore di girare in tutti e due i posti.
   */
  static async apriDeposito(passphrase: string, deposito: Deposito, lock: Serratura): Promise<Account> {
    return Account.apri(passphrase, deposito, lock, null);
  }

  /**
   * Crea un'identita' dentro un deposito qualunque.
   *
   * La stessa cosa che fa `create`, senza presupporre una cartella: sul
   * telefono il deposito e' IndexedDB, e non c'e' nessun percorso da creare
   * ne' nessuna serratura da prendere — una scheda sola per deposito.
   */
  static async creaSuDeposito(
    passphrase: string,
    deposito: Deposito,
    lock: Serratura,
    nomeDispositivo = 'questo dispositivo'
  ): Promise<Account> {
    if (await deposito.esiste(VAULT_FILE)) throw new Error('esiste gia un deposito qui');
    const identity = createIdentity();
    const chiave = creaChiaveAccount();
    const primo = firmaDispositivo(chiave, cardOf(identity), nomeDispositivo);
    const vault: Vault = {
      identity,
      account: { secret: hex(chiave.secret), publicKey: hex(chiave.publicKey) },
      dispositivi: [perTrasporto(primo)],
      sessions: {},
      contacts: {},
      groups: {},
      mailbox: { seen: [], since: 0, v: RIPRESA_VERSIONE },
      viste: {},
      profile: { name: '' },
      presenze: {},
      rete: { turn: null, relay: null },
    };
    await deposito.scrivi(VAULT_FILE, sealVault(vault, passphrase));
    return Account.apri(passphrase, deposito, lock, null);
  }

  private static async apri(
    passphrase: string,
    deposito: Deposito,
    lock: Serratura,
    cartella: string | null = null
  ): Promise<Account> {
    const bytes = await deposito.leggi(VAULT_FILE);
    if (!bytes) throw new Error('nessun deposito da aprire');
    const { vault, key, salt } = openVaultKeyed(bytes, passphrase);
    const account = new Account(
      deposito,
      cartella,
      vault,
      key,
      salt,
      new History(deposito, HISTORY_FILE, historyKey(key)),
      lock
    );
    // Un deposito appena ripristinato da un backup ha sessioni ferme al
    // momento del backup: si sistemano qui, una volta sola, con la chiave
    // gia' in mano.
    if (await deposito.esiste(SEGNO_RIPRISTINO)) await account.dopoRipristino();
    return account;
  }

  // ---------- backup ----------

  /**
   * Il deposito intero in un file: le chiavi (cifrate con la passphrase), lo
   * storico e i file ricevuti (cifrati con chiavi derivate). Niente viene
   * decifrato per farlo, e niente lo apre senza la passphrase dell'account.
   */
  async esportaBackup(): Promise<Uint8Array> {
    await this.save();
    const voci: VoceBackup[] = [];
    for (const nome of [VAULT_FILE, HISTORY_FILE]) {
      const dati = await this.deposito.leggi(nome);
      if (dati) voci.push({ nome, dati });
    }
    // I file ricevuti dalla mailbox stanno nel magazzino cifrato e si portano.
    // Quelli arrivati dal collegamento diretto stanno dove li ha messi chi li
    // ha ricevuti, in chiaro e per sua scelta: non sono roba del deposito.
    const visti = new Set<string>();
    for (const m of await this.history.all()) {
      const f = m.file;
      if (!f || f.via !== 'mailbox' || f.stato !== 'pronto' || visti.has(f.id)) continue;
      visti.add(f.id);
      const dati = await this.deposito.leggi(`file-${f.id}`);
      if (dati) voci.push({ nome: `file-${f.id}`, dati });
    }
    return impacchetta(voci);
  }

  /**
   * Rimette un backup in un deposito VUOTO. Poi si apre con la passphrase di
   * sempre, come un deposito qualunque.
   *
   * Solo vuoto, e non e' una cautela: scrivere un backup sopra un deposito
   * vivo lo porterebbe indietro nel tempo, sessioni comprese.
   */
  static async ripristinaSuDeposito(bytes: Uint8Array, deposito: Deposito): Promise<{ voci: number; creato: number }> {
    if (await deposito.esiste(VAULT_FILE)) {
      throw new Error('qui c e gia un deposito: il ripristino vale solo su un dispositivo che non ne ha');
    }
    const backup = spacchetta(bytes);
    if (!backup.voci.some((v) => v.nome === VAULT_FILE)) throw new Error('il backup non contiene il deposito delle chiavi');
    for (const v of backup.voci) await this.scriviVoceBackup(deposito, v);
    await deposito.scrivi(SEGNO_RIPRISTINO, te.encode(String(backup.creato)));
    return { voci: backup.voci.length, creato: backup.creato };
  }

  /** Solo i nomi che un deposito di THE WIRE puo' avere: il resto non si scrive. */
  private static async scriviVoceBackup(deposito: Deposito, v: VoceBackup): Promise<void> {
    if (v.nome !== VAULT_FILE && v.nome !== HISTORY_FILE && !/^file-[0-9a-f]{8,128}$/.test(v.nome)) return;
    await deposito.scrivi(v.nome, v.dati);
  }

  static async ripristinaBackup(bytes: Uint8Array, dir?: string): Promise<{ voci: number; creato: number }> {
    const cartella = dir ?? (await defaultDataDir());
    return Account.ripristinaSuDeposito(bytes, await depositoPerCartella(cartella));
  }

  /**
   * La prima apertura dopo un ripristino.
   *
   * Le sessioni nel backup sono ferme al giorno del backup, mentre i contatti
   * da allora sono andati avanti: scrivere con quelle vorrebbe dire riusare
   * numeri di messaggio gia' usati, e l'altro li scarterebbe per sempre. Si
   * apre una sessione nuova per scrivere a ogni dispositivo noto — il primo
   * messaggio portera' il blocco X3DH, che l'altro accetta — e le vecchie
   * restano dietro, per leggere quello che e' arrivato nel frattempo.
   */
  private async dopoRipristino(): Promise<void> {
    const tutti = [...this.contacts().flatMap((c) => c.dispositivi), ...this.altriMiei()];
    for (const d of tutti) {
      if (!verifyCard(d.card)) continue;
      const aperte = this.sessions.get(d.id) ?? [];
      this.sessions.set(d.id, [Session.start(this.vault.identity, d.card), ...aperte].slice(0, Account.MAX_SESSIONI));
    }
    // Il punto di ripresa torna indietro: quello che e' arrivato dopo il
    // backup sta ancora sui relay, e si ripesca.
    this.vault.mailbox.since = 0;
    await this.deposito.elimina(SEGNO_RIPRISTINO);
    await this.record({
      peer: this.id,
      mine: false,
      text: 'Account ripristinato da un backup. Le conversazioni ripartono con sessioni nuove: il primo messaggio a ciascun contatto riapre il collegamento.',
      at: Date.now(),
      system: true,
    });
  }

  static async exists(dir?: string): Promise<boolean> {
    return (await depositoPerCartella(dir ?? (await defaultDataDir()))).esiste(VAULT_FILE);
  }

  // ---------- identita' ----------

  get identity(): Identity {
    return this.vault.identity;
  }

  /** La card di QUESTO dispositivo. Serve al ratchet, non a farsi riconoscere. */
  get card(): ContactCard {
    return cardOf(this.vault.identity);
  }

  /** La chiave che tiene insieme i propri dispositivi. */
  get accountPublic(): Uint8Array {
    return unhex(this.vault.account.publicKey);
  }

  /** I propri dispositivi, questo compreso. */
  get dispositivi(): Dispositivo[] {
    return dispositiviValidi(this.accountPublic, this.vault.dispositivi.map(daTrasporto));
  }

  /** La propria card: account e dispositivi. Da incollare all'altro. */
  get cardAccount(): CardAccount {
    return { account: this.accountPublic, dispositivi: this.dispositivi };
  }

  /**
   * La riga da dare all'altro.
   *
   * Non ci sta in un QR: con due dispositivi supera i milleottocento
   * caratteri, e a quella densita' un telefono fatica a leggerlo. Si incolla,
   * come si faceva prima — e serve solo la prima volta: i dispositivi aggiunti
   * dopo viaggiano sul ratchet, non a mano.
   */
  get uri(): string {
    return cardAccountToUri(this.cardAccount);
  }

  get address(): string {
    return this.vault.account.publicKey.slice(0, 12);
  }

  /** Identificativo della persona: la sua chiave d'account. */
  get id(): string {
    return this.vault.account.publicKey;
  }

  /** Identificativo di QUESTO dispositivo. Serve al ratchet e alle sessioni. */
  get idDispositivo(): string {
    return hex(this.vault.identity.sigPublic);
  }

  /** Dove stanno i dati, quando "dove" ha un senso. Sul telefono il deposito
   *  sta dentro il browser e non ha un percorso da mostrare. */
  get dataDir(): string {
    return this.cartella ?? '(dentro il browser)';
  }

  /** Il nome con cui gli altri ti vedono nei gruppi. */
  get displayName(): string {
    return this.vault.profile.name || this.address;
  }

  async setDisplayName(name: string): Promise<void> {
    this.vault = { ...this.vault, profile: { name: name.trim().slice(0, 60) } };
    await this.save();
  }

  // ---------- contatti ----------

  contacts(): Contact[] {
    return Object.entries(this.vault.contacts)
      .map(([id, c]) => {
        const account = unhex(c.account);
        return {
          id,
          name: c.name,
          account,
          // Rivalidati a ogni lettura: cio' che sta nel deposito e' arrivato
          // da fuori, e una firma va ricontrollata dove viene usata.
          dispositivi: dispositiviValidi(account, c.dispositivi.map(daTrasporto)),
          verifiedAt: c.verifiedAt,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  contact(idOrName: string): Contact | undefined {
    const needle = idOrName.trim().toLowerCase();
    const all = this.contacts();
    return (
      all.find((c) => c.id === needle) ??
      all.find((c) => c.name.toLowerCase() === needle) ??
      all.find((c) => c.name.toLowerCase().startsWith(needle)) ??
      all.find((c) => c.id.startsWith(needle))
    );
  }

  async addContact(uri: string, name: string): Promise<Contact> {
    // Verifica la chiave d'account e ogni firma, o lancia.
    const c = await this.storeContact(cardAccountFromUri(uri), name);
    // Un contatto aggiunto su un dispositivo deve comparire anche sugli altri,
    // o le due rubriche divergono al primo contatto nuovo. La propagazione sta
    // qui e non in `storeContact` apposta: `storeContact` viene chiamato anche
    // QUANDO si riceve una rubrica, e rimandarla indietro sarebbe un rimbalzo
    // senza fine.
    await this.mandaAiMiei({
      v: 1,
      t: 'rubrica',
      contatti: [{ nome: c.name, card: cardAccountToUri({ account: c.account, dispositivi: c.dispositivi }) }],
    });
    return c;
  }

  private async storeContact(card: CardAccount, name: string): Promise<Contact> {
    const id = hex(card.account);
    if (id === this.id) throw new Error('questa e la tua card, non quella di un contatto');
    if (this.vault.contacts[id]) throw new Error(`contatto gia presente: ${this.vault.contacts[id]!.name}`);
    const dispositivi = dispositiviValidi(card.account, card.dispositivi);
    if (!dispositivi.length) throw new Error('card non valida: nessun dispositivo con una firma valida');
    this.vault.contacts[id] = {
      name: name.trim() || id.slice(0, 8),
      account: hex(card.account),
      dispositivi: dispositivi.map(perTrasporto),
      verifiedAt: null,
    };
    // Le buste arrivate prima di conoscerlo ora si possono aprire: il punto di
    // ripresa torna indietro, cosi' il prossimo ritiro le ripesca.
    this.vault.mailbox.since = 0;
    await this.save();
    return { id, name: this.vault.contacts[id]!.name, account: card.account, dispositivi, verifiedAt: null };
  }

  /**
   * Svuota la conversazione, lasciando il contatto in rubrica.
   *
   * Le sessioni NON si toccano: buttarle costringerebbe entrambi a rifare la
   * cifratura, e chi vuole solo ripulire una conversazione non si aspetta di
   * far smettere di funzionare i messaggi. Anche i file allegati se ne vanno,
   * o resterebbero nel magazzino senza piu' niente che li nomini.
   */
  async svuotaConversazione(id: string): Promise<void> {
    for (const m of await this.history.forPeer(id)) {
      if (m.file) await this.files.elimina(m.file.id);
    }
    await this.history.forgetPeer(id);
    await this.save();
  }

  /**
   * Toglie il contatto dalla rubrica, e con lui tutto il resto.
   *
   * Sparisce anche la verifica del numero di sicurezza: riaggiungendolo si
   * riparte da "da verificare", ed e' giusto cosi' — la card andra' riavuta,
   * e nessuno puo' garantire che sia la stessa.
   */
  async removeContact(id: string): Promise<void> {
    for (const m of await this.history.forPeer(id)) {
      if (m.file) await this.files.elimina(m.file.id);
    }
    delete this.vault.contacts[id];
    delete this.vault.sessions[id];
    this.sessions.delete(id);
    // Anche le tracce che restavano indietro: senza, il deposito conservava
    // l'ultimo avvistamento e lo stato archiviato di un contatto inesistente.
    delete this.vault.viste[id];
    delete this.vault.presenze[id];
    this.presenze.delete(id);
    await this.history.forgetPeer(id);
    await this.save();
  }

  /**
   * Le 60 cifre da leggersi a voce. Devono coincidere sui due schermi.
   *
   * Coprono l'insieme dei dispositivi, non una card sola: cosi' il numero
   * CAMBIA appena uno dei due collega un telefono. E' fastidioso, ed e'
   * l'unica cosa che vi fa accorgere di un dispositivo che non avete messo voi.
   */
  safetyNumberWith(contact: Contact): string {
    return numeroDaImpronte(
      improntaAccount(this.accountPublic, this.dispositivi),
      improntaAccount(contact.account, contact.dispositivi)
    );
  }

  async markVerified(id: string, when = Date.now()): Promise<void> {
    const c = this.vault.contacts[id];
    if (!c) throw new Error('contatto inesistente');
    this.vault.contacts[id] = { ...c, verifiedAt: when };
    await this.save();
  }

  // ---------- come si vedono le conversazioni ----------

  private vista(id: string): { archiviata: boolean; ordine: number } {
    return this.vault.viste[id] ?? { archiviata: false, ordine: 0 };
  }

  archiviata(id: string): boolean {
    return this.vista(id).archiviata;
  }

  /** Archiviare non cancella niente: toglie dall'elenco principale, e basta. */
  async archivia(id: string, valore = true): Promise<void> {
    this.vault.viste[id] = { ...this.vista(id), archiviata: valore };
    await this.save();
  }

  /**
   * Ordine deciso a mano. Chi non compare nell'elenco resta dov'era: spostare
   * due righe non deve rimescolare tutto il resto.
   */
  async riordina(ids: readonly string[]): Promise<void> {
    ids.forEach((id, i) => {
      this.vault.viste[id] = { ...this.vista(id), ordine: i + 1 };
    });
    await this.save();
  }

  /** Posizione scelta a mano; 0 significa "nessuna scelta, vai in ordine di nome". */
  ordine(id: string): number {
    return this.vista(id).ordine;
  }

  // ---------- collegamento diretto: il server di appoggio ----------

  /** Il server TURN scritto dall'utente, o null se non ce n'e'. */
  turn(): ServerTurn | null {
    return this.vault.rete?.turn ?? null;
  }

  /**
   * Scrive (o toglie, con null) il server TURN. Il controllo sta qui e non
   * nella pagina: un indirizzo sbagliato non deve arrivare nel deposito, perche'
   * da li' finirebbe in ogni connessione senza che nessuno se ne accorga.
   */
  async impostaTurn(valore: { url?: unknown; utente?: unknown; password?: unknown } | null): Promise<ServerTurn | null> {
    const t = valore === null ? null : validaTurn(valore);
    (this.vault as { rete: Vault['rete'] }).rete = { turn: t };
    await this.save();
    return t;
  }

  // ---------- relay ----------

  /** Su quali relay ascolta QUESTO dispositivo: i suoi, o i predefiniti. */
  relay(): { elenco: string[]; personali: boolean } {
    const personali = this.vault.rete?.relay;
    return personali && personali.length
      ? { elenco: [...personali], personali: true }
      : { elenco: [...DEFAULT_RELAYS], personali: false };
  }

  /** I relay da scrivere nella propria voce del roster: solo se non sono i predefiniti. */
  private relayDichiarati(): string[] | undefined {
    const personali = this.vault.rete?.relay;
    return personali && personali.length ? [...personali] : undefined;
  }

  /**
   * Cambia la lista dei relay di questo dispositivo. `null` rimette i
   * predefiniti.
   *
   * Tre cose insieme, e servono tutte: si salva; si rifirma la propria voce
   * del roster con i relay dentro, e la si racconta ai contatti e ai propri
   * dispositivi, cosi' chi scrive pubblica dove ascoltiamo; si ricollega la
   * mailbox, perche' quella aperta ascolta ancora sulla lista di prima.
   */
  async impostaRelay(elenco: readonly unknown[] | null): Promise<{ elenco: string[]; personali: boolean }> {
    const nuovi = elenco === null ? null : normalizzaRelay(elenco);
    // Scrivere a mano i predefiniti e' come non scrivere niente: la voce resta
    // senza relay, e nessun contatto deve aggiornarsi per nulla.
    const uguali = nuovi !== null && nuovi.length === DEFAULT_RELAYS.length && nuovi.every((r, i) => r === DEFAULT_RELAYS[i]);
    const personali = nuovi && !uguali ? nuovi : null;
    const prima = JSON.stringify(this.relayDichiarati() ?? null);
    (this.vault as { rete: Vault['rete'] }).rete = { ...this.vault.rete, relay: personali };
    if (prima !== JSON.stringify(personali)) {
      this.rifirmaMiaVoce();
      await this.save();
      await this.ricollega();
      await this.raccontaDispositivi();
      await this.mandaAiMiei({ v: 1, t: 'dispositivi', elenco: this.dispositivi.map(perTrasporto) });
    } else {
      await this.save();
    }
    return this.relay();
  }

  /** La propria voce nel roster, rifirmata con i relay di adesso. */
  private rifirmaMiaVoce(): void {
    const chiave: ChiaveAccount = { secret: unhex(this.vault.account.secret), publicKey: this.accountPublic };
    const mia = this.vault.dispositivi.find((v) => v.id === this.idDispositivo);
    const voce = firmaDispositivo(
      chiave,
      this.card,
      mia?.nome ?? 'questo dispositivo',
      mia?.aggiuntoIl ?? Date.now(),
      this.relayDichiarati()
    );
    this.vault.dispositivi = [...this.vault.dispositivi.filter((v) => v.id !== this.idDispositivo), perTrasporto(voce)];
  }

  /** Chiude la mailbox e la riapre sulla lista di adesso. Solo se e' nostra. */
  private async ricollega(): Promise<void> {
    if (!this.mailbox || !this.mailboxInterna) return;
    if (this.battito) clearInterval(this.battito);
    this.battito = null;
    this.unwatch?.();
    this.unwatch = null;
    const vecchia = this.mailbox;
    this.mailbox = null;
    try {
      await vecchia.close();
    } catch {
      /* gia' chiusa, o relay spariti: non cambia niente */
    }
    await this.connect(undefined, { live: this.mailboxLive });
  }

  /**
   * Come stanno i relay, misurato adesso: apre il collegamento con ciascuno e
   * conta i millisecondi. Con una mailbox che non e' Nostr non c'e' niente da
   * misurare, e si dice solo quali sono.
   */
  async statoRelay(): Promise<StatoRelay[]> {
    if (this.mailbox instanceof NostrMailbox) return this.mailbox.controlla();
    return this.relay().elenco.map((url) => ({ url, stato: 'ok', ms: null, errore: null, errori: 0, riserva: false }));
  }

  /** Vero se la riserva e' entrata in gioco da quando la mailbox e' aperta. */
  get riservaAttiva(): boolean {
    return this.mailbox instanceof NostrMailbox && this.mailbox.riservaAttiva;
  }

  // ---------- presenza ----------

  /** Quando si e' fatto vivo l'ultima volta. null = mai, da quando esiste
   *  questo deposito. */
  visto(id: string): number | null {
    return this.presenze.get(id) ?? null;
  }

  /** Se il suo ultimo segno di vita e' abbastanza recente da poterlo dire
   *  online adesso. */
  online(id: string): boolean {
    const at = this.presenze.get(id);
    return at !== undefined && Date.now() - at < FINESTRA_ONLINE_MS;
  }

  onPresenza(cb: (id: string, at: number) => void): () => void {
    this.osservatori.add(cb);
    return () => this.osservatori.delete(cb);
  }

  /**
   * Registra un segno di vita. L'orario e' sempre il nostro: e' l'unico che
   * nessuno dall'altra parte puo' sbagliare o falsificare.
   */
  private segnaVivo(id: string): void {
    const at = Date.now();
    this.presenze.set(id, at);
    this.vault.presenze[id] = at;
    for (const cb of this.osservatori) cb(id, at);
  }

  /** Un giro di annunci a tutta la rubrica. Gli errori non escono da qui: un
   *  relay che non risponde non deve fermare l'app ne' comparire come guasto. */
  private async annuncia(soloA?: Contact, risposta = false): Promise<void> {
    const mailbox = this.mailbox;
    if (!mailbox) return;
    const payload = encodePayload({ v: 1, t: 'presence', risposta });
    for (const contact of soloA ? [soloA] : this.contacts()) {
      // Un battito per dispositivo: la persona e' online se lo e' almeno uno
      // dei suoi, e non sappiamo quale sia acceso.
      for (const d of contact.dispositivi) {
        try {
          await mailbox.send(d.card, payload, 'presenza', d.relay);
        } catch {
          /* offline, o nessun relay disponibile: si riprova al giro dopo */
        }
      }
    }
  }

  // ---------- consegna ----------

  /**
   * La sessione con cui si scrive a UN dispositivo.
   *
   * Le sessioni sono indicizzate per dispositivo, non per persona: il Double
   * Ratchet lega due dispositivi, e due dispositivi della stessa persona sono
   * due conversazioni crittografiche separate. Indicizzarle per persona
   * significherebbe far avanzare lo stesso ratchet da piu' parti — il difetto
   * che ha gia' reso muta una conversazione vera.
   */
  private sessionFor(d: Dispositivo): Session {
    const aperte = this.sessions.get(d.id);
    if (aperte?.length) return aperte[0]!;
    if (!verifyCard(d.card)) throw new Error('card del dispositivo non valida');
    const nuova = Session.start(this.vault.identity, d.card);
    this.sessions.set(d.id, [nuova]);
    return nuova;
  }

  /**
   * Se stessi, nella forma di un contatto.
   *
   * Serve quando arriva la copia che un proprio dispositivo ha mandato: il
   * mittente e' "io", e lo storico deve registrarla come cosa scritta da me.
   */
  private comeContatto(): Contact {
    return {
      id: this.id,
      name: this.displayName,
      account: this.accountPublic,
      dispositivi: this.dispositivi,
      verifiedAt: null,
    };
  }

  /**
   * Di chi e' questo indirizzo di mailbox?
   *
   * Ogni dispositivo ha il suo, quindi si cerca fra tutti i dispositivi di
   * tutti i contatti. E' solo un suggerimento per provare per prima la
   * sessione giusta: chi ha scritto lo stabilisce il ratchet.
   */
  private perIndirizzoMailbox(indirizzo: string): Contact | undefined {
    return this.contacts().find((c) => c.dispositivi.some((d) => hex(d.card.nostrPublic) === indirizzo));
  }

  /** Tutti i dispositivi a cui si scrive per raggiungere una persona. */
  private destinatari(contact: Contact): readonly Dispositivo[] {
    if (!contact.dispositivi.length) throw new Error(`${contact.name} non ha nessun dispositivo valido`);
    return contact.dispositivi;
  }

  /** I propri, tranne questo: quelli a cui mandare copia di cio' che si scrive. */
  private altriMiei(): Dispositivo[] {
    const mio = hex(this.vault.identity.sigPublic);
    return this.dispositivi.filter((d) => d.id !== mio);
  }

  /**
   * Butta le sessioni con un contatto senza toccare ne' la rubrica ne' lo
   * storico. Il messaggio successivo ne apre una nuova, con il blocco X3DH
   * dentro, che l'altro accettera'.
   *
   * Serve alle conversazioni gia' rovinate da quel difetto: le sessioni perse
   * non si recuperano, e vanno rifatte da entrambe le parti.
   */
  async riavviaSessione(contact: Contact): Promise<void> {
    // Una per dispositivo: la conversazione con una persona sono N sessioni.
    for (const d of contact.dispositivi) {
      this.sessions.delete(d.id);
      delete this.vault.sessions[d.id];
    }
    await this.save();
  }

  /**
   * Consegna a una persona: una copia cifrata per OGNI suo dispositivo.
   *
   * E, se ne abbiamo altri, una copia anche ai nostri: senza, cio' che scrivi
   * dal telefono non comparirebbe mai sul computer.
   *
   * Basta che una consegna riesca perche' il messaggio sia partito. Pretendere
   * che riescano tutte significherebbe far fallire l'invio perche' un telefono
   * spento non risponde, e un telefono spento e' la normalita'.
   */
  private async deliver(contact: Contact, payload: Payload): Promise<void> {
    if (!this.mailbox) throw new Error('mailbox non collegata: chiama connect() prima di inviare');
    const bytes = encodePayload(payload);
    // Ai propri dispositivi va una COPIA, non lo stesso messaggio: dev'essere
    // riconoscibile come "cosa che ho scritto io a Bob", non come "cosa che
    // Bob ha scritto a me".
    const copia = encodePayload({ v: 1, t: 'copia', per: contact.id, dentro: payload });
    const errori: string[] = [];
    let consegnati = 0;
    const mailbox = this.mailbox;

    // Le cifrature in ordine, una per dispositivo: ogni sessione avanza il suo
    // ratchet, e vanno fatte prima di spedire. Le spedizioni invece tutte
    // insieme: ognuna aspetta il relay piu' lento fra cinque, e farle una dopo
    // l'altra — Mac, telefono dell'altro, il proprio telefono — moltiplicava
    // quell'attesa per il numero di dispositivi. Con un solo dispositivo per
    // parte non cambia niente; con tre, un messaggio partiva in tre volte il
    // tempo.
    const spedizioni: Array<Promise<void>> = [];
    for (const d of this.destinatari(contact)) {
      const cifrato = this.sessionFor(d).encrypt(bytes);
      spedizioni.push(
        mailbox.send(d.card, cifrato, 'messaggio', d.relay).then(
          () => {
            consegnati++;
          },
          (e: unknown) => {
            errori.push(`${d.nome || d.id.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`);
          }
        )
      );
    }
    for (const d of this.altriMiei()) {
      const cifrato = this.sessionFor(d).encrypt(copia);
      // Un proprio dispositivo spento non fa fallire l'invio.
      spedizioni.push(mailbox.send(d.card, cifrato, 'messaggio', d.relay).catch(() => {}));
    }
    await Promise.all(spedizioni);
    if (consegnati === 0) {
      throw new Error(`nessuna consegna riuscita — ${errori.join('; ') || 'nessun destinatario'}`);
    }
  }

  async sendText(contact: Contact, text: string): Promise<Message> {
    // L'identificativo si sceglie prima di mandare, non dopo: e' il nome con
    // cui il messaggio andra' nominato piu' tardi, e deve essere lo stesso da
    // tutte e due le parti.
    const mid = identificativo();
    await this.deliver(contact, { v: 1, t: 'text', text, mid });
    return this.record({ id: mid, peer: contact.id, mine: true, text, at: Date.now() });
  }

  // ---------- file ----------

  /**
   * Perche' un file non parte.
   *
   * Il controllo sta qui, prima di leggere anche un solo byte dal disco: dire
   * "non si puo'" a meta' invio, dopo aver gia' occupato i relay, sarebbe
   * peggio che non dirlo affatto.
   */
  perche(contact: Contact, dimensione: number): string | null {
    if (dimensione <= 0) return 'il file e vuoto';
    if (dimensione <= SOGLIA_MAILBOX) return null;
    if (this.online(contact.id)) return null;
    const mb = Math.round(dimensione / (1024 * 1024));
    return (
      `${contact.name} non e collegato. I file oltre 5 MB passano da un collegamento diretto fra i due computer, ` +
      `che esiste solo mentre siete online tutti e due — questo pesa ${mb} MB. Aspetta che il pallino accanto al suo nome si accenda.`
    );
  }

  /**
   * Manda un file dalla mailbox. Riceve i byte, non un percorso: chi sceglie il
   * file e' la finestra, e da li' arrivano gia' letti. Cosi' lo stesso codice
   * serve il pulsante e il trascinamento, e il cuore non tocca il disco altrui.
   *
   * Solo conversazioni dirette: nei gruppi lo stesso file andrebbe spedito una
   * volta per membro, e trecento eventi moltiplicati per il numero di persone
   * non sono una funzione, sono un abuso dei relay.
   */
  async sendFile(contact: Contact, nome: string, tipo: string, dati: Uint8Array): Promise<Message> {
    const motivo = this.perche(contact, dati.length);
    if (motivo) throw new Error(motivo);
    if (dati.length > SOGLIA_MAILBOX) throw new Error('questo file passa dal collegamento diretto, non dalla mailbox');

    const id = identificativo().replace(/-/g, '');
    const mid = identificativo();
    const impronta = hex(sha256(dati));
    const pezzi = Math.ceil(dati.length / PEZZO_FILE);

    await this.deliver(contact, {
      v: 1,
      t: 'file.offer',
      id,
      nome,
      tipo,
      dimensione: dati.length,
      sha256: impronta,
      via: 'mailbox',
      pezzi,
      mid,
    });

    // Il file si tiene anche da questa parte: senza, chi l'ha mandato non
    // potrebbe piu' rivederlo nella propria conversazione.
    await this.files.scrivi(id, dati);
    const messaggio = await this.record({
      id: mid,
      peer: contact.id,
      mine: true,
      text: '',
      at: Date.now(),
      file: { id, nome, tipo, dimensione: dati.length, sha256: impronta, via: 'mailbox', stato: 'in-corso', fatti: 0 },
    });

    // I pezzi partono uno alla volta e in ordine. In parallelo si andrebbe piu'
    // veloce fino a quando un relay non comincia a rifiutare, e un pezzo perso
    // costa piu' del tempo risparmiato.
    for (let n = 0; n < pezzi; n++) {
      const fetta = dati.subarray(n * PEZZO_FILE, Math.min((n + 1) * PEZZO_FILE, dati.length));
      await this.deliver(contact, { v: 1, t: 'file.chunk', id, n, dati: b64u(fetta) });
      await this.aggiornaFile(messaggio, { fatti: n + 1 });
    }
    return this.aggiornaFile(messaggio, { stato: 'pronto', fatti: pezzi });
  }

  /** Riscrive in coda allo storico lo stesso messaggio con il file aggiornato. */
  private async aggiornaFile(messaggio: Message, cambi: Partial<NonNullable<Message['file']>>): Promise<Message> {
    if (!messaggio.file) return messaggio;
    const aggiornato: Message = { ...messaggio, file: { ...messaggio.file, ...cambi } };
    await this.history.append(aggiornato);
    for (const cb of this.listeners) cb(aggiornato);
    return aggiornato;
  }

  /** I byte di un file ricevuto dalla mailbox, decifrati al momento. */
  fileBytes(id: string): Promise<Uint8Array> {
    return this.files.leggi(id);
  }

  fileEsiste(id: string): Promise<boolean> {
    return this.files.esiste(id);
  }

  // ---------- dispositivi collegati ----------

  /**
   * Il codice da mostrare al dispositivo nuovo.
   *
   * Dentro c'e' la chiave privata dell'account. Chi fotografa lo schermo mentre
   * e' visibile diventa un tuo dispositivo: vale cinque minuti, e va mostrato
   * il tempo di inquadrarlo.
   */
  codiceCollegamento(): string {
    return codiceToUri(nuovoCodice(unhex(this.vault.account.secret), this.card));
  }

  /**
   * Diventa un dispositivo di un account che gia' esiste.
   *
   * Si chiama sul dispositivo NUOVO, con il codice letto dal primo. Da qui in
   * poi questo deposito appartiene a quell'account: la propria identita' resta
   * quella generata all'avvio, ma smette di essere un account per conto suo.
   */
  async collegatiCome(codice: string): Promise<void> {
    const c = codiceFromUri(codice);
    const chiave: ChiaveAccount = { secret: c.accountSecret, publicKey: ed25519.getPublicKey(c.accountSecret) };
    if (this.contacts().length) throw new Error('questo dispositivo ha gia una rubrica: collegalo da nuovo');

    // La propria voce nel roster, firmata con la chiave appena ricevuta.
    const mio = firmaDispositivo(
      chiave,
      this.card,
      this.nomeDispositivo || 'dispositivo collegato',
      Date.now(),
      this.relayDichiarati()
    );
    const invitante = firmaDispositivo(chiave, c.card, 'primo dispositivo');

    this.vault.account = { secret: hex(chiave.secret), publicKey: hex(chiave.publicKey) };
    this.vault.dispositivi = [perTrasporto(mio), perTrasporto(invitante)];
    await this.save();

    // Ci si presenta al primo dispositivo, che aggiornera' la sua lista e
    // avvisera' i contatti.
    if (!this.mailbox) throw new Error('mailbox non collegata');
    await this.mailbox.send(
      c.card,
      this.sessionFor(invitante).encrypt(
        encodePayload({ v: 1, t: 'dispositivo.nuovo', voce: perTrasporto(mio) })
      )
    );
  }

  /** Come si chiama questo dispositivo. Solo per riconoscerlo nell'elenco. */
  get nomeDispositivo(): string {
    return this.dispositivi.find((d) => d.id === this.idDispositivo)?.nome ?? '';
  }

  /**
   * Aggiunge un dispositivo al proprio account e lo racconta in giro.
   *
   * La firma si ricontrolla con la propria chiave d'account: una voce che non
   * torna e' qualcuno che prova a farsi passare per un tuo telefono.
   */
  private async accettaDispositivo(voce: unknown): Promise<Dispositivo | null> {
    let d: Dispositivo;
    try {
      d = daTrasporto(voce as never);
    } catch {
      return null;
    }
    if (!dispositivoValido(this.accountPublic, d)) return null;
    const gia = this.dispositivi.find((x) => x.id === d.id);
    if (gia) {
      // Lo conosciamo gia'. L'unica cosa che puo' essere cambiata sono i
      // relay: un proprio dispositivo che ne sceglie di suoi li manda cosi'.
      // Non e' un dispositivo nuovo, e non si racconta in giro: lo ha gia'
      // fatto lui.
      if (JSON.stringify(gia.relay ?? null) !== JSON.stringify(d.relay ?? null)) {
        this.vault.dispositivi = this.vault.dispositivi.map((v) => (v.id === d.id ? perTrasporto(d) : v));
        await this.save();
      }
      return null;
    }
    if (this.vault.dispositivi.length >= MAX_DISPOSITIVI) throw new Error('troppi dispositivi collegati');

    this.vault.dispositivi = [...this.vault.dispositivi, perTrasporto(d)];
    await this.save();
    await this.raccontaDispositivi();
    return d;
  }

  /**
   * Il saluto di un dispositivo appena collegato.
   *
   * L'unico caso in cui si apre una sessione con qualcuno che non e' in
   * rubrica. Si decifra, si guarda cosa c'e' dentro, e si accetta SOLO se e'
   * un annuncio di dispositivo con una firma della nostra chiave d'account.
   * Tutto il resto finisce nel cestino insieme alla sessione appena aperta.
   */
  private async forsePrimoSaluto(inbound: Inbound): Promise<Message | null> {
    let session: Session;
    let plaintext: Uint8Array;
    try {
      ({ session, plaintext } = Session.accept(this.vault.identity, inbound.envelope));
    } catch {
      return null;
    }
    let payload: Payload;
    try {
      payload = decodePayload(plaintext);
    } catch {
      return null;
    }
    if (payload.t !== 'dispositivo.nuovo') return null;

    let voce: Dispositivo;
    try {
      voce = daTrasporto(payload.voce as never);
    } catch {
      return null;
    }
    // Qui sta tutta la sicurezza di questo passaggio.
    if (!dispositivoValido(this.accountPublic, voce)) return null;

    this.sessions.set(voce.id, [session]);
    this.seen.add(inbound.id);
    // Da qui in poi e' un proprio dispositivo a tutti gli effetti: si passa
    // dalla strada normale, che aggiorna la lista e avvisa i contatti.
    return this.handle(this.comeContatto(), plaintext, inbound.sentAt);
  }

  /** Manda qualcosa solo ai propri altri dispositivi. */
  private async mandaAiMiei(payload: Payload): Promise<void> {
    if (!this.mailbox) return;
    const bytes = encodePayload(payload);
    for (const d of this.altriMiei()) {
      try {
        await this.mailbox.send(d.card, this.sessionFor(d).encrypt(bytes), 'messaggio', d.relay);
      } catch {
        /* un proprio dispositivo spento non e' un errore */
      }
    }
  }

  // ---------- lo storico al dispositivo nuovo ----------

  /** Chi vuole sapere quando arriva uno storico da un altro dispositivo. */
  onStorico(cb: (quanti: number) => void): () => void {
    this.osservatoriStorico.add(cb);
    return () => this.osservatoriStorico.delete(cb);
  }

  /**
   * Quello che si manda: i messaggi, i gruppi, il nome. Compresso dove si puo'.
   *
   * Le righe con un file restano, i byte no: su un telefono appena collegato
   * un'immagine da quattro megabyte per ogni foto mai ricevuta sarebbe un
   * trasferimento di ore, e i file vivono gia' nel loro posto. La riga dice che
   * c'era e dove sta.
   *
   * Sopra la soglia della mailbox si tengono i messaggi piu' recenti che ci
   * stanno, e si dice quanti sono: meglio gli ultimi mesi detti onestamente
   * che un trasferimento che non finisce.
   */
  private async impacchettaStorico(): Promise<{ dati: Uint8Array; gz: boolean; messaggi: number } | null> {
    const senzaByte = (m: Message): Message => {
      if (!m.file) return m;
      const { percorso: _p, ...file } = m.file;
      return { ...m, file: { ...file, stato: 'altrove' } };
    };
    let messaggi = (await this.history.all()).map(senzaByte).sort((a, b) => a.at - b.at);
    if (!messaggi.length && !this.groups().length) return null;
    for (;;) {
      const pacco: PaccoStorico = { v: 1, messaggi, gruppi: this.groups(), nome: this.vault.profile.name };
      const chiaro = te.encode(JSON.stringify(pacco));
      const compresso = await comprimi(chiaro);
      const dati = compresso ?? chiaro;
      if (dati.length <= SOGLIA_MAILBOX) return { dati, gz: compresso !== null, messaggi: messaggi.length };
      if (!messaggi.length) return null;
      // Troppo: si tolgono i piu' vecchi, un quarto alla volta.
      messaggi = messaggi.slice(Math.max(1, Math.floor(messaggi.length / 4)));
    }
  }

  /** Lo storico a UN proprio dispositivo, a pezzi, come un file sulla mailbox. */
  private async mandaStorico(d: Dispositivo): Promise<void> {
    const mailbox = this.mailbox;
    if (!mailbox) return;
    const pacco = await this.impacchettaStorico();
    if (!pacco) return;
    const id = identificativo().replace(/-/g, '');
    const pezzi = Math.ceil(pacco.dati.length / PEZZO_FILE);
    const manda = async (p: Payload) => {
      await mailbox.send(d.card, this.sessionFor(d).encrypt(encodePayload(p)), 'messaggio', d.relay);
    };
    await manda({
      v: 1,
      t: 'storico.offer',
      id,
      dimensione: pacco.dati.length,
      pezzi,
      sha256: hex(sha256(pacco.dati)),
      gz: pacco.gz,
      messaggi: pacco.messaggi,
    });
    for (let n = 0; n < pezzi; n++) {
      const fetta = pacco.dati.subarray(n * PEZZO_FILE, Math.min((n + 1) * PEZZO_FILE, pacco.dati.length));
      await manda({ v: 1, t: 'storico.pezzo', id, n, dati: b64u(fetta) });
    }
  }

  private riceviStoricoOfferta(offerta: StoricoOfferPayload): void {
    if (offerta.dimensione > SOGLIA_MAILBOX || offerta.pezzi > Math.ceil(SOGLIA_MAILBOX / PEZZO_FILE)) return;
    if (offerta.pezzi === 0 || this.storiciInArrivo.has(offerta.id)) return;
    this.storiciInArrivo.set(offerta.id, {
      offerta,
      pezzi: new Array<Uint8Array | undefined>(offerta.pezzi),
      arrivati: 0,
    });
  }

  private async riceviStoricoPezzo(pezzo: { id: string; n: number; dati: string }, at: number): Promise<Message | null> {
    const corso = this.storiciInArrivo.get(pezzo.id);
    if (!corso) return null;
    if (pezzo.n >= corso.pezzi.length || corso.pezzi[pezzo.n]) return null;
    const bytes = unb64u(pezzo.dati);
    if (bytes.length > PEZZO_FILE) return null;
    corso.pezzi[pezzo.n] = bytes;
    corso.arrivati++;
    if (corso.arrivati < corso.pezzi.length) return null;

    this.storiciInArrivo.delete(pezzo.id);
    const intero = cat(...(corso.pezzi as Uint8Array[]));
    if (intero.length !== corso.offerta.dimensione || hex(sha256(intero)) !== corso.offerta.sha256) return null;
    let pacco: PaccoStorico;
    try {
      const chiaro = corso.offerta.gz ? await decomprimi(intero) : intero;
      pacco = JSON.parse(new TextDecoder().decode(chiaro)) as PaccoStorico;
    } catch {
      return null;
    }
    return this.importaStorico(pacco, at);
  }

  /**
   * Quello che arriva si controlla campo per campo, anche se viene da un
   * proprio dispositivo: e' un proprio dispositivo, non e' per forza sano.
   */
  private async importaStorico(pacco: PaccoStorico, at: number): Promise<Message | null> {
    if (!pacco || pacco.v !== 1) return null;
    const messaggi: Message[] = [];
    for (const m of Array.isArray(pacco.messaggi) ? pacco.messaggi : []) {
      if (!m || typeof m !== 'object') continue;
      if (typeof m.id !== 'string' || !/^[0-9a-zA-Z-]{1,64}$/.test(m.id)) continue;
      if (typeof m.peer !== 'string' || !/^[0-9a-f]{8,128}$/.test(m.peer)) continue;
      if (typeof m.text !== 'string' || m.text.length > 64 * 1024) continue;
      if (typeof m.at !== 'number' || !Number.isFinite(m.at)) continue;
      // La riga di un file arriva senza byte, qualunque cosa dica: qui non ci sono.
      const file = m.file && typeof m.file === 'object' ? { ...m.file, stato: 'altrove' as const } : undefined;
      if (file) delete (file as { percorso?: string }).percorso;
      messaggi.push({ ...m, mine: m.mine === true, ...(file ? { file } : {}) });
    }
    let gruppiNuovi = 0;
    for (const g of Array.isArray(pacco.gruppi) ? pacco.gruppi : []) {
      try {
        // Si passa dalla stessa validazione di un gruppo che arriva da un
        // contatto: ne' piu' ne' meno fiducia di quella.
        const stato = decodePayload(encodePayload(stateOf(g)));
        if (stato.t !== 'group.state') continue;
        if (!stato.members.some((m) => m.id === this.id)) continue;
        for (const m of stato.members) {
          if (m.id === this.id || this.vault.contacts[m.id]) continue;
          try {
            await this.storeContact(cardAccountFromUri(m.card), m.name);
          } catch {
            /* card non valida: il membro si salta */
          }
        }
        if (!this.vault.groups[stato.g]) gruppiNuovi++;
        this.vault.groups[stato.g] = mergeGroup(this.vault.groups[stato.g], stato, stato.at);
      } catch {
        /* gruppo malformato: si salta quello */
      }
    }
    if (!this.vault.profile.name && typeof pacco.nome === 'string' && pacco.nome.trim()) {
      this.vault.profile.name = pacco.nome.trim().slice(0, 60);
    }
    const importati = await this.history.importa(messaggi);
    await this.save();
    for (const cb of this.osservatoriStorico) cb(importati);
    const pezzi = [
      importati ? `${importati} ${importati === 1 ? 'messaggio' : 'messaggi'}` : '',
      gruppiNuovi ? `${gruppiNuovi} ${gruppiNuovi === 1 ? 'gruppo' : 'gruppi'}` : '',
    ].filter(Boolean);
    if (!pezzi.length) return null;
    return this.record({
      peer: this.id,
      mine: false,
      text: `Storico ricevuto dall altro dispositivo: ${pezzi.join(' e ')}. I file restano dove sono arrivati.`,
      at,
      system: true,
    });
  }

  /**
   * Dice a tutti chi sono i propri dispositivi.
   *
   * Ai contatti, perche' sappiano a chi scrivere; ai propri altri dispositivi,
   * perche' abbiano la stessa lista. Senza, un messaggio continuerebbe ad
   * arrivare solo dove arrivava prima.
   */
  private async raccontaDispositivi(): Promise<void> {
    if (!this.mailbox) return;
    const elenco = this.dispositivi.map(perTrasporto);
    for (const contact of this.contacts()) {
      try {
        await this.deliver(contact, { v: 1, t: 'dispositivi', elenco });
      } catch {
        /* un contatto irraggiungibile non deve fermare gli altri */
      }
    }
  }

  /** Aggiorna i dispositivi di un contatto con quelli che ha annunciato. */
  private async aggiornaDispositiviContatto(sender: Contact, elenco: readonly unknown[]): Promise<void> {
    const letti: Dispositivo[] = [];
    for (const v of elenco) {
      try {
        letti.push(daTrasporto(v as never));
      } catch {
        /* voce malformata: si salta quella, non l'intero elenco */
      }
    }
    // Contro la SUA chiave d'account, quella che gia' conosciamo: nessuno puo'
    // aggiungersi ai dispositivi di qualcun altro.
    const validi = dispositiviValidi(sender.account, letti);
    if (!validi.length) return;
    const riga = this.vault.contacts[sender.id];
    if (!riga) return;

    // Cambia davvero qualcosa? L'elenco arriva anche quando e' identico, e
    // azzerare la verifica ogni volta vorrebbe dire non restare mai verificati.
    const prima = improntaAccount(sender.account, sender.dispositivi);
    const dopo = improntaAccount(sender.account, validi);
    if (hex(prima) === hex(dopo)) {
      // Stessi dispositivi. Possono essere cambiati solo i relay, che non
      // entrano nel numero di sicurezza: si aggiornano e basta, e la verifica
      // fatta a voce resta dov'e' — copre le chiavi, non gli indirizzi.
      const relayDi = (elenco: readonly Dispositivo[]) => JSON.stringify(elenco.map((d) => [d.id, d.relay ?? null]));
      if (relayDi(sender.dispositivi) !== relayDi(validi)) {
        riga.dispositivi = validi.map(perTrasporto);
        await this.save();
      }
      return;
    }

    riga.dispositivi = validi.map(perTrasporto);

    // La verifica fatta a voce valeva per l'insieme di dispositivi di allora.
    // Adesso quell'insieme e' un altro, quindi il numero di sicurezza e'
    // cambiato: lasciare scritto "verificata" direbbe una cosa falsa proprio
    // dove serve che sia vera, e toglierebbe l'unico segnale che fa accorgere
    // di un dispositivo che l'altro non ha collegato.
    const eraVerificato = riga.verifiedAt !== null;
    riga.verifiedAt = null;
    await this.save();

    // Detto, non solo fatto: un contatto che torna "da verificare" senza
    // spiegazione sembra un difetto del programma.
    if (eraVerificato) {
      await this.record({
        peer: sender.id,
        mine: false,
        text: `${riga.name} ha collegato o tolto un dispositivo. Il numero di sicurezza e cambiato: riconfrontatelo a voce.`,
        at: Date.now(),
        system: true,
      });
    }
  }

  // ---------- eliminare messaggi ----------

  /**
   * Toglie un messaggio.
   *
   * `perEntrambi` manda anche una richiesta all'altro. E' una richiesta e basta:
   * la esegue perche' questo programma la esegue, non perche' possiamo
   * obbligarlo. Chi ha gia' letto, o ha fatto una fotografia allo schermo, non
   * si raggiunge — e sarebbe disonesto lasciar credere il contrario.
   *
   * Solo i propri messaggi si tolgono anche all'altro: cancellare qualcosa dal
   * dispositivo di qualcun altro, quando quel qualcosa l'ha scritto lui, non e'
   * una funzione che questo programma offre.
   */
  async eliminaMessaggio(messaggioId: string, perEntrambi: boolean): Promise<Message | null> {
    const messaggio = (await this.history.all()).find((m) => m.id === messaggioId);
    if (!messaggio) return null;
    if (perEntrambi && !messaggio.mine) throw new Error('si tolgono anche all altro solo i propri messaggi');

    if (perEntrambi) {
      const contact = this.contact(messaggio.peer);
      if (!contact) throw new Error('contatto non trovato');
      await this.deliver(contact, { v: 1, t: 'delete', id: messaggio.id });
    }
    return this.svuota(messaggio, perEntrambi ? 'entrambi' : 'io');
  }

  /**
   * Riscrive il messaggio senza contenuto.
   *
   * Il registro e' in sola aggiunta, quindi il record vecchio resta sul disco
   * finche' non viene riscritto tutto: per questo si passa da `forgetMessage`,
   * che riscrive il file. Un testo cancellato deve sparire dai byte, non solo
   * dalla vista.
   */
  private async svuota(messaggio: Message, chi: 'io' | 'entrambi'): Promise<Message> {
    if (messaggio.file) await this.files.elimina(messaggio.file.id);
    const vuoto: Message = {
      id: messaggio.id,
      peer: messaggio.peer,
      ...(messaggio.origine ? { origine: messaggio.origine } : {}),
      mine: messaggio.mine,
      at: messaggio.at,
      text: '',
      eliminato: chi,
      ...(messaggio.from ? { from: messaggio.from } : {}),
      ...(messaggio.group ? { group: messaggio.group } : {}),
      ...(messaggio.topic ? { topic: messaggio.topic } : {}),
    };
    await this.history.sostituisci(vuoto);
    for (const cb of this.listeners) cb(vuoto);
    return vuoto;
  }

  // ---------- collegamento diretto ----------

  /**
   * La segnalazione WebRTC non la gestisce l'Account: la gestisce la finestra,
   * dove `RTCPeerConnection` esiste gia' dentro Chromium. Nel processo
   * principale servirebbe un modulo nativo, e questo programma non ne ha
   * nessuno — e' cio' che gli permette di funzionare su Windows e su Mac senza
   * una catena di compilazione per ciascuno.
   */
  onSegnale(cb: (da: string, p: RtcPayload) => void): () => void {
    this.segnalatori.add(cb);
    return () => this.segnalatori.delete(cb);
  }

  async inviaSegnale(contact: Contact, p: Omit<RtcPayload, 'v' | 't'>): Promise<void> {
    await this.deliver(contact, { v: 1, t: 'rtc', ...p });
  }

  /** Registra l'esito di un trasferimento diretto, che avviene fuori di qui. */
  /**
   * L'avanzamento di un trasferimento, senza toccare il registro.
   *
   * `concludiDiretto` rilegge TUTTO lo storico, lo decifra e ci aggiunge un
   * record. Chiamarlo a ogni pezzo da 64 KB — com'era — costa sempre di piu'
   * man mano che il registro cresce: misurato, si passa da 2 a 13 millisecondi
   * per aggiornamento in milleseicento pezzi. Su un file da 4 GB i pezzi sono
   * 65.536, e il trasferimento rallenta fino a fermarsi: la connessione cade, e
   * i due si vedono comparire "collegamento non stabilito" e "non arrivato
   * intero" senza capire perche'.
   *
   * Quanti byte sono passati e' una cosa che vive quanto il trasferimento: si
   * tiene in memoria e si mostra, non si scrive. Sul disco va lo stato finale,
   * che e' l'unica cosa che serva ancora domani.
   */
  async avanzamentoDiretto(messaggioId: string, fatti: number): Promise<Message | null> {
    let messaggio = this.inTransito.get(messaggioId);
    if (!messaggio) {
      // Una volta sola per trasferimento, non una per pezzo.
      const tutti = await this.history.all();
      messaggio = tutti.find((m) => m.id === messaggioId);
      if (!messaggio?.file) return null;
      this.inTransito.set(messaggioId, messaggio);
    }
    if (!messaggio.file) return null;
    const aggiornato: Message = { ...messaggio, file: { ...messaggio.file, fatti } };
    this.inTransito.set(messaggioId, aggiornato);
    for (const cb of this.listeners) cb(aggiornato);
    return aggiornato;
  }

  /** Tutto il registro, per chi deve ritrovare un messaggio per identificativo. */
  tuttiMessaggi(): Promise<Message[]> {
    return this.history.all();
  }

  async concludiDiretto(
    messaggioId: string,
    cambi: Partial<NonNullable<Message['file']>>
  ): Promise<Message | null> {
    // Finito, in un modo o nell'altro: quello che si teneva in memoria non
    // serve piu', e da qui in poi conta solo cio' che finisce sul disco.
    const inMemoria = this.inTransito.get(messaggioId);
    this.inTransito.delete(messaggioId);
    const tutti = await this.history.all();
    const messaggio = tutti.find((m) => m.id === messaggioId);
    if (!messaggio?.file) return null;
    // I byte contati durante il viaggio non sono mai stati scritti: si
    // rimettono adesso, o la riga direbbe zero su un file arrivato tutto.
    const fattiInViaggio = inMemoria?.file?.fatti;
    const base: Message =
      fattiInViaggio === undefined
        ? messaggio
        : { ...messaggio, file: { ...messaggio.file, fatti: fattiInViaggio } };
    return this.aggiornaFile(base, cambi);
  }

  /**
   * Segna l'inizio di un trasferimento diretto da parte di chi lo manda.
   * I byte non passano di qui: li porta la finestra, sul collegamento diretto.
   */
  async iniziaDiretto(contact: Contact, nome: string, tipo: string, dimensione: number): Promise<Message> {
    const motivo = this.perche(contact, dimensione);
    if (motivo) throw new Error(motivo);
    const id = identificativo().replace(/-/g, '');
    const mid = identificativo();
    // L'annuncio parte comunque dalla mailbox: e' cifrato dal ratchet come un
    // messaggio, e serve a far sapere all'altro che sta per arrivare qualcosa.
    await this.deliver(contact, {
      v: 1,
      t: 'file.offer',
      id,
      nome,
      tipo,
      dimensione,
      sha256: ''.padEnd(64, '0'),
      via: 'diretto',
      pezzi: 0,
      mid,
    });
    return this.record({
      id: mid,
      peer: contact.id,
      mine: true,
      text: '',
      at: Date.now(),
      file: { id, nome, tipo, dimensione, sha256: ''.padEnd(64, '0'), via: 'diretto', stato: 'in-corso', fatti: 0 },
    });
  }

  /** Un messaggio con file in attesa, creato da chi riceve via collegamento diretto. */
  async annotaRicezioneDiretta(da: Contact, offerta: FileOfferPayload): Promise<Message> {
    return this.record({
      peer: da.id,
      mine: false,
      text: '',
      at: Date.now(),
      file: {
        id: offerta.id,
        nome: offerta.nome,
        tipo: offerta.tipo,
        dimensione: offerta.dimensione,
        sha256: offerta.sha256,
        via: 'diretto',
        stato: 'in-corso',
        fatti: 0,
      },
    });
  }

  // ---------- gruppi ----------

  groups(): Group[] {
    return Object.values(this.vault.groups).sort((a, b) => a.name.localeCompare(b.name));
  }

  group(idOrName: string): Group | undefined {
    const needle = idOrName.trim().toLowerCase();
    const all = this.groups();
    return (
      all.find((g) => g.id === needle) ??
      all.find((g) => g.name.toLowerCase() === needle) ??
      all.find((g) => g.name.toLowerCase().startsWith(needle)) ??
      all.find((g) => g.id.startsWith(needle))
    );
  }

  private selfEntry(): RosterEntry {
    return { id: this.id, name: this.displayName, card: cardAccountToUri(this.cardAccount) };
  }

  private entryOf(c: Contact): RosterEntry {
    return {
      id: c.id,
      name: c.name,
      card: cardAccountToUri({ account: c.account, dispositivi: c.dispositivi }),
    };
  }

  /** Membri del gruppo diversi da te, risolti in contatti scrivibili. */
  private recipients(group: Group): Contact[] {
    const known = new Map(this.contacts().map((c) => [c.id, c]));
    return group.members.filter((m) => m.id !== this.id).flatMap((m) => {
      const c = known.get(m.id);
      return c ? [c] : [];
    });
  }

  /**
   * Un gruppo puo' nascere vuoto: si crea prima il posto, poi ci si invita chi
   * serve con addMember. Obbligare a decidere i membri al primo istante voleva
   * dire ricrearlo daccapo per un nome dimenticato.
   */
  async createGroup(name: string, members: Contact[] = []): Promise<Group> {
    const clean = name.trim();
    if (!clean) throw new Error('il gruppo ha bisogno di un nome');

    const now = Date.now();
    const group: Group = {
      id: newGroupId(),
      name: clean,
      members: [this.selfEntry(), ...members.map((c) => this.entryOf(c))],
      topics: [DEFAULT_TOPIC],
      createdAt: now,
      updatedAt: now,
    };
    this.vault.groups[group.id] = group;
    await this.save();
    if (members.length) await this.broadcastState(group);
    await this.record({
      peer: group.id,
      mine: true,
      text: members.length
        ? `gruppo «${group.name}» creato con ${members.map((m) => m.name).join(', ')}`
        : `gruppo «${group.name}» creato — vuoto, aggiungi qualcuno`,
      at: now,
      group: group.id,
      topic: DEFAULT_TOPIC.id,
      system: true,
    });
    return group;
  }

  /**
   * Aggiunge qualcuno a un gruppo che esiste gia'.
   *
   * Dopo, la fotografia va a TUTTI, nuovo compreso: il nuovo arrivato deve
   * sapere chi c'e', e i vecchi devono sapere di lui, altrimenti i loro
   * messaggi non gli arriverebbero mai.
   */
  async addMember(group: Group, contact: Contact): Promise<Group> {
    if (group.members.some((m) => m.id === contact.id)) {
      throw new Error(`${contact.name} e gia nel gruppo`);
    }
    const updated: Group = {
      ...group,
      members: [...group.members, this.entryOf(contact)],
      updatedAt: Date.now(),
    };
    this.vault.groups[group.id] = updated;
    await this.save();
    await this.broadcastState(updated);
    await this.record({
      peer: updated.id,
      mine: true,
      text: `hai aggiunto ${contact.name}`,
      at: Date.now(),
      group: updated.id,
      topic: DEFAULT_TOPIC.id,
      system: true,
    });
    return updated;
  }

  /** Manda a tutti la fotografia dello stato. Chi non e' raggiungibile la avra' dopo. */
  private async broadcastState(group: Group): Promise<void> {
    const state = stateOf(group);
    for (const contact of this.recipients(group)) {
      try {
        await this.deliver(contact, state);
      } catch {
        // Un membro irraggiungibile non deve bloccare gli altri: lo stato e'
        // una fotografia, la prossima la ricevera' comunque.
      }
    }
  }

  async addTopic(group: Group, name: string): Promise<GroupTopic> {
    const clean = name.trim();
    if (!clean) throw new Error("l'argomento ha bisogno di un nome");
    if (findTopic(group, clean)) throw new Error(`argomento «${clean}» gia presente`);

    const topic: GroupTopic = { id: newTopicId(), name: clean.toUpperCase() };
    const updated: Group = { ...group, topics: [...group.topics, topic], updatedAt: Date.now() };
    this.vault.groups[group.id] = updated;
    await this.save();
    await this.broadcastState(updated);
    return topic;
  }

  async sendGroupText(group: Group, topicId: string, text: string): Promise<Message> {
    const topic = group.topics.find((t) => t.id === topicId) ?? DEFAULT_TOPIC;
    const destinatari = this.recipients(group);
    if (!destinatari.length) throw new Error('nessun membro raggiungibile in questo gruppo');

    // Consegna a ventaglio: una busta cifrata a testa, sulla sessione 1:1.
    let consegnati = 0;
    const errori: string[] = [];
    for (const contact of destinatari) {
      try {
        await this.deliver(contact, { v: 1, t: 'group.msg', g: group.id, topic: topic.id, text });
        consegnati += 1;
      } catch (e) {
        errori.push(`${contact.name}: ${(e as Error).message}`);
      }
    }
    if (consegnati === 0) throw new Error(`nessuna consegna riuscita — ${errori.join('; ')}`);

    return this.record({
      peer: group.id,
      mine: true,
      text,
      at: Date.now(),
      group: group.id,
      topic: topic.id,
    });
  }

  /** Esce dal gruppo in locale. Senza un'autorita' centrale non esiste "espellere". */
  async leaveGroup(id: string): Promise<void> {
    delete this.vault.groups[id];
    await this.history.forgetPeer(id);
    await this.save();
  }

  groupHistory(group: Group, topicId?: string): Promise<Message[]> {
    return this.history.forGroup(group.id, topicId);
  }

  memberName(group: Group, id: string): string {
    if (id === this.id) return 'Tu';
    return (
      this.contacts().find((c) => c.id === id)?.name ??
      group.members.find((m) => m.id === id)?.name ??
      id.slice(0, 8)
    );
  }

  // ---------- ingresso ----------

  /**
   * Instradamento in ingresso. Il campo `from` della mailbox e' solo un
   * suggerimento per provare la sessione giusta per prima: se non torna, si
   * prova tutto il resto. A stabilire chi ha scritto e' sempre il ratchet.
   */
  private async ingest(inbound: Inbound): Promise<Message | null> {
    if (inbound.canale === 'presenza') {
      this.riceviBattito(inbound);
      return null;
    }
    let envelope;
    try {
      envelope = decodeEnvelope(inbound.envelope);
    } catch {
      return null;
    }
    // Solo una LETTURA del registro. Segnare la busta come vista prima di
    // averla aperta significa buttarla: se il mittente non e' ancora in
    // rubrica, o la sessione non e' pronta, quel messaggio non torna piu'
    // indietro — e da quando il registro sta su disco, non torna nemmeno
    // riavviando. Si segna piu' sotto, quando il ratchet l'ha davvero consumata.
    if (this.seen.has(inbound.id)) return null;

    const byMailbox = inbound.from ? this.perIndirizzoMailbox(inbound.from) : undefined;
    const ordered = byMailbox
      ? [byMailbox, ...this.contacts().filter((c) => c.id !== byMailbox.id)]
      : this.contacts();

    // Le sessioni stanno per DISPOSITIVO: una persona con due dispositivi ha
    // due conversazioni crittografiche, e la busta arriva da uno solo dei due.
    // Ai propri dispositivi si aggiunge se stessi: la copia che il telefono
    // manda al computer arriva per la stessa strada di un messaggio altrui.
    const daProvare: [Contact, Dispositivo][] = [];
    for (const contact of ordered) for (const d of contact.dispositivi) daProvare.push([contact, d]);
    const io = this.comeContatto();
    for (const d of this.altriMiei()) daProvare.push([io, d]);

    for (const [contact, dispositivo] of daProvare) {
      const aperte = this.sessions.get(dispositivo.id);
      if (!aperte?.length) continue;
      for (let i = 0; i < aperte.length; i++) {
        // Su una copia, non sull'originale: decifrare fa avanzare il ratchet, e
        // un tentativo fallito su una sessione altrui la lascerebbe danneggiata.
        // Solo il tentativo che riesce prende il posto dell'originale, e resta
        // dov'era: la prima resta quella con cui si scrive.
        const trial = Session.restore(aperte[i]!.serialize());
        try {
          const plaintext = trial.decrypt(inbound.envelope);
          aperte[i] = trial;
        // Da qui il ratchet ha consumato la chiave: la busta e' trattata, anche
        // se il contenuto poi non ci dira' niente di utile. Riproporla sarebbe
        // inutile — quella chiave non decifra piu'.
          this.seen.add(inbound.id);
          // Un messaggio che si apre e' un segno di vita piu' forte di un
          // battito: chi scrive e' per forza li'.
          this.segnaVivo(contact.id);
          return await this.handle(contact, plaintext, inbound.sentAt);
        } catch {
          /* non e' di questa sessione: la copia si butta, l'originale e' intatto */
        }
      }
    }

    // Primo messaggio di una conversazione: la busta porta il blocco X3DH.
    // L'identita' nel blocco e' quella di un DISPOSITIVO, non di una persona:
    // si cerca fra i dispositivi di tutti i contatti, e fra i propri.
    if (envelope.initial) {
      const mittente = hex(envelope.initial.identitySig);
      let contact: Contact | undefined;
      let dispositivo: Dispositivo | undefined;
      for (const c of [...this.contacts(), this.comeContatto()]) {
        const d = c.dispositivi.find((x) => x.id === mittente);
        if (d) {
          contact = c;
          dispositivo = d;
          break;
        }
      }
      // Un dispositivo che non conosciamo ha UNA sola cosa che puo' dirci:
      // "sono un tuo dispositivo nuovo". E' l'uovo e la gallina del
      // collegamento — il primo dispositivo non puo' conoscere il secondo
      // prima che il secondo si presenti.
      //
      // Non e' un buco: la sua voce dev'essere firmata dalla NOSTRA chiave
      // d'account, e quella firma la puo' produrre solo chi ha avuto il codice.
      // Qualunque altro contenuto da uno sconosciuto viene buttato.
      if (!contact || !dispositivo) return this.forsePrimoSaluto(inbound);
      // Un proprio dispositivo che scrive a se stesso non e' una conversazione.
      if (dispositivo.id === this.idDispositivo) return null;
      try {
        const { session, plaintext } = Session.accept(this.vault.identity, inbound.envelope);
        // In coda, mai al posto della prima: quella e' la nostra, e ci serve
        // per continuare a scrivere. Sovrascriverla e' il difetto che rendeva
        // muta la conversazione appena due persone si scrivevano insieme.
        const aperte = this.sessions.get(dispositivo.id) ?? [];
        aperte.push(session);
        this.sessions.set(dispositivo.id, aperte.slice(-Account.MAX_SESSIONI));
        this.seen.add(inbound.id);
        this.segnaVivo(contact.id);
        return await this.handle(contact, plaintext, inbound.sentAt);
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Un battito in arrivo.
   *
   * Chi l'ha mandato lo dice la firma del sigillo NIP-59, non il ratchet: sul
   * battito il ratchet non passa affatto. E' un'autenticazione piu' debole, e
   * va bene solo perche' quello che porta e' debole a sua volta — un pallino
   * verde. Un battito falsificato non apre sessioni, non scrive niente nello
   * storico e non tocca nessuna chiave.
   */
  private riceviBattito(inbound: Inbound): void {
    if (!inbound.from) return;
    const contact = this.perIndirizzoMailbox(inbound.from);
    if (!contact) return;
    let payload;
    try {
      payload = decodePayload(inbound.envelope);
    } catch {
      return;
    }
    if (payload.t !== 'presence') return;
    this.segnaVivo(contact.id);

    // Cortesia reciproca: chi si e' appena acceso deve sapere subito che ci
    // siamo anche noi, senza aspettare il nostro giro di quarantacinque
    // secondi. A una risposta non si risponde: e' cosi' che lo scambio si
    // ferma dopo un giro invece di rimbalzare all'infinito.
    if (!payload.risposta) void this.annuncia(contact, true);
  }

  /** Il mittente e' autenticato dal ratchet; il contenuto va comunque validato. */
  private async handle(sender: Contact, plaintext: Uint8Array, at: number): Promise<Message | null> {
    let payload: Payload;
    try {
      payload = decodePayload(plaintext);
    } catch {
      return null; // client rotto o versione futura: si scarta, non si va in crisi
    }

    switch (payload.t) {
      case 'text':
        return this.record({
          peer: sender.id,
          mine: false,
          text: payload.text,
          at,
          ...(payload.mid ? { origine: payload.mid } : {}),
        });

      case 'group.msg': {
        const group = this.vault.groups[payload.g];
        if (!group) return null; // gruppo che non conosciamo
        // Chi non e' nel roster non scrive nel gruppo, anche se ci conosce.
        if (!group.members.some((m) => m.id === sender.id)) return null;
        const topic = group.topics.find((t) => t.id === payload.topic) ?? DEFAULT_TOPIC;
        return this.record({
          peer: group.id,
          from: sender.id,
          mine: false,
          text: payload.text,
          at,
          group: group.id,
          topic: topic.id,
        });
      }

      case 'group.state':
        return this.applyGroupState(sender, payload, at);

      case 'presence':
        // Un battito non passa mai di qui: viaggia sul suo canale e si ferma
        // prima del ratchet. Se ne arriva uno per questa strada e' un client
        // che sbaglia — il segno di vita l'abbiamo gia' preso comunque.
        return null;

      case 'file.offer':
        return this.riceviOfferta(sender, payload, at);

      case 'file.chunk':
        return this.riceviPezzo(sender, payload);

      case 'delete': {
        // Si cerca per il nome che gli da' chi l'ha mandato, non per il nostro:
        // i due storici assegnano identificativi diversi allo stesso messaggio.
        const bersaglio = (await this.history.all()).find((m) => m.origine === payload.id);
        // Si tolgono solo i messaggi di chi lo chiede: nessuno puo' far
        // sparire quello che abbiamo scritto noi.
        if (!bersaglio || bersaglio.mine || bersaglio.peer !== sender.id) return null;
        if (bersaglio.eliminato) return null;
        return this.svuota(bersaglio, 'entrambi');
      }

      case 'copia': {
        // Solo da se stessi: nessuno decide cosa risulta scritto da te.
        if (sender.id !== this.id) return null;
        const per = this.contact(payload.per);
        if (!per) return null;
        let dentro: Payload;
        try {
          dentro = decodePayload(te.encode(JSON.stringify(payload.dentro)));
        } catch {
          return null;
        }
        // Registrata come TUA, nella conversazione con il destinatario vero.
        if (dentro.t === 'text') {
          return this.record({
            peer: per.id,
            mine: true,
            text: dentro.text,
            at,
            ...(dentro.mid ? { id: dentro.mid } : {}),
          });
        }
        return null;
      }

      case 'dispositivo.nuovo': {
        // Solo da se stessi: un dispositivo lo aggiunge chi possiede l'account,
        // e chi possiede l'account e' l'unico che puo' averlo firmato.
        if (sender.id !== this.id) return null;
        const aggiunto = await this.accettaDispositivo(payload.voce);
        if (!aggiunto) return null;
        // Al dispositivo nuovo servono la lista completa e la rubrica, o si
        // ritrova un'app che non conosce nessuno.
        await this.mandaAiMiei({ v: 1, t: 'dispositivi', elenco: this.dispositivi.map(perTrasporto) });
        await this.mandaAiMiei({
          v: 1,
          t: 'rubrica',
          contatti: this.contacts().map((c) => ({
            nome: c.name,
            card: cardAccountToUri({ account: c.account, dispositivi: c.dispositivi }),
          })),
        });
        // E lo storico, a lui solo: gli altri dispositivi lo hanno gia'. Un
        // errore qui non deve impedire il collegamento, che e' gia' avvenuto.
        try {
          await this.mandaStorico(aggiunto);
        } catch {
          /* relay che non rispondono: il dispositivo e' collegato comunque */
        }
        return this.record({
          peer: this.id,
          mine: false,
          text: 'Hai collegato un dispositivo nuovo. Il numero di sicurezza con i tuoi contatti e cambiato: riconfrontatelo.',
          at,
          system: true,
        });
      }

      case 'dispositivi': {
        if (sender.id === this.id) {
          // Da un proprio dispositivo: e' la lista completa dell'account.
          for (const v of payload.elenco) await this.accettaDispositivo(v);
          return null;
        }
        await this.aggiornaDispositiviContatto(sender, payload.elenco);
        return null;
      }

      case 'rubrica': {
        // Solo da se stessi: nessuno riempie la tua rubrica al posto tuo.
        if (sender.id !== this.id) return null;
        for (const c of payload.contatti) {
          try {
            await this.storeContact(cardAccountFromUri(c.card), c.nome);
          } catch {
            /* gia' presente, o card non valida: si salta e si va avanti */
          }
        }
        return null;
      }

      case 'rtc':
        // Non tocca lo storico: e' traffico di servizio fra i due programmi.
        for (const cb of this.segnalatori) cb(sender.id, payload);
        return null;

      case 'storico.offer':
        // Solo da se stessi: nessuno riempie il tuo storico al posto tuo.
        if (sender.id !== this.id) return null;
        this.riceviStoricoOfferta(payload);
        return null;

      case 'storico.pezzo':
        if (sender.id !== this.id) return null;
        return this.riceviStoricoPezzo(payload, at);
    }
  }

  /**
   * L'annuncio di un file in arrivo.
   *
   * Sulla via diretta si crea solo la riga nella conversazione: i byte li
   * portera' la finestra. Sulla via mailbox si prepara il posto dove metterli.
   */
  private async riceviOfferta(sender: Contact, offerta: FileOfferPayload, at: number): Promise<Message | null> {
    if (offerta.via === 'diretto') {
      for (const cb of this.segnalatori) {
        cb(sender.id, { v: 1, t: 'rtc', id: offerta.id, ruolo: 'offerta', dati: JSON.stringify(offerta) });
      }
      return this.record({
        ...(offerta.mid ? { origine: offerta.mid } : {}),
        peer: sender.id,
        mine: false,
        text: '',
        at,
        file: {
          id: offerta.id,
          nome: offerta.nome,
          tipo: offerta.tipo,
          dimensione: offerta.dimensione,
          sha256: offerta.sha256,
          via: 'diretto',
          stato: 'in-corso',
          fatti: 0,
        },
      });
    }

    // Un annuncio che promette piu' della soglia sulla via mailbox e' un client
    // rotto o qualcuno che prova a farci riempire la memoria: si rifiuta.
    if (offerta.dimensione > SOGLIA_MAILBOX || offerta.pezzi > Math.ceil(SOGLIA_MAILBOX / PEZZO_FILE)) return null;
    if (this.inArrivo.has(offerta.id)) return null;

    const messaggio = await this.record({
      ...(offerta.mid ? { origine: offerta.mid } : {}),
      peer: sender.id,
      mine: false,
      text: '',
      at,
      file: {
        id: offerta.id,
        nome: offerta.nome,
        tipo: offerta.tipo,
        dimensione: offerta.dimensione,
        sha256: offerta.sha256,
        via: 'mailbox',
        stato: 'in-corso',
        fatti: 0,
      },
    });
    this.inArrivo.set(offerta.id, {
      offerta,
      da: sender.id,
      messaggio: messaggio.id,
      pezzi: new Array<Uint8Array | undefined>(offerta.pezzi),
      arrivati: 0,
    });
    return messaggio;
  }

  /**
   * Un pezzo di file.
   *
   * L'ordine di arrivo non e' garantito — i relay consegnano come capita —
   * quindi ogni pezzo va al suo posto e si conta quanti ne mancano, invece di
   * accodarli sperando che arrivino in fila.
   */
  private async riceviPezzo(sender: Contact, pezzo: { id: string; n: number; dati: string }): Promise<Message | null> {
    const corso = this.inArrivo.get(pezzo.id);
    // Un pezzo di un file che non ci e' stato annunciato non si tiene: senza
    // l'annuncio non sappiamo quanto sara' grande, e accumulare a fiducia
    // significa lasciare a chiunque un modo per riempirci la memoria.
    if (!corso || corso.da !== sender.id) return null;
    if (pezzo.n >= corso.pezzi.length || corso.pezzi[pezzo.n]) return null;

    const bytes = unb64u(pezzo.dati);
    if (bytes.length > PEZZO_FILE) return null;
    corso.pezzi[pezzo.n] = bytes;
    corso.arrivati++;

    const tutti = await this.history.all();
    const messaggio = tutti.find((m) => m.id === corso.messaggio);
    if (!messaggio) return null;
    if (corso.arrivati < corso.pezzi.length) {
      return this.aggiornaFile(messaggio, { fatti: corso.arrivati });
    }

    this.inArrivo.delete(pezzo.id);
    const intero = cat(...(corso.pezzi as Uint8Array[]));
    // L'impronta non e' una formalita': un pezzo alterato o mancante produce
    // altrimenti un file che sembra a posto e non lo e'.
    if (intero.length !== corso.offerta.dimensione || hex(sha256(intero)) !== corso.offerta.sha256) {
      return this.aggiornaFile(messaggio, { stato: 'fallito', fatti: corso.arrivati });
    }
    await this.files.scrivi(corso.offerta.id, intero);
    return this.aggiornaFile(messaggio, { stato: 'pronto', fatti: corso.pezzi.length });
  }

  /**
   * Aggiornamento del gruppo da parte di un membro.
   *
   * I membri che non conosciamo entrano in rubrica come NON verificati: stiamo
   * accettando la parola di chi invita su chi sono. E' una delega di fiducia
   * reale, e va mostrata come tale — il numero di sicurezza con ciascuno resta
   * da confrontare a voce, uno per uno.
   */
  private async applyGroupState(
    sender: Contact,
    payload: Extract<Payload, { t: 'group.state' }>,
    at: number
  ): Promise<Message | null> {
    const known = this.vault.groups[payload.g];
    // Chi non e' gia' membro non puo' modificare un gruppo esistente.
    if (known && !known.members.some((m) => m.id === sender.id)) return null;
    // In un gruppo nuovo, chi invita deve essere fra i membri che dichiara.
    if (!known && !payload.members.some((m) => m.id === sender.id)) return null;

    const nuovi: string[] = [];
    for (const m of payload.members) {
      if (m.id === this.id || this.vault.contacts[m.id]) continue;
      try {
        await this.storeContact(cardAccountFromUri(m.card), m.name);
        nuovi.push(m.name);
      } catch {
        // Card illeggibile o non firmata: si salta il membro, non l'intero gruppo.
      }
    }

    const merged = mergeGroup(known, payload, at);
    this.vault.groups[merged.id] = merged;
    await this.save();

    const testo = known
      ? nuovi.length
        ? `${sender.name} ha aggiunto ${nuovi.join(', ')}`
        : `${sender.name} ha aggiornato il gruppo`
      : `${sender.name} ti ha aggiunto a «${merged.name}»`;
    return this.record({
      peer: merged.id,
      from: sender.id,
      mine: false,
      text: testo,
      at,
      group: merged.id,
      topic: DEFAULT_TOPIC.id,
      system: true,
    });
  }

  private async record(m: Omit<Message, 'id'> & { id?: string }): Promise<Message> {
    const message: Message = { ...m, id: m.id ?? identificativo() };
    await this.history.append(message);
    await this.save();
    if (!message.mine) for (const cb of this.listeners) cb(message);
    return message;
  }

  historyWith(contact: Contact): Promise<Message[]> {
    return this.history.forPeer(contact.id);
  }

  onMessage(cb: (m: Message) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // ---------- mailbox ----------

  /**
   * `live: false` collega la mailbox senza aprire l'ascolto in tempo reale:
   * serve ai comandi che fanno una cosa sola e finiscono, dove tenere aperta
   * una sottoscrizione sarebbe solo latenza in piu'.
   */
  async connect(mailbox?: Mailbox, options: { live?: boolean } = {}): Promise<Mailbox> {
    if (this.mailbox) return this.mailbox;
    this.mailboxInterna = !mailbox;
    this.mailboxLive = options.live !== false;
    this.mailbox =
      mailbox ?? new NostrMailbox(this.vault.identity, { relays: this.relay().elenco, riserva: RELAY_RISERVA });
    if (options.live !== false) {
      this.unwatch = this.mailbox.watch((inbound) => {
        void this.ingest(inbound);
      });
      // Ci si annuncia solo se si sta in ascolto: dire "ci sono" e poi non
      // essere in grado di sentire la risposta e' peggio che tacere.
      void this.annuncia();
      this.battito = setInterval(() => void this.annuncia(), BATTITO_MS);
      // Un timer che tiene sveglio il processo per un pallino verde e' un
      // difetto, non una funzione: chi non ha altro da fare deve poter uscire.
      this.battito.unref?.();
      // Si guarda subito come stanno i relay: se nessuno risponde, la riserva
      // entra in ascolto da sola, e chi ci scrive dalla riserva ci trova.
      if (this.mailbox instanceof NostrMailbox) this.mailbox.controlla(true).catch(() => {});
    }
    return this.mailbox;
  }

  /** Ritira e decifra tutto quello che e' arrivato mentre eravamo via. */
  async sync(): Promise<Message[]> {
    if (!this.mailbox) throw new Error('mailbox non collegata');
    const partenza = Math.floor(Date.now() / 1000);
    const out: Message[] = [];
    for (const inbound of await this.mailbox.receive(this.vault.mailbox.since || undefined)) {
      const message = await this.ingest(inbound);
      if (message) out.push(message);
    }
    // Il punto di ripresa si sposta solo dopo un ritiro andato a buon fine: se
    // la rete cade a meta', la prossima volta si riparte da dove si era.
    this.vault.mailbox.since = partenza;
    await this.save();
    return out;
  }

  // ---------- persistenza ----------

  async save(): Promise<void> {
    for (const [id, aperte] of this.sessions) this.vault.sessions[id] = aperte.map((s) => s.serialize());
    this.vault.mailbox.seen = this.seen.elenco();
    for (const [id, at] of this.presenze) this.vault.presenze[id] = at;
    this.vault.mailbox.v = RIPRESA_VERSIONE;
    // La scrittura in due tempi, che evita di lasciare un deposito illeggibile
    // se il salvataggio viene interrotto, ora la garantisce il deposito stesso.
    await this.deposito.scrivi(VAULT_FILE, resealVault(this.vault, this.vaultKey, this.vaultSalt));
  }

  async close(): Promise<void> {
    if (this.battito) clearInterval(this.battito);
    this.battito = null;
    this.unwatch?.();
    this.unwatch = null;
    await this.save();
    await this.mailbox?.close();
    this.mailbox = null;
    this.vaultKey.fill(0);
    await this.lock.release();
  }
}
