// Dispositivi collegati.
//
// Qui si difendono tre cose, e la piu' importante e' la terza.
//
//   1. un dispositivo firmato dall'account viene accettato;
//   2. uno non firmato, o firmato da un altro account, viene rifiutato — o
//      chiunque potrebbe farsi passare per un tuo telefono e leggere tutto;
//   3. il numero di sicurezza CAMBIA quando l'insieme dei dispositivi cambia.
//      Senza questa, un dispositivo compromesso potrebbe aggiungere un
//      dispositivo dell'attaccante e nessuno se ne accorgerebbe mai.

import { describe, expect, it } from 'vitest';
import { createIdentity, cardOf, encodeCard } from '../src/identity.js';
import {
  creaChiaveAccount,
  firmaDispositivo,
  dispositivoValido,
  dispositiviValidi,
  improntaAccount,
  perTrasporto,
  daTrasporto,
  cardAccountToUri,
  cardAccountFromUri,
  MAX_DISPOSITIVI,
} from '../src/dispositivi.js';
import { hex } from '../src/codec.js';

function conDispositivi(quanti: number) {
  const account = creaChiaveAccount();
  const dispositivi = Array.from({ length: quanti }, (_, i) =>
    firmaDispositivo(account, cardOf(createIdentity()), `dispositivo ${i}`, 1000 + i)
  );
  return { account, dispositivi };
}

describe('dispositivi di una persona', () => {
  it('un dispositivo firmato dall account e valido', () => {
    const { account, dispositivi } = conDispositivi(1);
    expect(dispositivoValido(account.publicKey, dispositivi[0]!)).toBe(true);
  });

  it('un dispositivo firmato da un ALTRO account viene rifiutato', () => {
    const { dispositivi } = conDispositivi(1);
    const estraneo = creaChiaveAccount();
    // Stessa card, ma la firma non e' di questo account.
    expect(dispositivoValido(estraneo.publicKey, dispositivi[0]!)).toBe(false);
  });

  it('una firma inventata non passa', () => {
    const { account, dispositivi } = conDispositivi(1);
    const falso = { ...dispositivi[0]!, firma: new Uint8Array(64) };
    expect(dispositivoValido(account.publicKey, falso)).toBe(false);
  });

  it('sostituire la card lasciando la firma non passa', () => {
    const { account, dispositivi } = conDispositivi(1);
    // La firma copre la card intera: cambiarla sotto la stessa firma e'
    // esattamente cio' che si vuole impedire.
    const altra = cardOf(createIdentity());
    const falso = { ...dispositivi[0]!, card: altra, id: hex(altra.sigPublic) };
    expect(dispositivoValido(account.publicKey, falso)).toBe(false);
  });

  it('un identificativo che non corrisponde alla card non passa', () => {
    const { account, dispositivi } = conDispositivi(1);
    const falso = { ...dispositivi[0]!, id: 'a'.repeat(64) };
    expect(dispositivoValido(account.publicKey, falso)).toBe(false);
  });

  it('l elenco tiene solo i validi, senza doppioni, in ordine stabile', () => {
    const { account, dispositivi } = conDispositivi(3);
    const estraneo = firmaDispositivo(creaChiaveAccount(), cardOf(createIdentity()), 'intruso');
    const sporco = [dispositivi[2]!, estraneo, dispositivi[0]!, dispositivi[2]!, dispositivi[1]!];
    const puliti = dispositiviValidi(account.publicKey, sporco);
    expect(puliti).toHaveLength(3);
    expect(puliti.map((d) => d.id)).toEqual([...puliti.map((d) => d.id)].sort());
    // E lo stesso insieme in ordine diverso da lo stesso risultato: due
    // programmi devono arrivare alla stessa lista, o le impronte non
    // coincidono.
    expect(dispositiviValidi(account.publicKey, [...sporco].reverse()).map((d) => d.id)).toEqual(
      puliti.map((d) => d.id)
    );
  });
});

describe('impronta dell account', () => {
  it('non cambia se cambia solo l ordine', () => {
    const { account, dispositivi } = conDispositivi(3);
    const a = improntaAccount(account.publicKey, dispositivi);
    const b = improntaAccount(account.publicKey, [...dispositivi].reverse());
    expect(hex(a)).toBe(hex(b));
  });

  it('CAMBIA quando si aggiunge un dispositivo', () => {
    const { account, dispositivi } = conDispositivi(2);
    const prima = improntaAccount(account.publicKey, dispositivi);
    const dopo = improntaAccount(account.publicKey, [
      ...dispositivi,
      firmaDispositivo(account, cardOf(createIdentity()), 'telefono nuovo'),
    ]);
    // E' la difesa contro un dispositivo aggiunto di nascosto: se l'impronta
    // non cambiasse, nessuno potrebbe accorgersene.
    expect(hex(prima)).not.toBe(hex(dopo));
  });

  it('CAMBIA quando si toglie un dispositivo', () => {
    const { account, dispositivi } = conDispositivi(3);
    const prima = improntaAccount(account.publicKey, dispositivi);
    const dopo = improntaAccount(account.publicKey, dispositivi.slice(1));
    expect(hex(prima)).not.toBe(hex(dopo));
  });

  it('cambia se cambia la chiave d account, a parita di dispositivi', () => {
    const { account, dispositivi } = conDispositivi(2);
    const altro = creaChiaveAccount();
    expect(hex(improntaAccount(account.publicKey, dispositivi))).not.toBe(
      hex(improntaAccount(altro.publicKey, dispositivi))
    );
  });
});

describe('come viaggia', () => {
  it('giro completo: parte, arriva, e resta valido', () => {
    const { account, dispositivi } = conDispositivi(1);
    const tornato = daTrasporto(perTrasporto(dispositivi[0]!));
    expect(tornato.id).toBe(dispositivi[0]!.id);
    expect(tornato.nome).toBe(dispositivi[0]!.nome);
    expect(hex(encodeCard(tornato.card))).toBe(hex(encodeCard(dispositivi[0]!.card)));
    expect(dispositivoValido(account.publicKey, tornato)).toBe(true);
  });

  it('cio che arriva malformato non diventa un dispositivo', () => {
    const { dispositivi } = conDispositivi(1);
    const buono = perTrasporto(dispositivi[0]!);
    for (const rotto of [
      { ...buono, card: 'zz' },
      { ...buono, card: buono.card.slice(0, 10) },
      { ...buono, firma: '00' },
      { ...buono, card: buono.card.toUpperCase() },
    ]) {
      expect(() => daTrasporto(rotto)).toThrow();
    }
  });

  it('un nome lunghissimo viene accorciato invece di passare intero', () => {
    const { account } = conDispositivi(0);
    const d = firmaDispositivo(account, cardOf(createIdentity()), 'x'.repeat(500));
    expect(d.nome.length).toBe(60);
  });
});

describe('card di un account', () => {
  it('giro completo: la card torna con gli stessi dispositivi', () => {
    const { account, dispositivi } = conDispositivi(2);
    const tornata = cardAccountFromUri(cardAccountToUri({ account: account.publicKey, dispositivi }));
    expect(hex(tornata.account)).toBe(hex(account.publicKey));
    expect(tornata.dispositivi.map((d) => d.id).sort()).toEqual(dispositivi.map((d) => d.id).sort());
  });

  it('un dispositivo estraneo infilato nella card viene scartato, il resto resta', () => {
    const { account, dispositivi } = conDispositivi(2);
    const intruso = firmaDispositivo(creaChiaveAccount(), cardOf(createIdentity()), 'non mio');
    // Chi manda la card decide cosa scriverci: qui si verifica ogni firma.
    const uri = cardAccountToUri({ account: account.publicKey, dispositivi: [...dispositivi, intruso] });
    const tornata = cardAccountFromUri(uri);
    expect(tornata.dispositivi).toHaveLength(2);
    expect(tornata.dispositivi.some((d) => d.id === intruso.id)).toBe(false);
  });

  it('una card senza nemmeno un dispositivo valido non e una card', () => {
    const { dispositivi } = conDispositivi(1);
    const altro = creaChiaveAccount();
    // Chiave d'account cambiata: nessuna firma torna piu'.
    const uri = cardAccountToUri({ account: altro.publicKey, dispositivi });
    expect(() => cardAccountFromUri(uri)).toThrow(/nessun dispositivo/);
  });

  it('un URI storpiato non passa', () => {
    const { account, dispositivi } = conDispositivi(1);
    const buono = cardAccountToUri({ account: account.publicKey, dispositivi });
    for (const cattivo of ['wire:1:abc', 'wire:2:', buono.slice(0, -6), 'niente', buono.replace('wire:2:', '')]) {
      expect(() => cardAccountFromUri(cattivo)).toThrow();
    }
  });

  it('un elenco di dispositivi assurdamente lungo viene rifiutato', () => {
    const { account } = conDispositivi(0);
    const tanti = Array.from({ length: MAX_DISPOSITIVI + 1 }, (_, i) =>
      firmaDispositivo(account, cardOf(createIdentity()), `d${i}`)
    );
    const uri = cardAccountToUri({ account: account.publicKey, dispositivi: tanti });
    expect(() => cardAccountFromUri(uri)).toThrow(/elenco dispositivi/);
  });
});
