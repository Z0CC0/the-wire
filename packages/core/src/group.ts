// Gruppi, con piu' conversazioni dentro (argomenti).
//
// Consegna a ventaglio: un messaggio di gruppo viene cifrato separatamente per
// ogni membro, sulla sessione 1:1 che gia' esiste con lui. Costo O(N) per
// messaggio — con dieci amici sono dieci copie da un chilobyte, irrilevante.
//
// In cambio non c'e' nessuna crittografia nuova da inventare: forward secrecy e
// post-compromise security del Double Ratchet valgono nel gruppo esattamente
// come nel diretto. MLS avrebbe costo O(log N) e servirebbe oltre le centinaia
// di membri; qui sarebbe un protocollo intero in piu' per risolvere un problema
// che non abbiamo.
//
// Nessun comando "rimuovi membro": senza un'autorita' centrale che decide chi
// ha ragione, due rimozioni contemporanee non hanno una risposta giusta. Lo
// stato si fonde e basta; per uscire davvero si abbandona il gruppo in locale.

import { casuali } from './casuale.js';
import { hex } from './codec.js';
import type { GroupStatePayload, RosterEntry } from './payload.js';

export interface GroupTopic {
  readonly id: string;
  readonly name: string;
}

export interface Group {
  readonly id: string;
  readonly name: string;
  /** Include te stesso: e' la lista di chi riceve, non di chi e' "altro". */
  readonly members: readonly RosterEntry[];
  readonly topics: readonly GroupTopic[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Ogni gruppo nasce con un argomento, cosi' non esiste lo stato "vuoto".
 *  L'id e' esadecimale come tutti gli altri: il validatore del payload non fa
 *  eccezioni, e un id "parlante" verrebbe scartato insieme al resto. */
export const DEFAULT_TOPIC: GroupTopic = { id: '0000000000', name: 'GENERALE' };

export function newGroupId(): string {
  return hex(casuali(16));
}

export function newTopicId(): string {
  return hex(casuali(5));
}

export function findTopic(group: Group, idOrName: string): GroupTopic | undefined {
  const needle = idOrName.trim().toLowerCase();
  return (
    group.topics.find((t) => t.id === needle) ??
    group.topics.find((t) => t.name.toLowerCase() === needle) ??
    group.topics.find((t) => t.name.toLowerCase().startsWith(needle))
  );
}

/**
 * Fusione di due fotografie dello stesso gruppo.
 *
 * Unione su membri e argomenti — chi e' entrato non sparisce perche' un altro
 * aveva una copia vecchia. Sul nome vince la fotografia piu' recente. Il
 * risultato non dipende dall'ordine in cui arrivano gli aggiornamenti, che e'
 * l'unica proprieta' che conta quando non c'e' un server a fare da arbitro.
 */
export function mergeGroup(local: Group | undefined, incoming: GroupStatePayload, now: number): Group {
  if (!local) {
    return {
      id: incoming.g,
      name: incoming.name,
      members: dedupeById(incoming.members),
      topics: withDefaultTopic(incoming.topics),
      createdAt: now,
      updatedAt: incoming.at || now,
    };
  }
  const piuRecente = (incoming.at || 0) >= local.updatedAt;
  return {
    id: local.id,
    name: piuRecente ? incoming.name : local.name,
    members: dedupeById([...local.members, ...incoming.members]),
    topics: withDefaultTopic(dedupeTopics([...local.topics, ...incoming.topics])),
    createdAt: local.createdAt,
    updatedAt: Math.max(local.updatedAt, incoming.at || 0),
  };
}

function dedupeById(entries: readonly RosterEntry[]): RosterEntry[] {
  const map = new Map<string, RosterEntry>();
  // Il primo vince: lo stato locale, che abbiamo gia' verificato, non viene
  // sovrascritto da come lo racconta qualcun altro.
  for (const e of entries) if (!map.has(e.id)) map.set(e.id, e);
  return [...map.values()];
}

function dedupeTopics(topics: readonly GroupTopic[]): GroupTopic[] {
  const map = new Map<string, GroupTopic>();
  for (const t of topics) if (!map.has(t.id)) map.set(t.id, t);
  return [...map.values()];
}

function withDefaultTopic(topics: readonly GroupTopic[]): GroupTopic[] {
  return topics.some((t) => t.id === DEFAULT_TOPIC.id) ? [...topics] : [DEFAULT_TOPIC, ...topics];
}

/** La fotografia da spedire agli altri. */
export function stateOf(group: Group): GroupStatePayload {
  return {
    v: 1,
    t: 'group.state',
    g: group.id,
    name: group.name,
    members: group.members,
    topics: group.topics,
    at: group.updatedAt,
  };
}
