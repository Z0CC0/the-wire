// Storico dei messaggi: registro cifrato in sola aggiunta.
//
// Un file unico da ricifrare a ogni messaggio diventerebbe insostenibile appena
// la conversazione cresce. Qui ogni record e' cifrato per conto suo e si
// aggiunge in coda: scrivere costa sempre uguale, che sia il decimo messaggio
// o il centomillesimo.
//
// Ogni record ha il proprio nonce casuale. Riusare un nonce con la stessa
// chiave e' l'unico modo di rompere XChaCha20 senza attaccare la matematica:
// 24 byte casuali rendono la collisione irraggiungibile.

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { casuali } from './casuale.js';
import type { Deposito } from './deposito.js';
import { cat, td, te, u32, readU32 } from './codec.js';

const NONCE_BYTES = 24;
const LEN_BYTES = 4;
/** Un record piu' grande di cosi' e' un file corrotto, non un messaggio. */
const MAX_RECORD = 4 * 1024 * 1024;

export interface Message {
  readonly id: string;
  /** Chiave della conversazione: id del contatto se diretto, id del gruppo se di gruppo. */
  readonly peer: string;
  /** Solo nei gruppi: chi ha scritto. Nel diretto e' implicito in `peer`. */
  readonly from?: string;
  readonly mine: boolean;
  readonly text: string;
  readonly at: number;
  readonly group?: string;
  readonly topic?: string;
  /** Righe generate dall'app (ingressi nel gruppo, argomenti nuovi), non scritte da qualcuno. */
  readonly system?: boolean;
  /**
   * Messaggio eliminato. Testo e file spariscono davvero dal registro: resta
   * solo il segnaposto, perche' un buco senza spiegazione si legge peggio di
   * una riga che dice cosa e' successo.
   */
  readonly eliminato?: 'io' | 'entrambi';
  /**
   * Come lo chiama chi l'ha mandato. I due storici assegnano identificativi
   * propri, quindi senza questo riferimento una richiesta di eliminazione non
   * saprebbe indicare quale messaggio.
   */
  readonly origine?: string;
  /**
   * Un file allegato al messaggio.
   *
   * `stato` racconta a che punto e', e cambia nel tempo: lo stesso messaggio
   * viene riscritto in coda allo storico quando il trasferimento finisce, e
   * chi legge tiene l'ultima versione. Un registro in sola aggiunta non
   * permette di correggere all'indietro, e va bene cosi': la storia di un
   * trasferimento e' informazione, non sporcizia.
   */
  readonly file?: {
    readonly id: string;
    readonly nome: string;
    readonly tipo: string;
    readonly dimensione: number;
    readonly sha256: string;
    readonly via: 'mailbox' | 'diretto';
    /** `altrove`: la riga e' arrivata con lo storico da un altro dispositivo,
     *  i byte no. Si vede che c'era un file, e dove sta. */
    readonly stato: 'in-corso' | 'pronto' | 'fallito' | 'atteso' | 'altrove';
    /** Dove e' stato salvato, se e' passato dal collegamento diretto. */
    readonly percorso?: string;
    /** Quanto e' arrivato finora, per la barra di avanzamento. */
    readonly fatti?: number;
  };
}

/**
 * Formato di un record:  nonce(24) | lunghezza(4) | testo cifrato
 * La lunghezza sta fuori dal cifrato perche' serve per navigare il file, ma e'
 * anche dato autenticato: chi la cambia per farci leggere oltre il record rompe
 * il tag e non ottiene nulla di leggibile.
 */
export function encodeRecord(message: Message, key: Uint8Array): Uint8Array {
  const plain = te.encode(JSON.stringify(message));
  const nonce = casuali(NONCE_BYTES);
  const ciphertext = xchacha20poly1305(key, nonce, u32(plain.length)).encrypt(plain);
  return cat(nonce, u32(ciphertext.length), ciphertext);
}

export function decodeRecords(blob: Uint8Array, key: Uint8Array): Message[] {
  const out: Message[] = [];
  let off = 0;
  while (off + NONCE_BYTES + LEN_BYTES <= blob.length) {
    const nonce = blob.subarray(off, off + NONCE_BYTES);
    const length = readU32(blob, off + NONCE_BYTES);
    if (length === 0 || length > MAX_RECORD) break; // file troncato o corrotto: fermarsi qui
    const start = off + NONCE_BYTES + LEN_BYTES;
    if (start + length > blob.length) break;
    const ciphertext = blob.subarray(start, start + length);
    try {
      const plain = xchacha20poly1305(key, nonce, u32(length - 16)).decrypt(ciphertext);
      out.push(JSON.parse(td.decode(plain)) as Message);
    } catch {
      // Record illeggibile: saltarlo e proseguire. Un settore danneggiato non
      // deve costare tutta la conversazione.
    }
    off = start + length;
  }
  return out;
}

/** Attacca fra loro dei blocchi di byte. `Buffer.concat` qui non si puo' usare:
 *  `Buffer` e' di Node, e questo file deve girare anche in un browser. */
function unisci(pezzi: readonly Uint8Array[]): Uint8Array {
  const totale = pezzi.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(totale);
  let off = 0;
  for (const p of pezzi) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export class History {
  /** `chiave` e' un nome dentro il deposito, non un percorso: dove finisca
   *  davvero lo decide il deposito, che su un telefono non ha file. */
  constructor(
    private readonly deposito: Deposito,
    private readonly chiave: string,
    private readonly key: Uint8Array
  ) {}

  async append(message: Message): Promise<void> {
    await this.deposito.accoda(this.chiave, encodeRecord(message, this.key));
  }

  /**
   * Tutti i messaggi, con una regola sola: a parita' di identificativo vale
   * l'ultima versione scritta.
   *
   * Serve ai file, il cui stato cambia mentre arrivano. Il registro resta in
   * sola aggiunta — non si torna indietro a correggere, si riscrive in coda —
   * ma chi legge vede una conversazione, non la cronologia delle correzioni.
   * La posizione resta quella della prima comparsa: un file non deve saltare
   * in fondo alla conversazione solo perche' e' finito di arrivare.
   */
  async all(): Promise<Message[]> {
    // Registro mai scritto: nessun messaggio, non un errore.
    const blob = await this.deposito.leggi(this.chiave);
    if (!blob) return [];
    const records = decodeRecords(blob, this.key);
    const posizione = new Map<string, number>();
    const out: Message[] = [];
    for (const m of records) {
      const gia = posizione.get(m.id);
      if (gia === undefined) {
        posizione.set(m.id, out.length);
        out.push(m);
      } else {
        out[gia] = m;
      }
    }
    return out;
  }

  async forPeer(peer: string): Promise<Message[]> {
    return (await this.all()).filter((m) => m.peer === peer);
  }

  /** Messaggi di un gruppo, opzionalmente del solo argomento richiesto. */
  async forGroup(group: string, topic?: string): Promise<Message[]> {
    return (await this.all()).filter((m) => m.group === group && (!topic || m.topic === topic));
  }

  /**
   * Sostituisce un messaggio riscrivendo tutto il registro.
   *
   * Non basta aggiungere in coda la versione svuotata: il record vecchio
   * resterebbe nel file, cifrato ma intero, e un testo eliminato deve sparire
   * dai byte. Riscrivere costa quanto la conversazione e' lunga, ed e' un
   * prezzo che si paga solo quando si elimina qualcosa.
   */
  async sostituisci(messaggio: Message): Promise<void> {
    const tutti = (await this.all()).map((m) => (m.id === messaggio.id ? messaggio : m));
    const blob = tutti.map((m) => encodeRecord(m, this.key));
    await this.deposito.scrivi(this.chiave, unisci(blob));
  }

  /**
   * Aggiunge messaggi venuti da un altro dispositivo, senza doppioni.
   *
   * I due storici danno nomi propri alle stesse cose: un messaggio ricevuto
   * da un contatto ha un identificativo diverso su ogni dispositivo. Si
   * riconosce in tre modi, dal piu' sicuro al meno: lo stesso identificativo
   * (i propri messaggi, che viaggiano con il loro `mid`), lo stesso `origine`
   * nella stessa conversazione (il nome che gli da' chi l'ha mandato), e
   * infine stessa conversazione, stesso verso, stesso istante, stesso testo.
   *
   * Il registro viene riscritto in ordine di tempo: i messaggi vecchi che
   * arrivano adesso devono stare dove stavano, non in fondo. Costa quanto la
   * conversazione e' lunga, e si paga una volta sola, al collegamento.
   */
  async importa(messaggi: readonly Message[]): Promise<number> {
    const presenti = await this.all();
    const ids = new Set(presenti.map((m) => m.id));
    const origini = new Set(presenti.filter((m) => m.origine).map((m) => `${m.peer}|${m.origine}`));
    const impronte = new Set(presenti.map((m) => `${m.peer}|${m.mine ? 1 : 0}|${m.at}|${m.text}`));
    const nuovi: Message[] = [];
    for (const m of messaggi) {
      const origine = m.origine ? `${m.peer}|${m.origine}` : null;
      const impronta = `${m.peer}|${m.mine ? 1 : 0}|${m.at}|${m.text}`;
      if (ids.has(m.id) || (origine && origini.has(origine)) || impronte.has(impronta)) continue;
      ids.add(m.id);
      if (origine) origini.add(origine);
      impronte.add(impronta);
      nuovi.push(m);
    }
    if (!nuovi.length) return 0;
    const tutti = [...presenti, ...nuovi].sort((a, b) => a.at - b.at);
    await this.deposito.scrivi(this.chiave, unisci(tutti.map((m) => encodeRecord(m, this.key))));
    return nuovi.length;
  }

  /** Riscrive il registro senza i messaggi di un contatto. */
  async forgetPeer(peer: string): Promise<number> {
    const kept = (await this.all()).filter((m) => m.peer !== peer);
    const blob = kept.map((m) => encodeRecord(m, this.key));
    await this.deposito.scrivi(this.chiave, unisci(blob));
    return kept.length;
  }
}
