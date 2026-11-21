// I relay: quali, di chi, e cosa fare quando non rispondono.
//
// Fino alla 0.1.1 i cinque relay stavano scritti nel programma e basta: se
// fossero caduti tutti, niente sarebbe partito, e il README lo diceva. Qui
// stanno le tre cose che chiudono quel difetto senza aggiungere un server:
//
//   1. una LISTA PERSONALE, che chi usa il programma puo' scrivere al posto
//      di quella predefinita;
//   2. i relay viaggiano DENTRO la voce del dispositivo, firmati dalla chiave
//      d'account: chi ti scrive pubblica dove TU ascolti, non dove ascolta lui.
//      E' questo che fa ritrovare due persone con liste diverse;
//   3. una RISERVA, usata da entrambe le parti solo quando la lista normale
//      non risponde per intero. Se cadono tutti e cinque, ci si ritrova li'.
//
// La riserva e' misurata, non scelta a sentimento: il 2026-11-21 sono stati
// provati ventinove relay pubblici con un gift wrap da 54 KB (la dimensione
// vera di un pezzo di file) firmato da una chiave mai vista. Ventuno hanno
// rifiutato — connessione caduta, "pubkey non ammessa", "serve un NIP-05",
// "a pagamento", "kind 1059 non permesso", lista di fiducia — e tre hanno
// accettato oltre ai cinque di sempre. Sono questi tre.

/**
 * I relay di riserva. Si usano SOLO quando nessuno di quelli normali risponde,
 * e si usano da entrambe le parti: e' cio' che li rende un punto d'incontro.
 */
export const RELAY_RISERVA = [
  'wss://relay.nostr.net',
  'wss://nostr.sathoarder.com',
  'wss://relay.nostr.wirednet.jp',
] as const;

/** Piu' di cosi' non e' ridondanza: e' attesa. Ogni invio aspetta il piu' lento. */
export const MAX_RELAY = 8;
const MAX_LUNGHEZZA = 200;

/**
 * Solo `wss://`, solo un nome di host, niente credenziali nell'indirizzo.
 *
 * `ws://` in chiaro si rifiuta apposta: chi sta sulla stessa rete vedrebbe
 * l'indirizzo del destinatario di ogni busta, che e' esattamente il dato che
 * il trasporto cifrato nasconde a chi guarda il filo.
 */
const FORMA = /^wss:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~\-/]*)?$/;

/** Un indirizzo di relay ripulito, o un errore che dice cosa non va. */
export function validaRelay(input: unknown): string {
  let s = String(input ?? '').trim();
  if (!s) throw new Error('indirizzo del relay vuoto');
  if (s.length > MAX_LUNGHEZZA) throw new Error('indirizzo del relay troppo lungo');
  // Scritto senza schema, o con quello sbagliato: si aggiusta quello che si
  // puo' aggiustare senza indovinare.
  if (/^[A-Za-z0-9.-]/.test(s) && !/^[a-z]+:\/\//i.test(s)) s = `wss://${s}`;
  if (/^ws:\/\//i.test(s)) throw new Error(`${s}: serve wss://, in chiaro non si accetta`);
  if (!FORMA.test(s)) throw new Error(`${s}: non e un indirizzo di relay (atteso wss://host)`);
  const porta = /:(\d{1,5})(\/|$)/.exec(s.slice('wss://'.length))?.[1];
  if (porta !== undefined && (Number(porta) < 1 || Number(porta) > 65535)) throw new Error('porta non valida');
  // Lo stesso relay scritto con la barra finale o senza e' lo stesso relay.
  return s.replace(/\/+$/, '');
}

/**
 * Una lista come la si salva: ripulita, senza doppioni, nel tetto.
 *
 * Vuota non e' permessa: una lista personale vuota vorrebbe dire "nessun
 * relay", e nessun relay vuol dire nessun messaggio. Chi vuole tornare ai
 * predefiniti li rimette, non svuota.
 */
export function normalizzaRelay(elenco: readonly unknown[]): string[] {
  if (!Array.isArray(elenco)) throw new Error('la lista dei relay deve essere un elenco');
  const out: string[] = [];
  for (const voce of elenco) {
    const r = validaRelay(voce);
    if (!out.includes(r)) out.push(r);
  }
  if (!out.length) throw new Error('serve almeno un relay');
  if (out.length > MAX_RELAY) throw new Error(`al massimo ${MAX_RELAY} relay`);
  return out;
}

/**
 * Da una riga scritta a mano (uno per riga, o separati da spazi e virgole) a
 * una lista. E' il formato del campo nelle impostazioni.
 */
export function relayDaTesto(testo: string): string[] {
  return normalizzaRelay(
    String(testo ?? '')
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

/**
 * Su quali relay pubblicare per raggiungere UN dispositivo.
 *
 * Prima i suoi, perche' e' li' che ascolta; poi i propri, perche' finche' le
 * liste coincidono — ed e' il caso normale, con i predefiniti — non cambia
 * niente, e quando non coincidono si copre il periodo in cui lui ha gia'
 * cambiato lista e il suo annuncio non e' ancora arrivato. Senza doppioni, e
 * nel tetto: il tetto taglia i PROPRI, mai i suoi.
 */
export function relayPerInvio(miei: readonly string[], suoi: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const r of suoi ?? []) if (!out.includes(r)) out.push(r);
  for (const r of miei) if (!out.includes(r) && out.length < Math.max(MAX_RELAY, (suoi ?? []).length)) out.push(r);
  return out;
}

/** Come sta un relay, per mostrarlo. `ms` e' il tempo per aprire il collegamento. */
export interface StatoRelay {
  readonly url: string;
  readonly stato: 'ok' | 'ko';
  readonly ms: number | null;
  /** Il motivo dell'ultimo rifiuto, se c'e' stato. */
  readonly errore: string | null;
  /** Quante volte ha rifiutato o non risposto da quando il programma e' acceso. */
  readonly errori: number;
  readonly riserva: boolean;
}
