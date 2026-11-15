// La presenza: sapere se l'altro c'e' adesso.
//
// Due proprieta' vanno difese con i test, perche' sbagliarle costa caro e non
// si vede subito:
//
//   1. il battito NON deve passare dal ratchet. Se lo facesse, consumerebbe una
//      chiave ogni 45 secondi: chi resta spento un giorno tornerebbe con
//      centinaia di chiavi saltate, e oltre MAX_SKIP la sessione si rompe per
//      sempre. Un pallino verde non puo' costare una conversazione.
//   2. un battito perso non deve valere niente. Non finisce nel registro dei
//      ritiri, non si ripesca all'avvio, non lascia traccia nello storico.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Account, FINESTRA_ONLINE_MS } from '../src/account.js';
import { MemoryMailbox } from '../src/mailbox.js';
import { hex } from '../src/codec.js';

const PASS = 'passphrase-di-prova';
const dirs: string[] = [];

async function cartella(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'wire-pres-'));
  dirs.push(d);
  return d;
}

/** Il battito parte da solo alla connessione, ma via `setInterval`: qui si
 *  aspetta il giro, non lo si simula. */
// Sulle macchine di GitHub (due core, Argon2id a 64 MB) la stessa pausa non
// basta: il tempo si allunga solo li', in locale resta quello che e'.
const respiro = () => new Promise((r) => setTimeout(r, process.env['CI'] ? 720 : 60));

beforeEach(() => MemoryMailbox.reset());
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function coppia(): Promise<[Account, Account]> {
  const a = await Account.create(PASS, await cartella());
  const b = await Account.create(PASS, await cartella());
  await a.addContact(b.uri, 'BOB');
  await b.addContact(a.uri, 'ALICE');
  return [a, b];
}

describe('presenza', () => {
  it('chi si collega risulta online per l altro, e viceversa', async () => {
    const [a, b] = await coppia();

    // Prima di collegarsi non risulta online nessuno dei due.
    expect(a.online(b.id)).toBe(false);
    expect(a.visto(b.id)).toBeNull();

    await b.connect(new MemoryMailbox(hex(b.identity.nostrPublic)));
    await a.connect(new MemoryMailbox(hex(a.identity.nostrPublic)));
    await respiro();

    // Alice si e' annunciata collegandosi: Bob la vede.
    expect(b.online(a.id)).toBe(true);
    // E Bob ha risposto al saluto, quindi anche Alice vede Bob — senza dover
    // aspettare il proprio giro di battito.
    expect(a.online(b.id)).toBe(true);

    await a.close();
    await b.close();
  });

  it('il battito non consuma chiavi del ratchet', async () => {
    const [a, b] = await coppia();
    await b.connect(new MemoryMailbox(hex(b.identity.nostrPublic)));
    await a.connect(new MemoryMailbox(hex(a.identity.nostrPublic)));
    await respiro();

    // Molti battiti, come dopo un pomeriggio con l'app aperta.
    for (let i = 0; i < 200; i++) await a['annuncia']();
    await respiro();

    // Se i battiti fossero passati dal ratchet, questo messaggio arriverebbe
    // con 200 chiavi da saltare. Deve arrivare e basta.
    await a.sendText(a.contact('BOB')!, 'dopo duecento battiti');
    await respiro();
    const storico = await b.historyWith(b.contact('ALICE')!);
    expect(storico.map((m) => m.text)).toEqual(['dopo duecento battiti']);

    await a.close();
    await b.close();
  });

  it('un battito perso non lascia traccia: niente nello storico, niente da ripescare', async () => {
    const [a, b] = await coppia();
    // Bob NON e' in ascolto: i suoi battiti in arrivo cadono nel vuoto.
    await a.connect(new MemoryMailbox(hex(a.identity.nostrPublic)));
    await b.connect(new MemoryMailbox(hex(b.identity.nostrPublic)), { live: false });
    await a['annuncia']();

    // Il ritiro non riporta indietro battiti, nemmeno quelli persi.
    expect(await b.sync()).toHaveLength(0);
    expect(await b.historyWith(b.contact('ALICE')!)).toHaveLength(0);
    expect(b.online(a.id)).toBe(false);

    await a.close();
    await b.close();
  });

  it('chi smette di battere si spegne da solo', async () => {
    const [a, b] = await coppia();
    await b.connect(new MemoryMailbox(hex(b.identity.nostrPublic)));
    await a.connect(new MemoryMailbox(hex(a.identity.nostrPublic)));
    await respiro();
    expect(b.online(a.id)).toBe(true);

    // Si riscrive a mano l'ultimo segno di vita indietro nel tempo, oltre la
    // finestra: e' quello che succede quando un programma viene chiuso.
    b['presenze'].set(a.id, Date.now() - FINESTRA_ONLINE_MS - 1000);
    expect(b.online(a.id)).toBe(false);
    // Ma "visto" resta: e' l'informazione che ha ancora senso dare.
    expect(b.visto(a.id)).not.toBeNull();

    await a.close();
    await b.close();
  });

  it('l ultimo avvistamento sopravvive a chiusura e riapertura', async () => {
    const dirB = await cartella();
    const a = await Account.create(PASS, await cartella());
    const b = await Account.create(PASS, dirB);
    await a.addContact(b.uri, 'BOB');
    await b.addContact(a.uri, 'ALICE');

    await b.connect(new MemoryMailbox(hex(b.identity.nostrPublic)));
    await a.connect(new MemoryMailbox(hex(a.identity.nostrPublic)));
    await respiro();
    const quando = b.visto(a.id);
    expect(quando).not.toBeNull();

    await a.close();
    await b.close();

    const riaperto = await Account.open(PASS, dirB);
    expect(riaperto.visto(a.id)).toBe(quando);
    await riaperto.close();
  });

  it('un battito da uno sconosciuto non lo fa comparire da nessuna parte', async () => {
    const [a, b] = await coppia();
    const estraneo = await Account.create(PASS, await cartella());
    await estraneo.addContact(b.uri, 'BOB');

    await b.connect(new MemoryMailbox(hex(b.identity.nostrPublic)));
    await estraneo.connect(new MemoryMailbox(hex(estraneo.identity.nostrPublic)));
    await respiro();

    expect(b.online(estraneo.id)).toBe(false);
    expect(b.visto(estraneo.id)).toBeNull();
    expect(b.contacts().map((c) => c.name)).toEqual(['ALICE']);

    await a.close();
    await b.close();
    await estraneo.close();
  });
});
