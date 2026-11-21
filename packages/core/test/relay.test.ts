// I relay: lista personale, relay nella voce del dispositivo, riserva.
//
// Tre cose da difendere. La prima: una lista scritta a mano si valida nel
// cuore, non nella pagina. La seconda: i relay di un dispositivo viaggiano
// FIRMATI, e chi li cambia per strada non passa — mentre le voci della 0.1.1,
// senza relay, devono continuare a valere. La terza: cambiare i propri relay
// non deve far perdere la verifica a voce ai contatti, perche' il numero di
// sicurezza copre le chiavi e non gli indirizzi.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Account } from '../src/account.js';
import { MemoryMailbox } from '../src/mailbox.js';
import { hex } from '../src/codec.js';
import { DEFAULT_RELAYS } from '../src/mailbox-nostr.js';
import { MAX_RELAY, RELAY_RISERVA, normalizzaRelay, relayDaTesto, relayPerInvio, validaRelay } from '../src/relay.js';
import { cardOf, createIdentity } from '../src/identity.js';
import { creaChiaveAccount, daTrasporto, dispositivoValido, firmaDispositivo, perTrasporto } from '../src/dispositivi.js';

const PASS = 'passphrase-di-prova';
const dirs: string[] = [];
async function cartella(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'wire-relay-'));
  dirs.push(d);
  return d;
}
beforeEach(() => MemoryMailbox.reset());
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe('cosa si accetta come relay', () => {
  it('wss, con o senza schema, porta e percorso; la barra finale si toglie', () => {
    expect(validaRelay(' wss://relay.esempio.it ')).toBe('wss://relay.esempio.it');
    expect(validaRelay('relay.esempio.it')).toBe('wss://relay.esempio.it');
    expect(validaRelay('wss://relay.esempio.it:7777/nostr/')).toBe('wss://relay.esempio.it:7777/nostr');
  });

  it('rifiuta ws in chiaro, credenziali, porte assurde e vuoto', () => {
    expect(() => validaRelay('ws://relay.esempio.it')).toThrow(/wss/);
    expect(() => validaRelay('wss://utente:pass@relay.esempio.it')).toThrow();
    expect(() => validaRelay('wss://relay.esempio.it:70000')).toThrow(/porta/);
    expect(() => validaRelay('')).toThrow(/vuoto/);
    expect(() => validaRelay('https://relay.esempio.it')).toThrow();
  });

  it('una lista: senza doppioni, mai vuota, nel tetto', () => {
    expect(normalizzaRelay(['wss://a.it', 'a.it', 'wss://b.it/'])).toEqual(['wss://a.it', 'wss://b.it']);
    expect(() => normalizzaRelay([])).toThrow(/almeno un relay/);
    expect(() => normalizzaRelay(Array.from({ length: MAX_RELAY + 1 }, (_, i) => `wss://r${i}.it`))).toThrow(/massimo/);
    expect(relayDaTesto('wss://a.it\nb.it, c.it;  wss://a.it')).toEqual(['wss://a.it', 'wss://b.it', 'wss://c.it']);
  });

  it('la riserva non ripete i predefiniti', () => {
    for (const r of RELAY_RISERVA) expect(DEFAULT_RELAYS as readonly string[]).not.toContain(r);
  });
});

describe('su quali relay si pubblica per un dispositivo', () => {
  it('prima i suoi, poi i propri, senza doppioni', () => {
    expect(relayPerInvio(['wss://m1', 'wss://m2'], ['wss://s1', 'wss://m2'])).toEqual(['wss://s1', 'wss://m2', 'wss://m1']);
  });

  it('senza relay dichiarati si usano i propri', () => {
    expect(relayPerInvio(['wss://m1'], undefined)).toEqual(['wss://m1']);
  });

  it('il tetto taglia i propri, mai i suoi', () => {
    const suoi = Array.from({ length: MAX_RELAY }, (_, i) => `wss://s${i}`);
    const miei = Array.from({ length: 5 }, (_, i) => `wss://m${i}`);
    expect(relayPerInvio(miei, suoi)).toEqual(suoi);
  });
});

describe('i relay nella voce del dispositivo', () => {
  it('una voce con relay e firmata e verificabile; cambiarli per strada non passa', () => {
    const account = creaChiaveAccount();
    const voce = firmaDispositivo(account, cardOf(createIdentity()), 'pc', 1000, ['wss://a.it', 'wss://b.it']);
    expect(dispositivoValido(account.publicKey, voce)).toBe(true);
    expect(dispositivoValido(account.publicKey, { ...voce, relay: ['wss://a.it', 'wss://altro.it'] })).toBe(false);
    expect(dispositivoValido(account.publicKey, { ...voce, relay: ['wss://b.it', 'wss://a.it'] }), 'nemmeno riordinati').toBe(false);
    // Togliere i relay cambia la forma firmata: la firma della seconda forma
    // non vale per la prima.
    const { relay: _r, ...senza } = voce;
    expect(dispositivoValido(account.publicKey, senza)).toBe(false);
  });

  it('una voce della 0.1.1, senza relay, vale ancora', () => {
    const account = creaChiaveAccount();
    const voce = firmaDispositivo(account, cardOf(createIdentity()), 'pc', 1000);
    expect(voce.relay).toBeUndefined();
    expect(dispositivoValido(account.publicKey, voce)).toBe(true);
    expect(dispositivoValido(account.publicKey, daTrasporto(perTrasporto(voce)))).toBe(true);
  });

  it('i relay sopravvivono al trasporto', () => {
    const account = creaChiaveAccount();
    const voce = firmaDispositivo(account, cardOf(createIdentity()), 'pc', 1000, ['wss://a.it']);
    const tornata = daTrasporto(perTrasporto(voce));
    expect(tornata.relay).toEqual(['wss://a.it']);
    expect(dispositivoValido(account.publicKey, tornata)).toBe(true);
  });

  it('una lista malformata nella voce la rende non valida', () => {
    const account = creaChiaveAccount();
    const voce = firmaDispositivo(account, cardOf(createIdentity()), 'pc', 1000, ['wss://a.it']);
    expect(dispositivoValido(account.publicKey, { ...voce, relay: ['ws://a.it'] })).toBe(false);
    expect(dispositivoValido(account.publicKey, { ...voce, relay: [] })).toBe(false);
  });
});

async function coppia() {
  const a = await Account.create(PASS, await cartella());
  const b = await Account.create(PASS, await cartella());
  await a.addContact(b.uri, 'BOB');
  await b.addContact(a.uri, 'ALICE');
  await a.connect(new MemoryMailbox(hex(a.identity.nostrPublic)), { live: false });
  await b.connect(new MemoryMailbox(hex(b.identity.nostrPublic)), { live: false });
  return { a, b };
}

describe('la lista personale di un account', () => {
  it('nasce sui predefiniti, si cambia, si rilegge dal deposito, torna ai predefiniti', async () => {
    const dir = await cartella();
    const a = await Account.create(PASS, dir);
    expect(a.relay()).toEqual({ elenco: [...DEFAULT_RELAYS], personali: false });

    await a.impostaRelay(['wss://mio.esempio.it', 'wss://nos.lol']);
    expect(a.relay()).toEqual({ elenco: ['wss://mio.esempio.it', 'wss://nos.lol'], personali: true });
    // La propria voce porta i relay, firmati.
    const mia = a.dispositivi.find((d) => d.id === a.idDispositivo)!;
    expect(mia.relay).toEqual(['wss://mio.esempio.it', 'wss://nos.lol']);
    await a.close();

    const riaperto = await Account.open(PASS, dir);
    expect(riaperto.relay().elenco).toEqual(['wss://mio.esempio.it', 'wss://nos.lol']);
    expect(riaperto.dispositivi.find((d) => d.id === riaperto.idDispositivo)!.relay).toEqual([
      'wss://mio.esempio.it',
      'wss://nos.lol',
    ]);

    await riaperto.impostaRelay(null);
    expect(riaperto.relay().personali).toBe(false);
    expect(riaperto.dispositivi.find((d) => d.id === riaperto.idDispositivo)!.relay).toBeUndefined();
    await riaperto.close();
  });

  it('scrivere a mano i predefiniti e come non scrivere niente', async () => {
    const a = await Account.create(PASS, await cartella());
    await a.impostaRelay([...DEFAULT_RELAYS]);
    expect(a.relay().personali).toBe(false);
    expect(a.dispositivi.find((d) => d.id === a.idDispositivo)!.relay).toBeUndefined();
    await a.close();
  });

  it('una lista sbagliata non entra nel deposito', async () => {
    const a = await Account.create(PASS, await cartella());
    await expect(a.impostaRelay(['ws://chiaro.it'])).rejects.toThrow(/wss/);
    expect(a.relay().personali).toBe(false);
    await a.close();
  });
});

describe('i relay arrivano ai contatti', () => {
  it('BOB cambia relay: ALICE li vede, pubblica li, e la verifica resta', async () => {
    const { a, b } = await coppia();
    await a.markVerified(a.contact('BOB')!.id);
    const numero = a.safetyNumberWith(a.contact('BOB')!);

    await b.impostaRelay(['wss://relay-di-bob.it']);
    await a.sync();

    const bob = a.contact('BOB')!;
    expect(bob.dispositivi[0]!.relay).toEqual(['wss://relay-di-bob.it']);
    expect(bob.verifiedAt, 'i relay non entrano nel numero di sicurezza').not.toBeNull();
    expect(a.safetyNumberWith(bob)).toBe(numero);

    // Da qui ALICE pubblica dove BOB ascolta.
    await a.sendText(bob, 'ciao');
    expect(MemoryMailbox.ultimiRelay.get(hex(b.identity.nostrPublic))).toEqual(['wss://relay-di-bob.it']);

    // E BOB legge comunque: il trasporto in memoria non filtra per relay, ma
    // il messaggio deve essere arrivato intero.
    const arrivati = await b.sync();
    expect(arrivati.map((m) => m.text)).toContain('ciao');

    await a.close();
    await b.close();
  });

  it('senza relay dichiarati si pubblica sui propri', async () => {
    const { a, b } = await coppia();
    await a.sendText(a.contact('BOB')!, 'ciao');
    expect(MemoryMailbox.ultimiRelay.get(hex(b.identity.nostrPublic))).toBeNull();
    await a.close();
    await b.close();
  });

  it('un relay cambiato per strada nella voce di BOB non viene accettato', async () => {
    const { a, b } = await coppia();
    await b.impostaRelay(['wss://relay-di-bob.it']);
    await a.sync();
    const bob = a.contact('BOB')!;
    const manomesso = { ...bob.dispositivi[0]!, relay: ['wss://del-nemico.it'] };
    expect(dispositivoValido(bob.account, manomesso)).toBe(false);
    await a.close();
    await b.close();
  });
});
