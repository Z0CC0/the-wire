// Il server di appoggio per il collegamento diretto, quando due router non si
// trovano.
//
// ICE prova prima le strade dirette: indirizzi di rete locale e indirizzo
// visto da fuori (STUN). Certe coppie di router non lasciano passare nessuna
// delle due, e senza un terzo che faccia da tramite il trasferimento non parte.
// Quel terzo e' un server TURN: riceve i pacchetti da un capo e li rimanda
// all'altro. Vede gli indirizzi IP dei due e il flusso cifrato (DTLS), non il
// contenuto.
//
// Questo programma non ne porta uno suo: sarebbe un server da pagare e da
// tenere acceso, cioe' esattamente quello che il resto del progetto evita. Chi
// ne ha uno — un coturn proprio, o il piano gratuito di un fornitore — lo
// scrive qui, e ICE lo usa da solo come ultima strada. Basta che lo abbia
// configurato UNO dei due: il candidato "relay" di una parte si accoppia con
// l'indirizzo dell'altra.

/** Un server TURN, come lo si scrive nelle impostazioni. */
export interface ServerTurn {
  /** `turn:host:porta` oppure `turns:host:porta` (TLS). Facoltativo `?transport=tcp`. */
  readonly url: string;
  readonly utente: string;
  readonly password: string;
}

const FORMA_URL = /^turns?:[A-Za-z0-9.-]+(:\d{1,5})?(\?transport=(udp|tcp))?$/;
const MAX = 256;

/**
 * Controlla e ripulisce quello che l'utente ha scritto.
 *
 * Vale per la pagina e per il cuore insieme: il controllo sta qui, nel cuore,
 * perche' la pagina si puo' aggirare. Un URL sbagliato non fallisce in modo
 * visibile dentro Chromium — la connessione parte senza quel server e il
 * trasferimento fallisce dopo trenta secondi con una diagnosi che non lo
 * nomina — quindi va rifiutato PRIMA di finire nel deposito.
 *
 * Utente e password sono obbligatori: Chromium rifiuta un server `turn:` senza
 * credenziali, e lo fa alla creazione della connessione, cioe' nel punto
 * peggiore.
 */
export function validaTurn(input: { url?: unknown; utente?: unknown; password?: unknown }): ServerTurn {
  const url = String(input.url ?? '').trim();
  const utente = String(input.utente ?? '').trim();
  const password = String(input.password ?? '');
  if (!url) throw new Error('manca l indirizzo del server TURN');
  if (url.length > MAX || utente.length > MAX || password.length > MAX) throw new Error('valore troppo lungo');
  if (!FORMA_URL.test(url)) {
    throw new Error('indirizzo non valido: serve turn:host:porta oppure turns:host:porta');
  }
  const porta = /:(\d{1,5})(\?|$)/.exec(url)?.[1];
  if (porta !== undefined && (Number(porta) < 1 || Number(porta) > 65535)) throw new Error('porta non valida');
  if (!utente) throw new Error('manca il nome utente del server TURN');
  if (!password) throw new Error('manca la password del server TURN');
  return { url, utente, password };
}

/** Solo la parte che si puo' mostrare: host e porta, senza credenziali. */
export function etichettaTurn(t: ServerTurn): string {
  return t.url.replace(/^turns?:/, '').replace(/\?.*$/, '');
}
