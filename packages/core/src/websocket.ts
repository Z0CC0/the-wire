// Il WebSocket che serve alla mailbox, dove il sistema non ce l'ha.
//
// Node ha `WebSocket` fra le variabili globali solo dalla 22 in poi. Electron 33
// porta Node 20: dentro l'app quel globale NON esiste, e senza di lui ogni
// connessione ai relay muore subito. L'errore che ne viene fuori — "nessuno dei
// relay ha accettato il messaggio" — manda a cercare il guasto nella rete, dove
// non c'e'.
//
// Si mette a posto il globale, non le variabili interne della libreria.
// `nostr-tools` distribuisce piu' punti d'ingresso, e alcuni portano dentro una
// propria copia del codice dei relay: ognuna ha la sua variabile, e sistemarne
// una lascia le altre come stavano. Il fallback di tutte quelle copie e' il
// globale — quindi e' il globale che va fornito, una volta, per tutte.
//
// E' un polyfill: si applica solo dove manca, e dove c'e' vince quello del
// sistema, che e' gia' collaudato.

import WebSocketNode from 'ws';
import { useWebSocketImplementation as usaNelPool } from 'nostr-tools/pool';
import { useWebSocketImplementation as usaNelRelay } from 'nostr-tools/relay';

let sistemato = false;

/** Idempotente: chiamarla due volte non cambia niente. */
export function assicuraWebSocket(): void {
  if (sistemato) return;
  sistemato = true;

  const contenitore = globalThis as { WebSocket?: unknown };
  if (typeof contenitore.WebSocket === 'undefined') {
    contenitore.WebSocket = WebSocketNode;
  }
  // Anche per la via ufficiale, dove esiste: costa niente e copre le copie della
  // libreria che leggono la propria variabile invece del globale.
  usaNelPool(WebSocketNode);
  usaNelRelay(WebSocketNode);
}

/** Quale implementazione e' in uso. Serve alla diagnostica, non al funzionamento. */
export function webSocketInUso(): 'sistema' | 'ws' {
  const w = (globalThis as { WebSocket?: unknown }).WebSocket;
  return w === WebSocketNode ? 'ws' : 'sistema';
}
