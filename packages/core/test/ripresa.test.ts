// Il difetto: a ogni avvio i messaggi gia' ricevuti tornavano indietro.
//
// La memoria di cosa era arrivato viveva solo in RAM, e la mailbox ritirava
// sempre le ultime due settimane. Riaprendo l'app, due settimane di buste
// rientravano come se fossero nuove.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Account } from '../src/account.js';
import { MemoryMailbox, SeenSet } from '../src/mailbox.js';
import { hex } from '../src/codec.js';

const PASS = 'passphrase-di-prova';
const dirs: string[] = [];

async function cartella(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'wire-rip-'));
  dirs.push(d);
  return d;
}

beforeEach(() => MemoryMailbox.reset());
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe('memoria di cosa e gia arrivato', () => {
  it('sopravvive a un riavvio: niente si ripresenta', async () => {
    const dirA = await cartella();
    const dirB = await cartella();
    const a = await Account.create(PASS, dirA);
    const b = await Account.create(PASS, dirB);
    await a.addContact(b.uri, 'BOB');
    await b.addContact(a.uri, 'ALICE');
    await a.connect(new MemoryMailbox(hex(a.identity.nostrPublic)), { live: false });
    await b.connect(new MemoryMailbox(hex(b.identity.nostrPublic)), { live: false });

    await a.sendText(a.contact('BOB')!, 'uno');
    await a.sendText(a.contact('BOB')!, 'due');
    expect(await b.sync()).toHaveLength(2);
    expect(await b.historyWith(b.contact('ALICE')!)).toHaveLength(2);
    await b.close();

    // Riapertura: la mailbox finta riconsegna tutto quello che ha in cassetta,
    // come farebbero i relay veri.
    const b2 = await Account.open(PASS, dirB);
    const cassetta = new MemoryMailbox(hex(b2.identity.nostrPublic));
    await b2.connect(cassetta, { live: false });
    const dopoRiavvio = await b2.sync();

    expect(dopoRiavvio).toHaveLength(0);
    expect(await b2.historyWith(b2.contact('ALICE')!)).toHaveLength(2);
    await a.close();
    await b2.close();
  });

  it('il punto di ripresa avanza solo dopo un ritiro riuscito', async () => {
    const dir = await cartella();
    const a = await Account.create(PASS, dir);
    await a.connect(new MemoryMailbox(hex(a.identity.nostrPublic)), { live: false });
    await a.sync();
    await a.close();

    // Riaperto, deve ricordarsi di aver gia' ritirato.
    const a2 = await Account.open(PASS, dir);
    await a2.connect(new MemoryMailbox(hex(a2.identity.nostrPublic)), { live: false });
    expect(await a2.sync()).toHaveLength(0);
    await a2.close();
  });
});

describe('registro di cio che e stato visto', () => {
  it('riparte da un elenco salvato', () => {
    const s = new SeenSet(100, ['a', 'b', 'c']);
    expect(s.add('a')).toBe(false);
    expect(s.add('d')).toBe(true);
    expect(s.elenco()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('non cresce oltre il tetto', () => {
    const s = new SeenSet(3, ['a', 'b', 'c', 'd', 'e']);
    expect(s.elenco()).toHaveLength(3);
    expect(s.add('e')).toBe(false); // gli ultimi sono quelli tenuti
    expect(s.add('a')).toBe(true); // il piu' vecchio e' uscito
  });
});

describe('archiviare e riordinare', () => {
  it('archiviare non cancella niente', async () => {
    const dirA = await cartella();
    const dirB = await cartella();
    const a = await Account.create(PASS, dirA);
    const b = await Account.create(PASS, dirB);
    await a.addContact(b.uri, 'BOB');
    const bob = a.contact('BOB')!;

    expect(a.archiviata(bob.id)).toBe(false);
    await a.archivia(bob.id);
    expect(a.archiviata(bob.id)).toBe(true);
    // Il contatto c'e' ancora: archiviare tocca solo come lo si vede.
    expect(a.contact('BOB')).toBeDefined();

    await a.archivia(bob.id, false);
    expect(a.archiviata(bob.id)).toBe(false);
    await a.close();
    await b.close();
  });

  it('l ordine scelto a mano sopravvive alla riapertura', async () => {
    const dir = await cartella();
    const a = await Account.create(PASS, dir);
    const b = await Account.create(PASS, await cartella());
    const c = await Account.create(PASS, await cartella());
    await a.addContact(b.uri, 'BOB');
    await a.addContact(c.uri, 'CARLA');
    const bob = a.contact('BOB')!;
    const carla = a.contact('CARLA')!;

    await a.riordina([carla.id, bob.id]);
    expect(a.ordine(carla.id)).toBe(1);
    expect(a.ordine(bob.id)).toBe(2);
    await a.close();

    const a2 = await Account.open(PASS, dir);
    expect(a2.ordine(carla.id)).toBe(1);
    expect(a2.ordine(bob.id)).toBe(2);
    await a2.close();
    await b.close();
    await c.close();
  });
});
