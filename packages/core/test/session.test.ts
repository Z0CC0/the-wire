import { describe, expect, it } from 'vitest';
import { cardOf, createIdentity } from '../src/identity.js';
import { Session } from '../src/session.js';
import { MAX_SKIP } from '../src/ratchet.js';
import { decodeEnvelope, encodeEnvelope, TYPE_PREKEY, MAGIC } from '../src/envelope.js';

function coppia() {
  const alice = createIdentity();
  const bob = createIdentity();
  return { alice, bob, cardBob: cardOf(bob), cardAlice: cardOf(alice) };
}

/** Apre la sessione nei due sensi e restituisce entrambi i lati pronti. */
function apri() {
  const { alice, bob, cardBob } = coppia();
  const a = Session.start(alice, cardBob);
  const primo = a.encryptText('ciao');
  const { session: b, plaintext } = Session.accept(bob, primo);
  return { a, b, primo, testoPrimo: new TextDecoder().decode(plaintext) };
}

describe('sessione', () => {
  it('il primo messaggio arriva senza che il destinatario sia online', () => {
    const { testoPrimo } = apri();
    expect(testoPrimo).toBe('ciao');
  });

  it('conversazione avanti e indietro', () => {
    const { a, b } = apri();
    expect(b.decryptText(a.encryptText('uno'))).toBe('uno');
    expect(a.decryptText(b.encryptText('due'))).toBe('due');
    expect(b.decryptText(a.encryptText('tre'))).toBe('tre');
    expect(a.decryptText(b.encryptText('quattro'))).toBe('quattro');
  });

  it('molti messaggi di fila da un solo lato', () => {
    const { a, b } = apri();
    const buste = Array.from({ length: 50 }, (_, i) => a.encryptText(`msg ${i}`));
    buste.forEach((busta, i) => expect(b.decryptText(busta)).toBe(`msg ${i}`));
  });

  it('messaggi che arrivano fuori ordine', () => {
    const { a, b } = apri();
    const uno = a.encryptText('uno');
    const due = a.encryptText('due');
    const tre = a.encryptText('tre');
    expect(b.decryptText(tre)).toBe('tre');
    expect(b.decryptText(uno)).toBe('uno');
    expect(b.decryptText(due)).toBe('due');
  });

  it('un messaggio perso non blocca i successivi', () => {
    const { a, b } = apri();
    a.encryptText('questo si perde per strada');
    expect(b.decryptText(a.encryptText('questo arriva'))).toBe('questo arriva');
  });

  it('messaggi fuori ordine a cavallo di un giro di DH', () => {
    const { a, b } = apri();
    const vecchio = a.encryptText('prima del giro');
    expect(a.decryptText(b.encryptText('risposta'))).toBe('risposta'); // forza il DH ratchet
    const nuovo = a.encryptText('dopo il giro');
    expect(b.decryptText(nuovo)).toBe('dopo il giro');
    expect(b.decryptText(vecchio)).toBe('prima del giro');
  });

  it('la stessa busta non si decifra due volte', () => {
    const { a, b } = apri();
    const busta = a.encryptText('una volta sola');
    expect(b.decryptText(busta)).toBe('una volta sola');
    expect(() => b.decryptText(busta)).toThrow();
  });

  it('un bit girato nel testo cifrato fa fallire il tag', () => {
    const { a, b } = apri();
    const busta = a.encryptText('integro');
    busta[busta.length - 1] ^= 1;
    expect(() => b.decryptText(busta)).toThrow();
  });

  it('un bit girato nell header fa fallire il tag', () => {
    const { a, b } = apri();
    const busta = a.encryptText('integro');
    busta[10] ^= 1; // dentro il blocco X3DH/header, non nel testo cifrato
    expect(() => b.decryptText(busta)).toThrow();
  });

  it('un terzo non decifra, anche con la sua sessione aperta', () => {
    const { alice, bob, cardBob } = coppia();
    const eve = createIdentity();
    const a = Session.start(alice, cardBob);
    const perBob = a.encryptText('segreto');
    expect(() => Session.accept(eve, perBob)).toThrow();
    expect(() => Session.accept(bob, perBob)).not.toThrow();
  });

  it('oltre MAX_SKIP messaggi saltati il ratchet si ferma', () => {
    const { a, b } = apri();
    for (let i = 0; i <= MAX_SKIP + 1; i++) a.encryptText(`buco ${i}`);
    expect(() => b.decryptText(a.encryptText('troppo avanti'))).toThrow(/saltati/);
  });

  it('lo stato sopravvive a salvataggio e ricarica', () => {
    const { a, b } = apri();
    expect(b.decryptText(a.encryptText('prima'))).toBe('prima');

    const a2 = Session.restore(a.serialize());
    const b2 = Session.restore(b.serialize());

    expect(b2.decryptText(a2.encryptText('dopo il riavvio'))).toBe('dopo il riavvio');
    expect(a2.decryptText(b2.encryptText('e risposta'))).toBe('e risposta');
  });

  it('il blocco X3DH sparisce dopo la prima risposta', () => {
    const { a, b } = apri();
    // Finche' Alice non riceve nulla, ripete il blocco: se il primo si perde,
    // il secondo deve comunque poter aprire la sessione.
    expect(decodeEnvelope(a.encryptText('ancora io')).initial).toBeDefined();
    a.decryptText(b.encryptText('eccomi'));
    expect(decodeEnvelope(a.encryptText('ora basta')).initial).toBeUndefined();
  });

  it('due sessioni diverse non producono lo stesso testo cifrato', () => {
    const { alice, cardBob } = coppia();
    const uno = Session.start(alice, cardBob).encryptText('identico');
    const due = Session.start(alice, cardBob).encryptText('identico');
    expect(Buffer.from(uno).equals(Buffer.from(due))).toBe(false);
  });

  it('la busta non contiene il testo in chiaro', () => {
    const { a } = apri();
    const busta = Buffer.from(a.encryptText('PAROLA-CHE-NON-DEVE-COMPARIRE'));
    expect(busta.includes(Buffer.from('PAROLA-CHE-NON-DEVE-COMPARIRE'))).toBe(false);
  });
});

describe('busta', () => {
  it('rifiuta sigla sbagliata, versione sbagliata, troncatura', () => {
    const { a } = apri();
    const busta = a.encryptText('x');

    const siglaRotta = Uint8Array.from(busta);
    siglaRotta[0] = 0x58;
    expect(() => decodeEnvelope(siglaRotta)).toThrow(/busta THE WIRE/);

    const versioneRotta = Uint8Array.from(busta);
    versioneRotta[MAGIC.length] = 9;
    expect(() => decodeEnvelope(versioneRotta)).toThrow(/versione/);

    expect(() => decodeEnvelope(busta.subarray(0, 20))).toThrow();
    expect(() => decodeEnvelope(new Uint8Array(0))).toThrow();
  });

  it('rifiuta un tipo sconosciuto', () => {
    const { a } = apri();
    const busta = Uint8Array.from(a.encryptText('x'));
    busta[MAGIC.length + 1] = 99;
    expect(() => decodeEnvelope(busta)).toThrow(/tipo di busta/);
  });

  it('codifica e decodifica sono simmetriche', () => {
    const { a } = apri();
    const originale = a.encryptText('giro completo');
    const env = decodeEnvelope(originale);
    expect(env.initial).toBeDefined();
    expect(Buffer.from(encodeEnvelope(env)).equals(Buffer.from(originale))).toBe(true);
    expect(originale[MAGIC.length + 1]).toBe(TYPE_PREKEY);
  });
});
