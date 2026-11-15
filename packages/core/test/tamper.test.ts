// Ogni byte che viaggia deve essere autenticato. Questo test gira un bit alla
// volta su tutta la busta e pretende che nessuna posizione passi inosservata.

import { describe, expect, it } from 'vitest';
import { cardOf, createIdentity } from '../src/identity.js';
import { Session } from '../src/session.js';

function apri() {
  const alice = createIdentity();
  const bob = createIdentity();
  const a = Session.start(alice, cardOf(bob));
  const { session: b } = Session.accept(bob, a.encryptText('apertura'));
  return { a, b, alice, bob };
}

describe('manomissione', () => {
  it('nessun byte della busta si puo cambiare senza che venga rilevato', () => {
    const { a, b } = apri();
    const originale = a.encryptText('messaggio da proteggere');

    const passati: number[] = [];
    for (let i = 0; i < originale.length; i++) {
      const guasta = Uint8Array.from(originale);
      guasta[i]! ^= 0x01;
      // Ogni tentativo parte da una copia pulita dello stato: un fallimento non
      // deve poter far passare quello dopo.
      const vittima = Session.restore(b.serialize());
      try {
        vittima.decryptText(guasta);
        passati.push(i);
      } catch {
        /* rilevato, come deve essere */
      }
    }

    expect(passati, `byte modificabili senza rilevamento: ${passati.join(', ')}`).toEqual([]);
  });

  it('nessun byte si puo cambiare nemmeno nella busta che apre la sessione', () => {
    const alice = createIdentity();
    const bob = createIdentity();
    const primo = Session.start(alice, cardOf(bob)).encryptText('apertura');

    const passati: number[] = [];
    for (let i = 0; i < primo.length; i++) {
      const guasta = Uint8Array.from(primo);
      guasta[i]! ^= 0x01;
      try {
        Session.accept(bob, guasta);
        passati.push(i);
      } catch {
        /* rilevato */
      }
    }

    expect(passati, `byte modificabili senza rilevamento: ${passati.join(', ')}`).toEqual([]);
  });

  it('una busta di Alice non si apre nella sessione di Carla', () => {
    const { a } = apri();
    const carla = createIdentity();
    const dario = createIdentity();
    const sessioneAltrui = Session.start(carla, cardOf(dario));
    expect(() => sessioneAltrui.decryptText(a.encryptText('non per te'))).toThrow();
  });
});
