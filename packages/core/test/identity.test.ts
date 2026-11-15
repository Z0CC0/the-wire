import { describe, expect, it } from 'vitest';
import {
  addressOf,
  cardFromUri,
  cardOf,
  cardToUri,
  createIdentity,
  decodeCard,
  encodeCard,
  safetyNumber,
  verifyCard,
  CARD_BYTES,
} from '../src/identity.js';

describe('identita', () => {
  it('genera chiavi delle lunghezze attese', () => {
    const id = createIdentity();
    expect(id.sigSecret).toHaveLength(32);
    expect(id.sigPublic).toHaveLength(32);
    expect(id.dhSecret).toHaveLength(32);
    expect(id.dhPublic).toHaveLength(32);
    expect(id.spkSignature).toHaveLength(64);
  });

  it('due identita non collidono', () => {
    const a = createIdentity();
    const b = createIdentity();
    expect(Buffer.from(a.sigPublic).equals(Buffer.from(b.sigPublic))).toBe(false);
  });

  it('la card si codifica e si rilegge identica', () => {
    const card = cardOf(createIdentity());
    const bytes = encodeCard(card);
    expect(bytes).toHaveLength(CARD_BYTES);
    const back = decodeCard(bytes);
    expect(Buffer.from(back.sigPublic).equals(Buffer.from(card.sigPublic))).toBe(true);
    expect(Buffer.from(back.spkSignature).equals(Buffer.from(card.spkSignature))).toBe(true);
  });

  it('la card valida supera la verifica', () => {
    expect(verifyCard(cardOf(createIdentity()))).toBe(true);
  });

  it('una prekey sostituita non passa la verifica', () => {
    const vittima = cardOf(createIdentity());
    const attaccante = cardOf(createIdentity());
    // Scambio classico dell'uomo-nel-mezzo: la mia prekey, la tua identita'.
    const falsa = { ...vittima, spkPublic: attaccante.spkPublic };
    expect(verifyCard(falsa)).toBe(false);
  });

  it('un bit girato nella firma non passa', () => {
    const card = cardOf(createIdentity());
    const sig = Uint8Array.from(card.spkSignature);
    sig[0] ^= 1;
    expect(verifyCard({ ...card, spkSignature: sig })).toBe(false);
  });

  it('URI: giro completo', () => {
    const card = cardOf(createIdentity());
    const uri = cardToUri(card);
    expect(uri.startsWith('wire:1:')).toBe(true);
    expect(Buffer.from(cardFromUri(uri).dhPublic).equals(Buffer.from(card.dhPublic))).toBe(true);
  });

  it('URI manomesso viene rifiutato', () => {
    const card = cardOf(createIdentity());
    const uri = cardToUri(card);
    const rotto = uri.slice(0, -4) + (uri.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(() => cardFromUri(rotto)).toThrow();
    expect(() => cardFromUri('wire:2:abc')).toThrow();
    expect(() => cardFromUri('ciao')).toThrow();
  });

  it('indirizzo stabile e diverso fra identita', () => {
    const a = cardOf(createIdentity());
    const b = cardOf(createIdentity());
    expect(addressOf(a)).toBe(addressOf(a));
    expect(addressOf(a)).not.toBe(addressOf(b));
    expect(addressOf(a)).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4})+$/);
  });

  it('il numero di sicurezza e lo stesso per i due lati', () => {
    const a = cardOf(createIdentity());
    const b = cardOf(createIdentity());
    expect(safetyNumber(a, b)).toBe(safetyNumber(b, a));
    expect(safetyNumber(a, b).replace(/ /g, '')).toHaveLength(60);
  });

  it('il numero di sicurezza cambia se cambia una identita', () => {
    const a = cardOf(createIdentity());
    const b = cardOf(createIdentity());
    const c = cardOf(createIdentity());
    expect(safetyNumber(a, b)).not.toBe(safetyNumber(a, c));
  });
});
