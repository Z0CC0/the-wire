// Un solo programma alla volta sul deposito.
//
// Il ratchet e' un libretto di assegni: ogni messaggio ha il suo numero e la
// sua chiave usa-e-getta, e si va solo avanti. Due programmi aperti sullo
// stesso deposito sono due libretti con la stessa numerazione — staccano lo
// stesso numero, il destinatario accetta il primo e rifiuta il secondo, e il
// messaggio non arriva mai. Senza errori sullo schermo, e senza rimedio: quel
// numero e' bruciato.
//
// Non e' uno scenario da laboratorio: l'installer mette due collegamenti,
// due finestre dello stesso programma, una accanto all'altra.

import { readFile, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';

export const LOCK_FILE = 'wire.lock';

interface Occupante {
  readonly pid: number;
  readonly host: string;
  readonly at: number;
}

/** true se quel processo esiste ancora. Il segnale 0 non fa nulla: chiede e basta. */
function vivo(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: esiste ma e' di un altro utente. Esiste, quindi conta.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class VaultInUso extends Error {
  constructor(
    readonly percorso: string,
    readonly occupante: Occupante | null
  ) {
    const chi = occupante ? ` (processo ${occupante.pid} su ${occupante.host})` : '';
    super(
      `THE WIRE e gia aperto su questo deposito${chi}. ` +
        `Chiudi l altra finestra e riprova. ` +
        `Se sei certo che non sia in esecuzione, elimina: ${percorso}`
    );
    this.name = 'VaultInUso';
  }
}

export class VaultLock {
  private rilasciato = false;

  private constructor(
    private readonly percorso: string,
    private readonly pid: number
  ) {}

  /**
   * Prende il deposito, o spiega perche' non puo'.
   *
   * Un programma finito male lascia il file li'. Per questo non basta la sua
   * esistenza: si guarda se il processo scritto dentro e' ancora vivo, e se non
   * lo e' il file viene considerato spazzatura e sostituito. Altrimenti un
   * crash ti chiuderebbe fuori da casa tua senza dirti come rientrare.
   */
  static async acquire(dir: string): Promise<VaultLock> {
    const percorso = join(dir, LOCK_FILE);
    const mio: Occupante = { pid: process.pid, host: hostname(), at: Date.now() };

    for (let tentativo = 0; tentativo < 2; tentativo++) {
      try {
        // wx: la creazione fallisce se il file c'e' gia'. E' il sistema
        // operativo a garantire che due processi non riescano insieme.
        await writeFile(percorso, JSON.stringify(mio), { flag: 'wx' });
        return new VaultLock(percorso, process.pid);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;

        const occupante = await VaultLock.leggi(percorso);
        // Di un altro computer non possiamo sapere niente: si rispetta.
        if (occupante && occupante.host === mio.host && !vivo(occupante.pid)) {
          await unlink(percorso).catch(() => {});
          continue; // era spazzatura di un programma finito male
        }
        throw new VaultInUso(percorso, occupante);
      }
    }
    throw new VaultInUso(percorso, await VaultLock.leggi(percorso));
  }

  private static async leggi(percorso: string): Promise<Occupante | null> {
    try {
      const o = JSON.parse(await readFile(percorso, 'utf8')) as Partial<Occupante>;
      if (typeof o.pid !== 'number' || typeof o.host !== 'string') return null;
      return { pid: o.pid, host: o.host, at: typeof o.at === 'number' ? o.at : 0 };
    } catch {
      // File illeggibile: trattarlo come "occupato da ignoto" e' piu' prudente
      // che cancellarlo e prendersi il deposito.
      return null;
    }
  }

  /** Solo chi l'ha preso lo rilascia: non si tocca il lock di un altro. */
  async release(): Promise<void> {
    if (this.rilasciato) return;
    this.rilasciato = true;
    const occupante = await VaultLock.leggi(this.percorso);
    if (occupante && occupante.pid !== this.pid) return;
    await unlink(this.percorso).catch(() => {});
  }
}
