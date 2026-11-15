import { describe, expect, it } from 'vitest';
import { createIdentity } from '../src/identity.js';
import { MIN_PASSPHRASE, openVault, sealVault, type Vault } from '../src/keystore.js';

function deposito(): Vault {
  return { identity: createIdentity(), sessions: { abc: ['{"v":1}'] }, contacts: {} };
}

describe('deposito chiavi', () => {
  it('giro completo con la passphrase giusta', () => {
    const v = deposito();
    const aperto = openVault(sealVault(v, 'passphrase-lunga'), 'passphrase-lunga');
    expect(Buffer.from(aperto.identity.sigSecret).equals(Buffer.from(v.identity.sigSecret))).toBe(true);
    expect(aperto.identity.createdAt).toBe(v.identity.createdAt);
    expect(aperto.sessions['abc']).toEqual(['{"v":1}']);
  });

  it('i depositi vecchi, con una sessione sola per contatto, si leggono ancora', () => {
    // Fino alla 0.1.6 si teneva UNA sessione per contatto, salvata come
    // stringa. Tenerne una sola era il difetto che rendeva muta una
    // conversazione quando due persone si scrivevano nello stesso momento;
    // ora sono un elenco. Chi aggiorna non deve perdere quella che aveva.
    const vecchio = { ...deposito(), sessions: { abc: '{"v":1}' } as unknown as Vault['sessions'] };
    const aperto = openVault(sealVault(vecchio, 'passphrase-lunga'), 'passphrase-lunga');
    expect(aperto.sessions['abc']).toEqual(['{"v":1}']);
  });

  it('passphrase sbagliata: niente', () => {
    const sigillato = sealVault(deposito(), 'quella-giusta');
    expect(() => openVault(sigillato, 'quella-sbagliata')).toThrow(/passphrase errata o file danneggiato/);
  });

  it('lo stesso deposito sigillato due volte da byte diversi', () => {
    const v = deposito();
    const uno = sealVault(v, 'passphrase-lunga');
    const due = sealVault(v, 'passphrase-lunga');
    expect(Buffer.from(uno).equals(Buffer.from(due))).toBe(false);
  });

  it('il file non contiene la chiave privata in chiaro', () => {
    const v = deposito();
    const sigillato = Buffer.from(sealVault(v, 'passphrase-lunga'));
    expect(sigillato.includes(Buffer.from(v.identity.sigSecret))).toBe(false);
    expect(sigillato.includes(Buffer.from(v.identity.dhSecret))).toBe(false);
  });

  it('manomettere il salt rompe il tag invece di derivare altro', () => {
    const sigillato = sealVault(deposito(), 'passphrase-lunga');
    sigillato[10] ^= 1; // dentro il salt, che e' dato autenticato
    expect(() => openVault(sigillato, 'passphrase-lunga')).toThrow();
  });

  it('manomettere il testo cifrato viene rilevato', () => {
    const sigillato = sealVault(deposito(), 'passphrase-lunga');
    sigillato[sigillato.length - 1] ^= 1;
    expect(() => openVault(sigillato, 'passphrase-lunga')).toThrow();
  });

  it('rifiuta file non nostri, troncati, o di versione ignota', () => {
    expect(() => openVault(new Uint8Array(80), 'passphrase-lunga')).toThrow(/deposito THE WIRE/);
    expect(() => openVault(new Uint8Array(4), 'passphrase-lunga')).toThrow(/troncato/);

    const sigillato = sealVault(deposito(), 'passphrase-lunga');
    sigillato[6] = 9; // byte della versione
    expect(() => openVault(sigillato, 'passphrase-lunga')).toThrow(/versione/);
  });

  it('rifiuta passphrase troppo corte', () => {
    expect(() => sealVault(deposito(), 'corta')).toThrow(/troppo corta/);
    // Undici caratteri: il limite e' dodici, e va provato al confine — sotto
    // deve fallire, esattamente sopra deve passare.
    expect(() => sealVault(deposito(), 'x'.repeat(MIN_PASSPHRASE - 1))).toThrow(/troppo corta/);
    expect(() => sealVault(deposito(), 'x'.repeat(MIN_PASSPHRASE))).not.toThrow();
  });
});
