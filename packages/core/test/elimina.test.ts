// Eliminare messaggi.
//
// Due regole che il codice deve difendere, e che non sono negoziabili:
//
//   1. si tolgono ANCHE ALL'ALTRO solo i propri messaggi. Far sparire dal
//      dispositivo di qualcuno qualcosa che ha scritto lui non e' una funzione
//      che questo programma offre, e una richiesta del genere si scarta.
//   2. il testo sparisce dai BYTE, non solo dalla vista. Il registro e' in sola
//      aggiunta, quindi svuotare un messaggio richiede di riscrivere il file:
//      lasciare il record vecchio in coda vorrebbe dire cancellare a parole.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Account, HISTORY_FILE } from '../src/account.js';
import { MemoryMailbox } from '../src/mailbox.js';
import { hex } from '../src/codec.js';

const PASS = 'passphrase-di-prova';
const dirs: string[] = [];

async function cartella(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'wire-del-'));
  dirs.push(d);
  return d;
}

const respiro = () => new Promise((r) => setTimeout(r, 120));

beforeEach(() => MemoryMailbox.reset());
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function coppia(): Promise<[Account, Account, string, string]> {
  const dirA = await cartella();
  const dirB = await cartella();
  const a = await Account.create(PASS, dirA);
  const b = await Account.create(PASS, dirB);
  await a.addContact(b.uri, 'BOB');
  await b.addContact(a.uri, 'ALICE');
  await b.connect(new MemoryMailbox(hex(b.identity.nostrPublic)));
  await a.connect(new MemoryMailbox(hex(a.identity.nostrPublic)));
  await respiro();
  return [a, b, dirA, dirB];
}

describe('eliminare messaggi', () => {
  it('per entrambi: sparisce anche dall altra parte, e resta il segnaposto', async () => {
    const [a, b] = await coppia();
    const inviato = await a.sendText(a.contact('BOB')!, 'da far sparire');
    await respiro();

    const primaDiB = (await b.historyWith(b.contact('ALICE')!)).find((m) => m.text === 'da far sparire');
    expect(primaDiB).toBeDefined();

    await a.eliminaMessaggio(inviato.id, true);
    await respiro();

    const daA = (await a.historyWith(a.contact('BOB')!)).find((m) => m.id === inviato.id);
    expect(daA?.text).toBe('');
    expect(daA?.eliminato).toBe('entrambi');

    const daB = (await b.historyWith(b.contact('ALICE')!)).find((m) => m.id === primaDiB!.id);
    // Il segnaposto resta: un buco senza spiegazione si legge peggio.
    expect(daB).toBeDefined();
    expect(daB?.text).toBe('');
    expect(daB?.eliminato).toBe('entrambi');

    await a.close();
    await b.close();
  });

  it('per me: l altro non se ne accorge', async () => {
    const [a, b] = await coppia();
    const inviato = await a.sendText(a.contact('BOB')!, 'tolgo solo dal mio');
    await respiro();

    await a.eliminaMessaggio(inviato.id, false);
    await respiro();

    expect((await a.historyWith(a.contact('BOB')!)).find((m) => m.id === inviato.id)?.eliminato).toBe('io');
    const daB = (await b.historyWith(b.contact('ALICE')!)).find((m) => !m.mine);
    expect(daB?.text).toBe('tolgo solo dal mio');
    expect(daB?.eliminato).toBeUndefined();

    await a.close();
    await b.close();
  });

  it('non si toglie dall altro un messaggio che ha scritto lui', async () => {
    const [a, b] = await coppia();
    await b.sendText(b.contact('ALICE')!, 'questo l ho scritto io, B');
    await respiro();

    const suo = (await a.historyWith(a.contact('BOB')!)).find((m) => !m.mine)!;
    await expect(a.eliminaMessaggio(suo.id, true)).rejects.toThrow(/solo i propri/);
    // Ma toglierlo dal proprio dispositivo si puo' sempre.
    await a.eliminaMessaggio(suo.id, false);
    expect((await a.historyWith(a.contact('BOB')!)).find((m) => m.id === suo.id)?.eliminato).toBe('io');
    // E dall'altra parte non e' cambiato niente.
    expect((await b.historyWith(b.contact('ALICE')!)).find((m) => m.mine)?.text).toBe('questo l ho scritto io, B');

    await a.close();
    await b.close();
  });

  it('il testo eliminato sparisce dai byte del registro, non solo dalla vista', async () => {
    const [a, b, dirA] = await coppia();
    const parola = 'PAROLA-RICONOSCIBILE-NEL-FILE';
    const inviato = await a.sendText(a.contact('BOB')!, parola);
    await respiro();

    // Il registro e' cifrato, quindi la parola non si vede comunque: si
    // controlla invece che il record non sia rimasto in coda, contando i
    // messaggi che il registro restituisce dopo l'eliminazione.
    const primaBytes = (await readFile(join(dirA, HISTORY_FILE))).length;
    await a.eliminaMessaggio(inviato.id, true);
    const dopoBytes = (await readFile(join(dirA, HISTORY_FILE))).length;

    // Riscritto, non accodato: il file si accorcia perche' il testo non c'e'
    // piu'. Se si fosse solo aggiunto un record nuovo, sarebbe cresciuto.
    expect(dopoBytes).toBeLessThan(primaBytes);
    const righe = await a.historyWith(a.contact('BOB')!);
    expect(righe.filter((m) => m.id === inviato.id)).toHaveLength(1);
    expect(righe.find((m) => m.id === inviato.id)?.text).toBe('');

    await a.close();
    await b.close();
  });

  it('eliminare un file toglie anche i byte del file', async () => {
    const [a, b] = await coppia();
    const dati = new Uint8Array(20 * 1024).fill(5);
    const inviato = await a.sendFile(a.contact('BOB')!, 'foto.png', 'image/png', dati);
    await respiro();
    expect(await a.fileEsiste(inviato.file!.id)).toBe(true);

    await a.eliminaMessaggio(inviato.id, true);
    await respiro();
    expect(await a.fileEsiste(inviato.file!.id)).toBe(false);

    const daB = (await b.historyWith(b.contact('ALICE')!)).find((m) => !m.mine);
    expect(daB?.eliminato).toBe('entrambi');
    expect(await b.fileEsiste(inviato.file!.id)).toBe(false);

    await a.close();
    await b.close();
  });

  it('l eliminazione sopravvive alla riapertura', async () => {
    const [a, b, dirA] = await coppia();
    const inviato = await a.sendText(a.contact('BOB')!, 'sparisci');
    await respiro();
    await a.eliminaMessaggio(inviato.id, true);
    await a.close();
    await b.close();

    const riaperto = await Account.open(PASS, dirA);
    const riga = (await riaperto.historyWith(riaperto.contact('BOB')!)).find((m) => m.id === inviato.id);
    expect(riga?.eliminato).toBe('entrambi');
    expect(riga?.text).toBe('');
    await riaperto.close();
  });
});
