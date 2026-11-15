// Due dispositivi, una persona.
//
// E' il test che giustifica tutto il lavoro: Alice ha un computer e un
// telefono, Bob le scrive, e il messaggio deve arrivare su ENTRAMBI. E quello
// che Alice scrive dal telefono deve comparire anche sul computer.
//
// Si prova tutto qui, senza telefono: un "secondo dispositivo" e' solo una
// seconda cartella di dati. Il codice che gira e' lo stesso che girera' nel
// browser.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Account } from '../src/account.js';
import { MemoryMailbox } from '../src/mailbox.js';
import { codiceFromUri } from '../src/collegamento.js';
import { hex } from '../src/codec.js';

const PASS = 'passphrase-di-prova';
const dirs: string[] = [];

async function cartella(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'wire-coll-'));
  dirs.push(d);
  return d;
}

// Sulle macchine di GitHub (due core, Argon2id a 64 MB) la stessa pausa non
// basta: il tempo si allunga solo li', in locale resta quello che e'.
const respiro = () => new Promise((r) => setTimeout(r, process.env['CI'] ? 1800 : 150));

beforeEach(() => MemoryMailbox.reset());
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

/** Un account collegato alla mailbox, in ascolto. */
async function acceso(dir?: string): Promise<Account> {
  const a = await Account.create(PASS, dir ?? (await cartella()));
  await a.connect(new MemoryMailbox(hex(a.identity.nostrPublic)));
  return a;
}

describe('collegare un secondo dispositivo', () => {
  it('il codice porta la chiave d account e scade', async () => {
    const a = await acceso();
    const codice = a.codiceCollegamento();
    const letto = codiceFromUri(codice);
    expect(hex(letto.accountSecret).length).toBe(64);
    // Il codice porta la card del dispositivo che invita, per potergli
    // rispondere: senza, il nuovo non saprebbe a chi presentarsi.
    expect(hex(letto.card.sigPublic)).toBe(hex(a.identity.sigPublic));
    expect(() => codiceFromUri(codice, Date.now() + 10 * 60 * 1000)).toThrow(/scaduto/);
    await a.close();
  });

  it('dopo il collegamento i due dispositivi appartengono allo stesso account', async () => {
    const pc = await acceso();
    const telefono = await acceso();
    expect(telefono.id).not.toBe(pc.id);

    await telefono.collegatiCome(pc.codiceCollegamento());
    await respiro();

    // Stessa persona, due dispositivi.
    expect(telefono.id).toBe(pc.id);
    expect(pc.dispositivi).toHaveLength(2);
    expect(telefono.dispositivi).toHaveLength(2);
    expect(pc.dispositivi.map((d) => d.id).sort()).toEqual(telefono.dispositivi.map((d) => d.id).sort());

    await pc.close();
    await telefono.close();
  });

  it('un messaggio di Bob arriva su TUTTI i dispositivi di Alice', async () => {
    const pc = await acceso();
    const telefono = await acceso();
    const bob = await acceso();

    await telefono.collegatiCome(pc.codiceCollegamento());
    await respiro();

    // Bob conosce Alice dopo che ha due dispositivi, quindi la sua card li
    // porta entrambi.
    await bob.addContact(pc.uri, 'ALICE');
    await pc.addContact(bob.uri, 'BOB');
    await respiro();

    await bob.sendText(bob.contact('ALICE')!, 'ciao a tutti e due');
    await respiro();

    const suPc = (await pc.historyWith(pc.contact('BOB')!)).filter((m) => !m.mine).map((m) => m.text);
    const suTelefono = (await telefono.historyWith(telefono.contact('BOB')!)).filter((m) => !m.mine).map((m) => m.text);
    // E' la proprieta' per cui esiste tutto questo lavoro.
    expect(suPc).toContain('ciao a tutti e due');
    expect(suTelefono).toContain('ciao a tutti e due');

    await pc.close();
    await telefono.close();
    await bob.close();
  });

  it('cio che Alice scrive dal telefono compare anche sul computer', async () => {
    const pc = await acceso();
    const telefono = await acceso();
    const bob = await acceso();

    await telefono.collegatiCome(pc.codiceCollegamento());
    await respiro();
    await bob.addContact(pc.uri, 'ALICE');
    await pc.addContact(bob.uri, 'BOB');
    await respiro();

    await telefono.sendText(telefono.contact('BOB')!, 'scritto dal telefono');
    await respiro();

    // Su Bob, perche' e' il destinatario.
    expect((await bob.historyWith(bob.contact('ALICE')!)).map((m) => m.text)).toContain('scritto dal telefono');
    // E sul computer di Alice, che deve vedere cio' che ha scritto lei stessa
    // dall'altro dispositivo: senza questo, le due conversazioni divergono.
    expect((await pc.historyWith(pc.contact('BOB')!)).map((m) => m.text)).toContain('scritto dal telefono');

    await pc.close();
    await telefono.close();
    await bob.close();
  });

  it('il numero di sicurezza CAMBIA quando Alice collega un telefono', async () => {
    const pc = await acceso();
    const bob = await acceso();
    await bob.addContact(pc.uri, 'ALICE');
    await pc.addContact(bob.uri, 'BOB');
    await respiro();
    const prima = bob.safetyNumberWith(bob.contact('ALICE')!);

    const telefono = await acceso();
    await telefono.collegatiCome(pc.codiceCollegamento());
    await respiro();

    const dopo = bob.safetyNumberWith(bob.contact('ALICE')!);
    // Bob deve poter vedere che qualcosa e' cambiato: e' l'unica difesa contro
    // un dispositivo aggiunto da qualcun altro.
    expect(dopo).not.toBe(prima);
    expect(dopo.replace(/\s/g, '')).toHaveLength(60);

    await pc.close();
    await telefono.close();
    await bob.close();
  });

  it('un dispositivo firmato da un account estraneo non entra', async () => {
    const pc = await acceso();
    const estraneo = await acceso();
    // L'estraneo prova a farsi accettare senza avere il codice: la sua voce e'
    // firmata dalla PROPRIA chiave d'account, non da quella di Alice.
    const suaVoce = estraneo.dispositivi[0]!;
    const accettato = await pc['accettaDispositivo'](
      (await import('../src/dispositivi.js')).perTrasporto(suaVoce)
    );
    expect(accettato).toBe(false);
    expect(pc.dispositivi).toHaveLength(1);
    await pc.close();
    await estraneo.close();
  });

  it('un dispositivo con una rubrica gia sua non si collega', async () => {
    const pc = await acceso();
    const altro = await acceso();
    const terzo = await acceso();
    await altro.addContact(terzo.uri, 'QUALCUNO');
    // Collegare un dispositivo che ha gia' una vita sua vorrebbe dire buttarla
    // via in silenzio.
    await expect(altro.collegatiCome(pc.codiceCollegamento())).rejects.toThrow(/gia una rubrica/);
    await pc.close();
    await altro.close();
    await terzo.close();
  });
});
