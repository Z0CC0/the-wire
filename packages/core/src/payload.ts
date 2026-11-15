// Cosa viaggia DENTRO il testo cifrato.
//
// Fino a ieri era testo semplice. Con i gruppi serve distinguere un messaggio
// diretto da uno di gruppo e dall'annuncio di chi ne fa parte, quindi il
// contenuto diventa una struttura con un'etichetta.
//
// Arriva da un mittente autenticato dal ratchet, ma "autenticato" non vuol dire
// "ben formato": un contatto con un client rotto, o compromesso, puo' mandare
// qualsiasi cosa. Qui si valida campo per campo prima di toccarlo.

import { td, te } from './codec.js';

export const PAYLOAD_VERSION = 1;

/**
 * Messaggio diretto, una persona sola.
 *
 * `mid` e' l'identificativo che il messaggio ha nello storico di chi lo manda.
 * Serve a poterlo nominare piu' tardi — per esempio per chiedere di
 * eliminarlo — perche' i due storici assegnano identificativi propri e senza
 * questo riferimento nessuno dei due saprebbe di quale messaggio si parla.
 * Non prende il posto dell'identificativo locale, apposta: un mittente che
 * potesse sceglierlo potrebbe farlo coincidere con un messaggio gia' presente.
 */
export interface TextPayload {
  readonly v: 1;
  readonly t: 'text';
  readonly text: string;
  readonly mid?: string;
}

/** Messaggio di gruppo, dentro un argomento. */
export interface GroupMessagePayload {
  readonly v: 1;
  readonly t: 'group.msg';
  readonly g: string;
  readonly topic: string;
  readonly text: string;
  readonly mid?: string;
}

/** Membro cosi' come lo racconta chi invita: card inclusa, per poter scrivere a tutti. */
export interface RosterEntry {
  readonly id: string;
  readonly name: string;
  readonly card: string;
}

/**
 * Fotografia dello stato del gruppo. Serve sia da invito sia da aggiornamento:
 * chi la riceve la fonde con quella che ha gia'. Nessun comando "rimuovi", che
 * senza un'autorita' centrale sarebbe solo un invito a litigare fra repliche.
 */
export interface GroupStatePayload {
  readonly v: 1;
  readonly t: 'group.state';
  readonly g: string;
  readonly name: string;
  readonly members: readonly RosterEntry[];
  readonly topics: readonly { readonly id: string; readonly name: string }[];
  readonly at: number;
}

/**
 * Il battito: "ci sono". Non porta un orario perche' l'orario del mittente non
 * ci serve — anzi, non lo vogliamo: un orologio sbagliato dall'altra parte
 * farebbe risultare qualcuno online per sempre, o mai. Quello che conta e'
 * quando e' arrivato da noi.
 *
 * L'unico campo dice se e' una risposta a un battito altrui. Serve a spegnere
 * il rimbalzo: a una risposta non si risponde, quindi lo scambio finisce da
 * solo dopo un giro, senza doverlo indovinare guardando l'orologio.
 */
export interface PresencePayload {
  readonly v: 1;
  readonly t: 'presence';
  readonly risposta: boolean;
}

/**
 * L'annuncio di un file: cosa sta arrivando, quanto pesa, e da quale strada.
 *
 * Arriva sempre prima dei dati, anche nel trasferimento diretto: chi riceve
 * deve poter dire di no, o sapere quanto spazio serve, prima che cominci.
 * `sha256` non e' un dettaglio: senza, un pezzo perso o alterato produce un
 * file rotto che sembra buono.
 */
export interface FileOfferPayload {
  readonly v: 1;
  readonly t: 'file.offer';
  readonly id: string;
  readonly nome: string;
  readonly tipo: string;
  readonly dimensione: number;
  readonly sha256: string;
  readonly via: 'mailbox' | 'diretto';
  /** Quanti pezzi, solo per la via mailbox. */
  readonly pezzi: number;
  /** Identificativo del messaggio nello storico di chi manda. Vedi TextPayload. */
  readonly mid?: string;
}

/** Un pezzo di file sulla via mailbox. `dati` e' base64url. */
export interface FileChunkPayload {
  readonly v: 1;
  readonly t: 'file.chunk';
  readonly id: string;
  readonly n: number;
  readonly dati: string;
}

/**
 * Segnalazione per il collegamento diretto.
 *
 * Passa dalla mailbox come tutto il resto — cifrata dal ratchet — quindi il
 * relay non vede ne' gli indirizzi ne' a chi appartengono. Serve solo a far
 * incontrare i due programmi: da li' in poi i dati non passano piu' di qui.
 */
export interface RtcPayload {
  readonly v: 1;
  readonly t: 'rtc';
  readonly id: string;
  readonly ruolo: 'offerta' | 'risposta' | 'candidato' | 'rifiuto';
  readonly dati: string;
}

/**
 * "Quel messaggio toglilo anche da te."
 *
 * E' una richiesta, non un comando, e va detto chiaro: chi la riceve la esegue
 * perche' questo programma la esegue. Un client modificato, o una schermata
 * gia' fatta, non si possono richiamare indietro — l'unico posto dove si puo'
 * cancellare davvero e' il proprio dispositivo.
 */
export interface DeletePayload {
  readonly v: 1;
  readonly t: 'delete';
  /** Identificativo del messaggio nello storico di chi lo aveva mandato. */
  readonly id: string;
}

/**
 * "Sono un tuo dispositivo nuovo, eccomi."
 *
 * Lo manda il dispositivo appena collegato al primo. Porta la propria voce del
 * roster, gia' firmata con la chiave d'account — che ha appena ricevuto dal
 * codice. Chi la riceve non si fida della parola: verifica quella firma con la
 * PROPRIA chiave d'account, e se non torna butta via tutto.
 */
export interface DispositivoNuovoPayload {
  readonly v: 1;
  readonly t: 'dispositivo.nuovo';
  readonly voce: unknown;
}

/**
 * L'elenco completo dei dispositivi di una persona.
 *
 * Va in due direzioni: dal primo dispositivo al nuovo (per dirgli chi altro
 * c'e'), e verso i contatti (per dirgli a chi devono scrivere d'ora in poi).
 * Chi lo riceve non lo prende per buono: ricontrolla ogni firma contro la
 * chiave d'account che gia' conosce per quella persona.
 */
export interface DispositiviPayload {
  readonly v: 1;
  readonly t: 'dispositivi';
  readonly elenco: readonly unknown[];
}

/**
 * La rubrica, da un proprio dispositivo all'altro.
 *
 * Un dispositivo appena collegato non conosce nessuno: senza questo sarebbe
 * un'app vuota. Viaggia cifrata dal ratchet come qualsiasi messaggio, e solo
 * fra dispositivi della stessa persona.
 */
export interface RubricaPayload {
  readonly v: 1;
  readonly t: 'rubrica';
  readonly contatti: readonly { readonly nome: string; readonly card: string }[];
}

/**
 * La copia di cio' che si e' scritto, verso i propri altri dispositivi.
 *
 * Serve `per`: senza, chi la riceve saprebbe solo che se l'e' mandata da solo,
 * e la registrerebbe in una conversazione con se stesso invece che in quella
 * con il destinatario vero. `dentro` e' il payload originale, intatto.
 */
export interface CopiaPayload {
  readonly v: 1;
  readonly t: 'copia';
  /** Identificativo della persona a cui era destinato. */
  readonly per: string;
  readonly dentro: unknown;
}

export type Payload =
  | TextPayload
  | GroupMessagePayload
  | GroupStatePayload
  | PresencePayload
  | FileOfferPayload
  | FileChunkPayload
  | RtcPayload
  | DeletePayload
  | DispositivoNuovoPayload
  | DispositiviPayload
  | RubricaPayload
  | CopiaPayload;

/** Un messaggio piu' lungo di cosi' non e' un messaggio. */
const MAX_TEXT = 64 * 1024;
/** Un nome di file, non un percorso: si scarta tutto il resto piu' in basso. */
const MAX_NOME_FILE = 260;
/** Il pezzo viaggia in base64url, che gonfia di un terzo. Il tetto e' largo
 *  quanto basta a non rifiutare un pezzo legittimo e non un byte di piu'. */
const MAX_PEZZO = 32 * 1024;
/** Segnalazione WebRTC: una descrizione di sessione sta ampiamente sotto. */
const MAX_SEGNALE = 64 * 1024;
const MAX_MEMBERS = 256;
const MAX_TOPICS = 128;
const MAX_NAME = 200;
/**
 * Quanto puo' essere lunga la card di un membro nel roster.
 *
 * Prima bastavano 512 caratteri, perche' una card descriveva un dispositivo
 * solo. Ora ne porta uno per ciascuno: circa mille caratteri per il primo e
 * ottocentosettanta per ogni altro. Con il tetto vecchio il payload del gruppo
 * veniva rifiutato per intero, e il gruppo non arrivava a nessuno.
 */
const MAX_CARD = 24 * 1024;
/** Piu' di cosi' non e' una persona con dei dispositivi. */
const MAX_DISPOSITIVI_PAYLOAD = 16;
const ID = /^[0-9a-f]{8,128}$/;

function str(value: unknown, max: number, field: string): string {
  if (typeof value !== 'string') throw new Error(`payload: ${field} non e una stringa`);
  if (value.length > max) throw new Error(`payload: ${field} troppo lungo (${value.length})`);
  return value;
}

function id(value: unknown, field: string): string {
  const s = str(value, 128, field);
  if (!ID.test(s)) throw new Error(`payload: ${field} non e un identificativo valido`);
  return s;
}

export function encodePayload(p: Payload): Uint8Array {
  return te.encode(JSON.stringify(p));
}

export function decodePayload(bytes: Uint8Array): Payload {
  let raw: unknown;
  try {
    raw = JSON.parse(td.decode(bytes));
  } catch {
    throw new Error('payload: non e JSON valido');
  }
  if (typeof raw !== 'object' || raw === null) throw new Error('payload: non e un oggetto');
  const o = raw as Record<string, unknown>;
  if (o['v'] !== PAYLOAD_VERSION) throw new Error(`payload: versione ${String(o['v'])}, attesa ${PAYLOAD_VERSION}`);

  switch (o['t']) {
    case 'presence':
      return { v: 1, t: 'presence', risposta: o['risposta'] === true };

    case 'copia':
      if (typeof o['dentro'] !== 'object' || o['dentro'] === null) throw new Error('payload: copia senza contenuto');
      return { v: 1, t: 'copia', per: id(o['per'], 'per'), dentro: o['dentro'] };

    case 'dispositivo.nuovo':
      // La voce non si valida qui: la sua forma la conosce `dispositivi.ts`,
      // che la ricontrolla firma compresa. Qui si accerta solo che ci sia.
      if (typeof o['voce'] !== 'object' || o['voce'] === null) throw new Error('payload: voce del dispositivo assente');
      return { v: 1, t: 'dispositivo.nuovo', voce: o['voce'] };

    case 'dispositivi': {
      const elenco = o['elenco'];
      if (!Array.isArray(elenco) || elenco.length > MAX_DISPOSITIVI_PAYLOAD) {
        throw new Error('payload: elenco dispositivi non valido');
      }
      return { v: 1, t: 'dispositivi', elenco };
    }

    case 'rubrica': {
      const contatti = o['contatti'];
      if (!Array.isArray(contatti) || contatti.length > MAX_MEMBERS) throw new Error('payload: rubrica non valida');
      return {
        v: 1,
        t: 'rubrica',
        contatti: contatti.map((c, i) => {
          const e = c as Record<string, unknown>;
          return {
            nome: str(e['nome'], MAX_NAME, `contatti[${i}].nome`),
            card: str(e['card'], MAX_CARD, `contatti[${i}].card`),
          };
        }),
      };
    }

    case 'delete':
      // L'identificativo e' un UUID, non esadecimale: si valida per forma e
      // lunghezza, non con il controllo degli identificativi di protocollo.
      return { v: 1, t: 'delete', id: str(o['id'], 64, 'id') };

    case 'file.offer': {
      const dimensione = o['dimensione'];
      const pezzi = o['pezzi'];
      if (typeof dimensione !== 'number' || !Number.isInteger(dimensione) || dimensione < 0) {
        throw new Error('payload: dimensione del file non valida');
      }
      if (typeof pezzi !== 'number' || !Number.isInteger(pezzi) || pezzi < 0) {
        throw new Error('payload: numero di pezzi non valido');
      }
      const via = o['via'];
      if (via !== 'mailbox' && via !== 'diretto') throw new Error('payload: via di consegna sconosciuta');
      const sha = str(o['sha256'], 64, 'sha256');
      if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error('payload: sha256 non valido');
      return {
        v: 1,
        t: 'file.offer',
        id: id(o['id'], 'id'),
        // Il nome arriva da un'altra macchina: qui si valida solo la forma, e
        // chi lo usa per scrivere su disco lo ripulisce comunque.
        nome: str(o['nome'], MAX_NOME_FILE, 'nome'),
        tipo: str(o['tipo'], 128, 'tipo'),
        dimensione,
        sha256: sha,
        via,
        pezzi,
        ...(o['mid'] === undefined ? {} : { mid: str(o['mid'], 64, 'mid') }),
      };
    }

    case 'file.chunk': {
      const n = o['n'];
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) throw new Error('payload: numero di pezzo non valido');
      return {
        v: 1,
        t: 'file.chunk',
        id: id(o['id'], 'id'),
        n,
        dati: str(o['dati'], MAX_PEZZO, 'dati'),
      };
    }

    case 'rtc': {
      const ruolo = o['ruolo'];
      if (ruolo !== 'offerta' && ruolo !== 'risposta' && ruolo !== 'candidato' && ruolo !== 'rifiuto') {
        throw new Error('payload: ruolo di segnalazione sconosciuto');
      }
      return { v: 1, t: 'rtc', id: id(o['id'], 'id'), ruolo, dati: str(o['dati'], MAX_SEGNALE, 'dati') };
    }

    case 'text':
      return {
        v: 1,
        t: 'text',
        text: str(o['text'], MAX_TEXT, 'text'),
        ...(o['mid'] === undefined ? {} : { mid: str(o['mid'], 64, 'mid') }),
      };

    case 'group.msg':
      return {
        v: 1,
        t: 'group.msg',
        g: id(o['g'], 'g'),
        topic: id(o['topic'], 'topic'),
        text: str(o['text'], MAX_TEXT, 'text'),
        ...(o['mid'] === undefined ? {} : { mid: str(o['mid'], 64, 'mid') }),
      };

    case 'group.state': {
      const members = o['members'];
      const topics = o['topics'];
      if (!Array.isArray(members) || members.length > MAX_MEMBERS) throw new Error('payload: elenco membri non valido');
      if (!Array.isArray(topics) || topics.length > MAX_TOPICS) throw new Error('payload: elenco argomenti non valido');
      return {
        v: 1,
        t: 'group.state',
        g: id(o['g'], 'g'),
        name: str(o['name'], MAX_NAME, 'name'),
        members: members.map((m, i) => {
          const e = m as Record<string, unknown>;
          return {
            id: id(e['id'], `members[${i}].id`),
            name: str(e['name'], MAX_NAME, `members[${i}].name`),
            card: str(e['card'], MAX_CARD, `members[${i}].card`),
          };
        }),
        topics: topics.map((t, i) => {
          const e = t as Record<string, unknown>;
          return { id: id(e['id'], `topics[${i}].id`), name: str(e['name'], MAX_NAME, `topics[${i}].name`) };
        }),
        at: typeof o['at'] === 'number' && Number.isFinite(o['at']) ? o['at'] : 0,
      };
    }

    default:
      throw new Error(`payload: tipo sconosciuto «${String(o['t'])}»`);
  }
}
