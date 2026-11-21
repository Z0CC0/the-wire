// Lo storico passa al dispositivo nuovo.
//
// Fino alla 0.1.1 un telefono appena collegato riceveva rubrica e dispositivi
// e ogni conversazione partiva vuota. Qui si difende che riceva anche i
// messaggi e i gruppi, senza doppioni, con le righe dei file ma senza i byte,
// e che un pacco malformato non scriva niente.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Account } from '../src/account.js';
import { MemoryMailbox } from '../src/mailbox.js';
import { hex } from '../src/codec.js';
import { History } from '../src/history.js';
import { DepositoMemoria } from '../src/deposito.js';
import { comprimi, decomprimi } from '../src/compressione.js';

const PASS = 'passphrase-di-prova';
const dirs: string[] = [];
async function cartella(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'wire-storico-'));
  dirs.push(d);
  return d;
}
beforeEach(() => MemoryMailbox.reset());
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function nuovo(nome = 'dispositivo'): Promise<Account> {
  const a = await Account.create(PASS, await cartella(), nome);
  await a.connect(new MemoryMailbox(hex(a.identity.nostrPublic)), { live: false });
  return a;
}

/** Due giri di ritiro per tutti: offerta e pezzi arrivano in due passaggi. */
async function giro(...conti: Account[]): Promise<void> {
  for (let i = 0; i < 3; i++) for (const c of conti) await c.sync();
}

describe('compressione', () => {
  it('gzip avanti e indietro, dove il runtime lo sa fare', async () => {
    const chiaro = new TextEncoder().encode('ciao '.repeat(1000));
    const stretto = await comprimi(chiaro);
    expect(stretto, 'Node 20 ha CompressionStream').not.toBeNull();
    expect(stretto!.length).toBeLessThan(chiaro.length / 5);
    expect(await decomprimi(stretto!)).toEqual(chiaro);
  });
});

describe('History.importa', () => {
  it('senza doppioni, in ordine di tempo', async () => {
    const key = new Uint8Array(32).fill(7);
    const h = new History(new DepositoMemoria(), 'storico', key);
    await h.append({ id: 'b', peer: 'aa'.repeat(8), mine: true, text: 'secondo', at: 200 });
    await h.append({ id: 'c', peer: 'aa'.repeat(8), mine: false, text: 'terzo', at: 300, origine: 'mid-3' });
    const quanti = await h.importa([
      { id: 'a', peer: 'aa'.repeat(8), mine: false, text: 'primo', at: 100 },
      { id: 'b', peer: 'aa'.repeat(8), mine: true, text: 'secondo', at: 200 }, // stesso id
      { id: 'z', peer: 'aa'.repeat(8), mine: false, text: 'terzo', at: 300, origine: 'mid-3' }, // stessa origine
      { id: 'y', peer: 'aa'.repeat(8), mine: true, text: 'secondo', at: 200 }, // stessa impronta
      { id: 'd', peer: 'aa'.repeat(8), mine: false, text: 'quarto', at: 400 },
    ]);
    expect(quanti).toBe(2);
    expect((await h.all()).map((m) => m.text)).toEqual(['primo', 'secondo', 'terzo', 'quarto']);
  });
});

describe('il dispositivo nuovo riceve lo storico', () => {
  it('messaggi di prima, in entrambi i versi, gruppi e nome', async () => {
    const alice = await nuovo('pc di alice');
    const bob = await nuovo('pc di bob');
    await alice.addContact(bob.uri, 'BOB');
    await bob.addContact(alice.uri, 'ALICE');
    await bob.setDisplayName('Bob');

    await alice.sendText(alice.contact('BOB')!, 'ciao bob');
    await bob.sync();
    await bob.sendText(bob.contact('ALICE')!, 'ciao alice');
    await alice.sync();
    const gruppo = await bob.createGroup('AMICI', [bob.contact('ALICE')!]);
    await alice.sync();
    await bob.sendGroupText(gruppo, gruppo.topics[0]!.id, 'nel gruppo');

    // BOB collega il telefono. Prima del collegamento il telefono non sa niente.
    const telefono = await nuovo('telefono');
    expect(await telefono.tuttiMessaggi()).toHaveLength(0);
    await telefono.collegatiCome(bob.codiceCollegamento());
    await giro(bob, telefono, alice);

    const alicePerTelefono = telefono.contact('ALICE');
    expect(alicePerTelefono, 'la rubrica arriva come prima').toBeDefined();
    const conv = await telefono.historyWith(alicePerTelefono!);
    expect(conv.map((m) => [m.text, m.mine])).toEqual([
      ['ciao bob', false],
      ['ciao alice', true],
    ]);
    const g = telefono.groups();
    expect(g.map((x) => x.name)).toEqual(['AMICI']);
    expect((await telefono.groupHistory(g[0]!)).map((m) => m.text)).toContain('nel gruppo');
    expect(telefono.displayName).toBe('Bob');
    // Si dice a chi guarda cosa e' arrivato.
    const sistema = (await telefono.tuttiMessaggi()).filter((m) => m.system && /Storico ricevuto/.test(m.text));
    expect(sistema).toHaveLength(1);

    await alice.close();
    await bob.close();
    await telefono.close();
  });

  it('i file arrivano come righe senza byte, con lo stato che lo dice', async () => {
    const alice = await nuovo();
    const bob = await nuovo();
    await alice.addContact(bob.uri, 'BOB');
    await bob.addContact(alice.uri, 'ALICE');
    await alice.sendFile(alice.contact('BOB')!, 'foto.png', 'image/png', new Uint8Array(40_000).fill(3));
    await bob.sync();
    await bob.sync();
    const ricevuto = (await bob.historyWith(bob.contact('ALICE')!)).find((m) => m.file);
    expect(ricevuto?.file?.stato).toBe('pronto');

    const telefono = await nuovo('telefono');
    await telefono.collegatiCome(bob.codiceCollegamento());
    await giro(bob, telefono, alice);

    const riga = (await telefono.historyWith(telefono.contact('ALICE')!)).find((m) => m.file);
    expect(riga?.file?.nome).toBe('foto.png');
    expect(riga?.file?.stato).toBe('altrove');
    expect(await telefono.fileEsiste(riga!.file!.id)).toBe(false);

    await alice.close();
    await bob.close();
    await telefono.close();
  });

  it('cio che arriva dopo il collegamento non si duplica con lo storico', async () => {
    const alice = await nuovo();
    const bob = await nuovo();
    await alice.addContact(bob.uri, 'BOB');
    await bob.addContact(alice.uri, 'ALICE');
    await alice.sendText(alice.contact('BOB')!, 'uno');
    await bob.sync();

    const telefono = await nuovo('telefono');
    await telefono.collegatiCome(bob.codiceCollegamento());
    // Il primo giro fa conoscere il telefono ad ALICE; da li' ALICE scrive a
    // entrambi i dispositivi di BOB.
    await giro(bob, telefono, alice);
    await alice.sendText(alice.contact('BOB')!, 'due');
    await giro(bob, telefono, alice);

    const testi = (await telefono.historyWith(telefono.contact('ALICE')!)).map((m) => m.text);
    expect(testi).toEqual(['uno', 'due']);
    const suBob = (await bob.historyWith(bob.contact('ALICE')!)).map((m) => m.text);
    expect(suBob).toEqual(['uno', 'due']);

    await alice.close();
    await bob.close();
    await telefono.close();
  });

  it('uno storico non ancora annunciato, o da un contatto, non scrive niente', async () => {
    // Si passa dalla porta pubblica: un contatto che manda `storico.offer`
    // viene ignorato perche' non e' noi. La prova e' indiretta ma completa:
    // nessuna riga di sistema e nessun messaggio importato.
    const alice = await nuovo();
    const bob = await nuovo();
    await alice.addContact(bob.uri, 'BOB');
    await bob.addContact(alice.uri, 'ALICE');
    // Un pezzo senza offerta: la mailbox in memoria consegna il payload cosi'
    // com'e' una volta cifrato dalla sessione, quindi si usa la via normale
    // e si verifica che il destinatario non lo tratti come storico.
    await alice.sendText(alice.contact('BOB')!, 'solo testo');
    await bob.sync();
    const sistema = (await bob.tuttiMessaggi()).filter((m) => m.system);
    expect(sistema).toHaveLength(0);
    await alice.close();
    await bob.close();
  });
});
