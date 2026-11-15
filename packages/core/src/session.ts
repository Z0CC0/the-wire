// Sessione: la faccia semplice del protocollo, quella che usano le due interfacce.
// Nasconde X3DH, il ratchet e la busta dietro due verbi: cifra, decifra.

import { td, te, hex, unhex } from './codec.js';
import type { ContactCard, Identity } from './identity.js';
import { decodeEnvelope, encodeEnvelope, encodePrekeyBlock } from './envelope.js';
import {
  deserializeState,
  ratchetDecrypt,
  ratchetEncrypt,
  serializeState,
  x3dhInitiate,
  x3dhRespond,
  type InitialMessage,
  type RatchetState,
} from './ratchet.js';

export class Session {
  private constructor(
    private state: RatchetState,
    /** Ripetuto su ogni messaggio finche' l'altro non risponde: se il primo si
     *  perde nella mailbox, il secondo deve poter aprire ugualmente la sessione. */
    private initial: InitialMessage | undefined,
    readonly peerSigPublic: Uint8Array
  ) {}

  /** Chi scrive per primo. Non richiede che l'altro sia online. */
  static start(self: Identity, peer: ContactCard): Session {
    const { state, initial } = x3dhInitiate(self, peer);
    return new Session(state, initial, peer.sigPublic);
  }

  /** Chi riceve il primo messaggio. Restituisce anche il testo gia' decifrato. */
  static accept(self: Identity, envelopeBytes: Uint8Array): { session: Session; plaintext: Uint8Array } {
    const env = decodeEnvelope(envelopeBytes);
    if (!env.initial) throw new Error('questa busta non apre una sessione: manca il blocco X3DH');
    const state = x3dhRespond(self, env.initial);
    const plaintext = ratchetDecrypt(state, env.header, env.ciphertext, encodePrekeyBlock(env.initial));
    return { session: new Session(state, undefined, env.initial.identitySig), plaintext };
  }

  encrypt(plaintext: Uint8Array): Uint8Array {
    const { header, ciphertext } = ratchetEncrypt(this.state, plaintext, encodePrekeyBlock(this.initial));
    return encodeEnvelope(this.initial ? { header, ciphertext, initial: this.initial } : { header, ciphertext });
  }

  decrypt(envelopeBytes: Uint8Array): Uint8Array {
    const env = decodeEnvelope(envelopeBytes);
    if (env.initial && hex(env.initial.identitySig) !== this.peerId) {
      // Errore esplicito invece del semplice fallimento del tag: se capita per
      // davvero, la causa e' un instradamento sbagliato e vogliamo saperlo.
      throw new Error('blocco X3DH di un altra identita: busta manomessa o consegnata alla sessione sbagliata');
    }
    const plaintext = ratchetDecrypt(this.state, env.header, env.ciphertext, encodePrekeyBlock(env.initial));
    // L'altro ha risposto: la sessione e' viva da entrambi i lati, il blocco
    // X3DH ha smesso di servire e ci toglie 128 byte da ogni messaggio.
    this.initial = undefined;
    return plaintext;
  }

  encryptText(text: string): Uint8Array {
    return this.encrypt(te.encode(text));
  }

  decryptText(envelopeBytes: Uint8Array): string {
    return td.decode(this.decrypt(envelopeBytes));
  }

  /** Identificativo del contatto, usato come chiave nel deposito. */
  get peerId(): string {
    return hex(this.peerSigPublic);
  }

  serialize(): string {
    return JSON.stringify({
      v: 1,
      state: serializeState(this.state),
      initial: this.initial
        ? {
            identitySig: hex(this.initial.identitySig),
            identityDh: hex(this.initial.identityDh),
            ephemeral: hex(this.initial.ephemeral),
            spkUsed: hex(this.initial.spkUsed),
          }
        : null,
      peer: hex(this.peerSigPublic),
    });
  }

  static restore(json: string): Session {
    const o = JSON.parse(json) as Record<string, unknown>;
    if (o['v'] !== 1) throw new Error(`sessione versione ${String(o['v'])}, attesa 1`);
    const unhexed = (s: string) => unhex(s);
    const raw = o['initial'] as Record<string, string> | null;
    const initial: InitialMessage | undefined = raw
      ? {
          identitySig: unhexed(raw['identitySig']!),
          identityDh: unhexed(raw['identityDh']!),
          ephemeral: unhexed(raw['ephemeral']!),
          spkUsed: unhexed(raw['spkUsed']!),
        }
      : undefined;
    return new Session(deserializeState(o['state'] as string), initial, unhexed(o['peer'] as string));
  }
}
