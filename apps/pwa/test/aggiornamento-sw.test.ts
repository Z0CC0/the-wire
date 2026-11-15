// Il service worker che decide se l'app e' cambiata sul sito.
//
// E' la difesa che regge quando l'account di chi pubblica non regge piu': il
// telefono parte dalla copia che ha, e una versione nuova entra solo se
// qualcuno la accetta dopo aver letto l'avviso. Le cose che devono essere vere:
//
//   - se sul sito non e' cambiato niente, nessun avviso (uno che compare a
//     vuoto insegna a ignorarlo, e allora tanto vale non averlo);
//   - se un file e' cambiato, l'avviso c'e' — anche se la versione dichiarata
//     e' la stessa, perche' e' cosi' che si presenterebbe una manomissione;
//   - senza rete non si inventa nulla;
//   - l'app installata non si rompe se l'aggiornamento fallisce a meta'.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const SORGENTE = readFileSync(join(process.cwd(), 'apps/pwa/pubblico/sw.js'), 'utf8');

/** Una cache finta, con lo stesso comportamento di quella dei browser. */
class CacheFinta {
  dentro = new Map<string, string>();
  async match(k: string | { url: string }) {
    const chiave = typeof k === 'string' ? k : k.url;
    const v = this.dentro.get(chiave);
    return v === undefined ? undefined : risposta(v);
  }
  async put(k: string | { url: string }, r: { text(): Promise<string> }) {
    this.dentro.set(typeof k === 'string' ? k : k.url, await r.text());
  }
  /** Come quella vera: scarica, e se una sola richiesta fallisce fallisce tutto.
   *  Senza questo il finto direbbe "riuscito" anche senza rete. */
  async addAll(chiavi: string[]) {
    const prese = await Promise.all(chiavi.map(async (c) => [c, await (await this.rete(c)).text()] as const));
    for (const [c, v] of prese) this.dentro.set(c, v);
  }
  rete: (url: string) => Promise<{ text(): Promise<string> }> = async () => risposta('');
  async keys() {
    return [...this.dentro.keys()];
  }
}

function risposta(testo: string) {
  return {
    ok: true,
    async text() {
      return testo;
    },
    clone() {
      return risposta(testo);
    },
  };
}

/** Carica il service worker in un finto browser e restituisce come parlargli. */
function avvia(opzioni: { suSito: string | null; installate: string }) {
  const cache = new CacheFinta();
  cache.dentro.set('./IMPRONTE.txt', opzioni.installate);
  cache.rete = async (url: string) => {
    if (opzioni.suSito === null) throw new Error('niente rete');
    return risposta('contenuto di ' + url);
  };
  const ascoltatori = new Map<string, (e: unknown) => void>();
  const detti: unknown[] = [];

  const ctx: Record<string, unknown> = {
    console,
    URL,
    Date,
    Boolean,
    Promise,
    Error,
    caches: {
      async open() {
        return cache;
      },
      async keys() {
        return [];
      },
      async delete() {
        return true;
      },
      async match(k: string) {
        return cache.match(k);
      },
    },
    fetch: async (url: string) => {
      if (opzioni.suSito === null) throw new Error('niente rete');
      if (String(url).includes('IMPRONTE.txt')) return risposta(opzioni.suSito);
      return risposta('un file');
    },
    self: {
      addEventListener: (nome: string, f: (e: unknown) => void) => ascoltatori.set(nome, f),
      skipWaiting: () => {},
      clients: { claim: () => {} },
      location: { origin: 'https://esempio.test' },
    },
  };
  ctx['globalThis'] = ctx;
  vm.createContext(ctx);
  vm.runInContext(SORGENTE, ctx);

  /** Manda un messaggio al service worker e aspetta cosa risponde. */
  const chiedi = async (messaggio: string) => {
    const f = ascoltatori.get('message');
    if (!f) throw new Error('il service worker non ascolta i messaggi');
    let attesa: Promise<unknown> = Promise.resolve();
    f({
      data: messaggio,
      source: { postMessage: (d: unknown) => detti.push(d) },
      waitUntil: (p: Promise<unknown>) => {
        attesa = p;
      },
    });
    await attesa;
    return detti[detti.length - 1] as { tipo: string; diverso?: boolean; riuscito?: boolean };
  };

  return { chiedi, cache };
}

const IMPRONTE_A = 'aaa111  app.js\nbbb222  index.html\n';
const IMPRONTE_B = 'ccc333  app.js\nbbb222  index.html\n';

describe('il service worker e gli aggiornamenti', () => {
  it('sito identico: nessun avviso', async () => {
    const { chiedi } = avvia({ suSito: IMPRONTE_A, installate: IMPRONTE_A });
    expect((await chiedi('cerca-aggiornamento')).diverso).toBe(false);
  });

  it('un file cambiato: avviso', async () => {
    // Stessa versione dichiarata, un file diverso: e' come si presenterebbe
    // un'app sostituita da qualcuno che non vuole farsi notare.
    const { chiedi } = avvia({ suSito: IMPRONTE_B, installate: IMPRONTE_A });
    expect((await chiedi('cerca-aggiornamento')).diverso).toBe(true);
  });

  it('spazi e a capo diversi non contano come cambiamento', async () => {
    const { chiedi } = avvia({ suSito: IMPRONTE_A + '\n\n', installate: '\n' + IMPRONTE_A });
    expect((await chiedi('cerca-aggiornamento')).diverso).toBe(false);
  });

  it('senza rete non si dice niente', async () => {
    const { chiedi } = avvia({ suSito: null, installate: IMPRONTE_A });
    expect((await chiedi('cerca-aggiornamento')).diverso).toBe(false);
  });

  it('alla prima installazione non si avvisa di niente', async () => {
    // Non c'e' ancora una copia con cui confrontare: dire "e' cambiato"
    // sarebbe falso, e allarmerebbe chi sta solo installando.
    const { chiedi } = avvia({ suSito: IMPRONTE_A, installate: '' });
    expect((await chiedi('cerca-aggiornamento')).diverso).toBe(false);
  });

  it('applicare un aggiornamento riesce e lo dice', async () => {
    const { chiedi } = avvia({ suSito: IMPRONTE_B, installate: IMPRONTE_A });
    const esito = await chiedi('applica-aggiornamento');
    expect(esito.tipo).toBe('aggiornato');
    expect(esito.riuscito).toBe(true);
  });

  it('se l aggiornamento fallisce lo dice, invece di far finta', async () => {
    // Rete che cade a meta': l'app installata deve restare quella di prima, e
    // chi guarda deve poter riprovare.
    const { chiedi } = avvia({ suSito: null, installate: IMPRONTE_A });
    const esito = await chiedi('applica-aggiornamento');
    expect(esito.tipo).toBe('aggiornato');
    expect(esito.riuscito).toBe(false);
  });
});
