// Il server TURN: cosa si accetta e cosa no, e che sopravviva alla riapertura.
//
// Il controllo e' nel cuore perche' la pagina si puo' aggirare, e perche' un
// indirizzo sbagliato dentro Chromium non fallisce in modo visibile: la
// connessione parte senza quel server e la diagnosi finale non lo nomina.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Account } from '../src/account.js';
import { MemoryMailbox } from '../src/mailbox.js';
import { etichettaTurn, validaTurn } from '../src/turn.js';
import { createIdentity } from '../src/identity.js';
import { openVault, sealVault, type Vault } from '../src/keystore.js';

const PASS = 'passphrase-di-prova';
const dirs: string[] = [];
async function cartella(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'wire-turn-'));
  dirs.push(d);
  return d;
}
beforeEach(() => MemoryMailbox.reset());
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe('cosa si accetta come server TURN', () => {
  it('turn e turns, con porta e con transport', () => {
    expect(validaTurn({ url: ' turn:relay.esempio.it:3478 ', utente: 'a', password: 'b' }).url).toBe(
      'turn:relay.esempio.it:3478'
    );
    expect(validaTurn({ url: 'turns:relay.esempio.it:443?transport=tcp', utente: 'a', password: 'b' }).url).toBe(
      'turns:relay.esempio.it:443?transport=tcp'
    );
    expect(validaTurn({ url: 'turn:10.0.0.5', utente: 'a', password: 'b' }).url).toBe('turn:10.0.0.5');
  });

  it('rifiuta cio che Chromium accetterebbe in silenzio o rifiuterebbe tardi', () => {
    expect(() => validaTurn({ url: '', utente: 'a', password: 'b' })).toThrow(/manca l indirizzo/);
    expect(() => validaTurn({ url: 'stun:x.it', utente: 'a', password: 'b' })).toThrow(/non valido/);
    expect(() => validaTurn({ url: 'https://x.it', utente: 'a', password: 'b' })).toThrow(/non valido/);
    expect(() => validaTurn({ url: 'turn:x.it:99999', utente: 'a', password: 'b' })).toThrow(/porta/);
    expect(() => validaTurn({ url: 'turn:x.it?transport=sctp', utente: 'a', password: 'b' })).toThrow(/non valido/);
    expect(() => validaTurn({ url: 'turn:x.it', utente: '', password: 'b' })).toThrow(/utente/);
    expect(() => validaTurn({ url: 'turn:x.it', utente: 'a', password: '' })).toThrow(/password/);
    expect(() => validaTurn({ url: 'turn:' + 'a'.repeat(300), utente: 'a', password: 'b' })).toThrow(/lungo/);
  });

  it('l etichetta non mostra le credenziali', () => {
    const t = validaTurn({ url: 'turns:relay.esempio.it:443?transport=tcp', utente: 'segreto', password: 'piu' });
    expect(etichettaTurn(t)).toBe('relay.esempio.it:443');
    expect(etichettaTurn(t)).not.toMatch(/segreto|piu/);
  });
});

describe('il server TURN nel deposito', () => {
  it('un deposito scritto prima si apre senza server', () => {
    const vecchio = { identity: createIdentity(), sessions: {}, contacts: {} } as unknown as Vault;
    const aperto = openVault(sealVault(vecchio, 'passphrase-lunga'), 'passphrase-lunga');
    expect(aperto.rete).toEqual({ turn: null });
  });

  it('sopravvive alla riapertura, e si toglie', async () => {
    const dir = await cartella();
    const a = await Account.create(PASS, dir);
    expect(a.turn()).toBeNull();
    await a.impostaTurn({ url: 'turn:relay.esempio.it:3478', utente: 'u', password: 'p' });
    await a.close();

    const b = await Account.open(PASS, dir);
    expect(b.turn()).toEqual({ url: 'turn:relay.esempio.it:3478', utente: 'u', password: 'p' });
    await b.impostaTurn(null);
    await b.close();

    const c = await Account.open(PASS, dir);
    expect(c.turn()).toBeNull();
    await c.close();
  });

  it('un valore sbagliato non arriva nel deposito', async () => {
    const dir = await cartella();
    const a = await Account.create(PASS, dir);
    await expect(a.impostaTurn({ url: 'http://no', utente: 'u', password: 'p' })).rejects.toThrow(/non valido/);
    expect(a.turn()).toBeNull();
    await a.close();
  });
});
