// Il ratchet sotto stress: consegne a caso, buste rotte, stato che non si corrompe.
//
// Il Double Ratchet di questo programma non ha avuto una revisione esterna, e
// il README lo dice. Quello che si puo' fare da qui e' togliergli di sotto le
// cose che una macchina a stati sbaglia di solito: ordine di arrivo, perdite,
// doppioni, un messaggio manomesso nel mezzo, lo stato salvato e ricaricato a
// meta'. I casi sono generati da un numero di partenza fisso, cosi' un
// fallimento si rifa' identico.
//
// Due difetti trovati scrivendo questi test, e corretti in `ratchet.ts`:
// la decifratura avanzava lo stato PRIMA di controllare il tag (una busta
// manomessa rendeva muta la sessione), e le chiavi saltate si accumulavano
// senza tetto complessivo.

import { describe, expect, it } from 'vitest';
import { Session } from '../src/session.js';
import { MAX_SKIP, MAX_SKIPPED_TOTAL, deserializeState, serializeState } from '../src/ratchet.js';
import { cardOf, createIdentity } from '../src/identity.js';

/** Generatore deterministico (xorshift32): stessi numeri a ogni giro. */
function caso(seme: number) {
  let s = seme >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x1_0000_0000;
  };
}

function coppia() {
  const alice = createIdentity();
  const bob = createIdentity();
  const a = Session.start(alice, cardOf(bob));
  const { session: b, plaintext } = Session.accept(bob, a.encryptText('apertura'));
  expect(new TextDecoder().decode(plaintext)).toBe('apertura');
  return { a, b };
}

interface InViaggio {
  da: 'a' | 'b';
  testo: string;
  busta: Uint8Array;
}

describe('consegne a caso', () => {
  for (const seme of [1, 7, 42, 2026]) {
    it(`300 messaggi, mittente a caso, ritardi, perdite e doppioni (seme ${seme})`, () => {
      const r = caso(seme);
      let { a, b } = coppia();
      const inVolo: InViaggio[] = [];
      const attesi = { a: new Set<string>(), b: new Set<string>() };
      const ricevuti = { a: new Set<string>(), b: new Set<string>() };
      let persi = 0;
      let doppi = 0;

      const consegna = (m: InViaggio) => {
        const dest = m.da === 'a' ? b : a;
        const lato = m.da === 'a' ? 'b' : 'a';
        const prima = dest.serialize();
        if (ricevuti[lato].has(m.testo)) {
          // Un doppione: deve essere rifiutato E non cambiare niente.
          expect(() => dest.decrypt(m.busta)).toThrow();
          expect(dest.serialize()).toBe(prima);
          doppi++;
          return;
        }
        expect(dest.decryptText(m.busta)).toBe(m.testo);
        ricevuti[lato].add(m.testo);
      };

      for (let i = 0; i < 300; i++) {
        const da = r() < 0.5 ? 'a' : 'b';
        const testo = `${da}#${i}`;
        const busta = (da === 'a' ? a : b).encryptText(testo);
        // Il 3% si perde per strada, ma mai piu' di quanto il ratchet regga.
        if (r() < 0.03 && persi < MAX_SKIP / 4) {
          persi++;
          continue;
        }
        attesi[da === 'a' ? 'b' : 'a'].add(testo);
        inVolo.push({ da, testo, busta });
        // Il 10% delle volte una busta gia' consegnata torna indietro.
        if (r() < 0.1 && inVolo.length > 1) inVolo.push(inVolo[Math.floor(r() * inVolo.length)]!);
        // Si consegna in ordine a caso, tenendone in volo fino a venti.
        while (inVolo.length > 20 || (inVolo.length && r() < 0.6)) {
          const k = Math.floor(r() * inVolo.length);
          consegna(inVolo.splice(k, 1)[0]!);
        }
        // Ogni tanto si salva e si ricarica, come dopo un riavvio.
        if (r() < 0.05) {
          a = Session.restore(a.serialize());
          b = Session.restore(b.serialize());
        }
      }
      while (inVolo.length) consegna(inVolo.pop()!);

      expect(ricevuti.a).toEqual(attesi.a);
      expect(ricevuti.b).toEqual(attesi.b);
      expect(doppi).toBeGreaterThan(0);
      // E dopo tutto questo si continua a parlare.
      expect(b.decryptText(a.encryptText('ancora qui'))).toBe('ancora qui');
      expect(a.decryptText(b.encryptText('anche io'))).toBe('anche io');
    });
  }
});

describe('una busta rotta non rompe la sessione', () => {
  it('manomessa nel mezzo: fallisce lei, non quello che viene dopo', () => {
    const { a, b } = coppia();
    expect(b.decryptText(a.encryptText('uno'))).toBe('uno');
    const rotta = Uint8Array.from(a.encryptText('due'));
    rotta[rotta.length - 3]! ^= 0x40;
    const prima = b.serialize();
    expect(() => b.decrypt(rotta)).toThrow();
    // Lo stato e' quello di prima, byte per byte.
    expect(b.serialize()).toBe(prima);
    expect(b.decryptText(a.encryptText('tre'))).toBe('tre');
    expect(a.decryptText(b.encryptText('risposta'))).toBe('risposta');
  });

  it('manomessa a cavallo di un giro di DH', () => {
    // Il caso peggiore: la busta rotta e' la prima della catena nuova, quella
    // che farebbe fare il giro di DH. Senza atomicita' il giro restava fatto.
    const { a, b } = coppia();
    expect(a.decryptText(b.encryptText('b1'))).toBe('b1');
    const rotta = Uint8Array.from(a.encryptText('a1 nuova catena'));
    rotta[rotta.length - 1]! ^= 0x01;
    const prima = b.serialize();
    expect(() => b.decrypt(rotta)).toThrow();
    expect(b.serialize()).toBe(prima);
    expect(b.decryptText(a.encryptText('a2'))).toBe('a2');
  });

  it('byte a caso al posto della busta: mai niente di diverso da un errore, e lo stato resta', () => {
    const r = caso(99);
    const { a, b } = coppia();
    expect(b.decryptText(a.encryptText('vera'))).toBe('vera');
    const prima = b.serialize();
    for (let i = 0; i < 200; i++) {
      const lunghezza = 1 + Math.floor(r() * 400);
      const spazzatura = new Uint8Array(lunghezza);
      for (let j = 0; j < lunghezza; j++) spazzatura[j] = Math.floor(r() * 256);
      let errore: unknown = null;
      try {
        b.decrypt(spazzatura);
      } catch (e) {
        errore = e;
      }
      expect(errore).toBeInstanceOf(Error);
    }
    expect(b.serialize()).toBe(prima);
    expect(b.decryptText(a.encryptText('ancora vera'))).toBe('ancora vera');
  });

  it('una busta vera con l intestazione presa da un altra: fallisce senza lasciare tracce', () => {
    const { a, b } = coppia();
    // Prima una risposta: cosi' le buste non portano piu' il blocco X3DH, e le
    // prime decine di byte sono l'intestazione del ratchet, che cambia a ogni messaggio.
    expect(a.decryptText(b.encryptText('r'))).toBe('r');
    const una = a.encryptText('una');
    const altra = a.encryptText('altra');
    // Le prime parti della busta (sigla, tipo, intestazione del ratchet) si
    // scambiano fra le due: il tag non torna e niente deve essere cambiato.
    const ibrida = Uint8Array.from(altra);
    ibrida.set(una.subarray(0, 48), 0);
    const prima = b.serialize();
    expect(() => b.decrypt(ibrida)).toThrow();
    expect(b.serialize()).toBe(prima);
    expect(b.decryptText(una)).toBe('una');
    expect(b.decryptText(altra)).toBe('altra');
  });
});

describe('i limiti sui salti', () => {
  it('esattamente MAX_SKIP messaggi saltati si recuperano, MAX_SKIP+1 no, e lo stato non si tocca', () => {
    const { a, b } = coppia();
    const saltati: Uint8Array[] = [];
    for (let i = 0; i < MAX_SKIP; i++) saltati.push(a.encryptText(`saltato ${i}`));
    expect(b.decryptText(a.encryptText('dopo mille'))).toBe('dopo mille');
    // Le mille chiavi ci sono tutte: il primo e l'ultimo si aprono.
    expect(b.decryptText(saltati[0]!)).toBe('saltato 0');
    expect(b.decryptText(saltati[MAX_SKIP - 1]!)).toBe(`saltato ${MAX_SKIP - 1}`);

    const { a: a2, b: b2 } = coppia();
    for (let i = 0; i <= MAX_SKIP; i++) a2.encryptText('perso');
    const prima = b2.serialize();
    expect(() => b2.decrypt(a2.encryptText('troppo avanti'))).toThrow(/saltati/);
    expect(b2.serialize(), 'un salto rifiutato non deve aver consumato niente').toBe(prima);
  });

  it('le chiavi saltate hanno un tetto complessivo: le piu vecchie se ne vanno', () => {
    const { a, b } = coppia();
    const vecchie: Uint8Array[] = [];
    // Tre catene, ciascuna con un buco da mille: senza tetto sarebbero tremila
    // chiavi nello stato, e nel deposito.
    for (let giro = 0; giro < 3; giro++) {
      for (let i = 0; i < MAX_SKIP; i++) {
        const busta = a.encryptText(`buco ${giro}-${i}`);
        if (giro === 0 && i < 5) vecchie.push(busta);
      }
      expect(b.decryptText(a.encryptText(`fine giro ${giro}`))).toBe(`fine giro ${giro}`);
      // L'altro risponde: catena nuova al giro dopo.
      expect(a.decryptText(b.encryptText(`ok ${giro}`))).toBe(`ok ${giro}`);
    }
    const stato = deserializeState(JSON.parse(b.serialize()).state as string);
    expect(stato.skipped.size).toBeLessThanOrEqual(MAX_SKIPPED_TOTAL);
    expect(stato.skipped.size).toBeGreaterThan(MAX_SKIP);
    // Le prime del primo giro sono state lasciate andare: non si aprono piu'.
    for (const busta of vecchie) expect(() => b.decrypt(busta)).toThrow();
    // Lo stato serializzato non cresce oltre quello che il tetto permette.
    expect(serializeState(stato).length).toBeLessThan(MAX_SKIPPED_TOTAL * 200);
  });
});
