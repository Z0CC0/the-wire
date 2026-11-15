// Gruppi con piu' argomenti dentro. Tre account veri, su disco, che si
// scambiano messaggi a ventaglio attraverso le sessioni 1:1.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Account } from '../src/account.js';
import { MemoryMailbox } from '../src/mailbox.js';
import { DEFAULT_TOPIC, mergeGroup } from '../src/group.js';
import { decodePayload, encodePayload } from '../src/payload.js';
import { hex } from '../src/codec.js';

const PASS = 'passphrase-di-prova';
const dirs: string[] = [];

async function nuovo(nome: string) {
  const d = await mkdtemp(join(tmpdir(), 'wire-g-'));
  dirs.push(d);
  const a = await Account.create(PASS, d);
  await a.setDisplayName(nome);
  await a.connect(new MemoryMailbox(hex(a.identity.nostrPublic)), { live: false });
  return a;
}

/** Alice conosce Bob e Carla; loro conoscono solo Alice. */
async function trio() {
  const [alice, bob, carla] = await Promise.all([nuovo('ALICE'), nuovo('BOB'), nuovo('CARLA')]);
  await alice.addContact(bob.uri, 'BOB');
  await alice.addContact(carla.uri, 'CARLA');
  await bob.addContact(alice.uri, 'ALICE');
  await carla.addContact(alice.uri, 'ALICE');
  return { alice, bob, carla };
}

beforeEach(() => MemoryMailbox.reset());
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe('fusione dello stato', () => {
  const base = (over: Partial<Parameters<typeof mergeGroup>[1]> = {}) =>
    ({
      v: 1 as const,
      t: 'group.state' as const,
      g: 'abcdef0123456789',
      name: 'CASA',
      members: [{ id: 'aa11bb22', name: 'A', card: 'x' }],
      topics: [{ id: 'topic1234', name: 'SPESA' }],
      at: 100,
      ...over,
    });

  it('un gruppo nuovo nasce sempre con l argomento predefinito', () => {
    const g = mergeGroup(undefined, base({ topics: [] }), 1);
    expect(g.topics[0]!.id).toBe(DEFAULT_TOPIC.id);
  });

  it('i membri si uniscono, non si sostituiscono', () => {
    const uno = mergeGroup(undefined, base(), 1);
    const due = mergeGroup(uno, base({ members: [{ id: 'cc33dd44', name: 'C', card: 'y' }], at: 200 }));
    expect(due.members.map((m) => m.id).sort()).toEqual(['aa11bb22', 'cc33dd44']);
  });

  it('una fotografia vecchia non riporta indietro il nome', () => {
    const uno = mergeGroup(undefined, base({ name: 'NUOVO', at: 500 }), 1);
    const due = mergeGroup(uno, base({ name: 'VECCHIO', at: 100 }));
    expect(due.name).toBe('NUOVO');
  });

  it('l ordine di arrivo non cambia il risultato', () => {
    const x = base({ members: [{ id: 'aa11bb22', name: 'A', card: 'x' }], at: 100 });
    const y = base({ members: [{ id: 'cc33dd44', name: 'C', card: 'y' }], at: 200 });
    const xy = mergeGroup(mergeGroup(undefined, x, 1), y);
    const yx = mergeGroup(mergeGroup(undefined, y, 1), x);
    expect(xy.members.map((m) => m.id).sort()).toEqual(yx.members.map((m) => m.id).sort());
    expect(xy.name).toBe(yx.name);
  });
});

describe('payload', () => {
  it('giro completo sui tre tipi', () => {
    const casi = [
      { v: 1 as const, t: 'text' as const, text: 'ciao' },
      { v: 1 as const, t: 'group.msg' as const, g: 'aabbccdd', topic: 'eeff0011', text: 'nel gruppo' },
    ];
    for (const c of casi) expect(decodePayload(encodePayload(c))).toEqual(c);
  });

  it('rifiuta payload malformati invece di fidarsi', () => {
    const cattivi = [
      '{}',
      '{"v":2,"t":"text","text":"x"}',
      '{"v":1,"t":"sconosciuto"}',
      '{"v":1,"t":"text","text":123}',
      '{"v":1,"t":"group.msg","g":"NONESA","topic":"aabbccdd","text":"x"}',
      '{"v":1,"t":"group.state","g":"aabbccdd","name":"x","members":"non-array","topics":[]}',
      'non-json',
    ];
    for (const c of cattivi) {
      expect(() => decodePayload(new TextEncoder().encode(c)), c).toThrow();
    }
  });

  it('rifiuta un testo assurdamente lungo', () => {
    const enorme = JSON.stringify({ v: 1, t: 'text', text: 'x'.repeat(70000) });
    expect(() => decodePayload(new TextEncoder().encode(enorme))).toThrow(/troppo lungo/);
  });
});

describe('gruppi', () => {
  it('creare un gruppo lo fa comparire a tutti i membri', async () => {
    const { alice, bob, carla } = await trio();
    const g = await alice.createGroup('PROGETTO', [alice.contact('BOB')!, alice.contact('CARLA')!]);
    expect(g.members).toHaveLength(3);

    await bob.sync();
    await carla.sync();
    expect(bob.group('PROGETTO')?.id).toBe(g.id);
    expect(carla.group('PROGETTO')?.id).toBe(g.id);
  });

  it('chi entra nel gruppo si ritrova in rubrica gli altri membri', async () => {
    const { alice, bob, carla } = await trio();
    await alice.createGroup('PROGETTO', [alice.contact('BOB')!, alice.contact('CARLA')!]);
    await bob.sync();

    // Bob non aveva mai visto Carla: ora ce l'ha, ma NON verificata.
    const nuovaConoscenza = bob.contact('CARLA');
    expect(nuovaConoscenza).toBeDefined();
    expect(nuovaConoscenza!.verifiedAt).toBeNull();
    expect(nuovaConoscenza!.id).toBe(carla.id);
  });

  it('un messaggio di gruppo arriva a tutti i membri', async () => {
    const { alice, bob, carla } = await trio();
    const g = await alice.createGroup('PROGETTO', [alice.contact('BOB')!, alice.contact('CARLA')!]);
    await bob.sync();
    await carla.sync();

    await alice.sendGroupText(g, DEFAULT_TOPIC.id, 'buongiorno a tutti');

    for (const chi of [bob, carla]) {
      const arrivati = await chi.sync();
      const testi = arrivati.filter((m) => !m.system).map((m) => m.text);
      expect(testi).toContain('buongiorno a tutti');
      expect(arrivati.find((m) => m.text === 'buongiorno a tutti')!.from).toBe(alice.id);
    }
  });

  it('due membri che non si erano mai parlati si scrivono nel gruppo', async () => {
    const { alice, bob, carla } = await trio();
    const g = await alice.createGroup('PROGETTO', [alice.contact('BOB')!, alice.contact('CARLA')!]);
    await bob.sync();
    await carla.sync();

    // Bob scrive: deve raggiungere anche Carla, che ha conosciuto solo ora.
    await bob.sendGroupText(bob.group('PROGETTO')!, DEFAULT_TOPIC.id, 'ci sono anch io');
    const daCarla = (await carla.sync()).filter((m) => !m.system);
    expect(daCarla.map((m) => m.text)).toContain('ci sono anch io');
    expect(daCarla[0]!.from).toBe(bob.id);
  });

  it('gli argomenti separano le conversazioni', async () => {
    const { alice, bob, carla } = await trio();
    let g = await alice.createGroup('PROGETTO', [alice.contact('BOB')!, alice.contact('CARLA')!]);
    await bob.sync();
    await carla.sync();

    const bug = await alice.addTopic(g, 'bug');
    g = alice.group(g.id)!;
    await bob.sync();

    await alice.sendGroupText(g, DEFAULT_TOPIC.id, 'nel generale');
    await alice.sendGroupText(g, bug.id, 'nei bug');
    await bob.sync();

    const gruppoBob = bob.group('PROGETTO')!;
    expect(gruppoBob.topics.map((t) => t.name)).toContain('BUG');

    const generale = await bob.groupHistory(gruppoBob, DEFAULT_TOPIC.id);
    const suiBug = await bob.groupHistory(gruppoBob, bug.id);
    expect(generale.filter((m) => !m.system).map((m) => m.text)).toEqual(['nel generale']);
    expect(suiBug.map((m) => m.text)).toEqual(['nei bug']);
  });

  it('lo storico del gruppo tiene entrambi i lati in ordine', async () => {
    const { alice, bob, carla } = await trio();
    const g = await alice.createGroup('PROGETTO', [alice.contact('BOB')!, alice.contact('CARLA')!]);
    await bob.sync();
    await carla.sync();

    await alice.sendGroupText(g, DEFAULT_TOPIC.id, 'primo');
    await bob.sync();
    await bob.sendGroupText(bob.group('PROGETTO')!, DEFAULT_TOPIC.id, 'secondo');
    await alice.sync();

    const storico = (await alice.groupHistory(g)).filter((m) => !m.system);
    expect(storico.map((m) => m.text)).toEqual(['primo', 'secondo']);
    expect(storico.map((m) => m.mine)).toEqual([true, false]);
  });

  it('un estraneo al gruppo non ci scrive dentro', async () => {
    const { alice, bob, carla } = await trio();
    const g = await alice.createGroup('SOLO NOI DUE', [alice.contact('BOB')!]);
    await bob.sync();

    // Carla conosce Alice e prova a scrivere in un gruppo di cui non fa parte,
    // falsificandone l'id. Alice non e' membro-cieca: controlla il roster.
    const finto = { ...g, members: [{ id: carla.id, name: 'CARLA', card: '' }] };
    await carla.sendGroupText(
      { ...finto, id: g.id, topics: [DEFAULT_TOPIC] },
      DEFAULT_TOPIC.id,
      'intrusione'
    ).catch(() => undefined);

    const arrivati = await alice.sync();
    expect(arrivati.map((m) => m.text)).not.toContain('intrusione');
  });

  it('uscire dal gruppo cancella gruppo e storico in locale', async () => {
    const { alice, bob } = await trio();
    const g = await alice.createGroup('TEMPORANEO', [alice.contact('BOB')!]);
    await alice.sendGroupText(g, DEFAULT_TOPIC.id, 'da dimenticare');
    expect((await alice.groupHistory(g)).length).toBeGreaterThan(0);

    await alice.leaveGroup(g.id);
    expect(alice.groups()).toHaveLength(0);
    expect(await alice.groupHistory(g)).toHaveLength(0);
    await bob.close();
  });

  it('gruppi e argomenti sopravvivono a chiusura e riapertura', async () => {
    const { alice, bob } = await trio();
    const g = await alice.createGroup('DUREVOLE', [alice.contact('BOB')!]);
    await alice.addTopic(g, 'rilasci');
    await alice.sendGroupText(alice.group(g.id)!, DEFAULT_TOPIC.id, 'prima del riavvio');
    const dir = alice.dataDir;
    await alice.close();

    const riaperta = await Account.open(PASS, dir);
    const gruppo = riaperta.group('DUREVOLE')!;
    expect(gruppo.topics.map((t) => t.name)).toEqual(['GENERALE', 'RILASCI']);
    expect((await riaperta.groupHistory(gruppo)).filter((m) => !m.system).map((m) => m.text)).toEqual([
      'prima del riavvio',
    ]);
    await riaperta.close();
    await bob.close();
  });
});
