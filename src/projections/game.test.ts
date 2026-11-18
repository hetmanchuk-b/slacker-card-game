import assert from 'node:assert/strict';
import { test } from 'node:test';
import { id } from '../game/ids.ts';
import { heart, scenario, seat, spade } from '../game/testing/scenarios.ts';
import { fixture } from '../runtime/testing/fixtures.ts';
import type { BranchHead } from '../game/contracts.ts';
import type { GameState } from '../game/model.ts';
import { projectGame } from './game.ts';

const head = (state: GameState): BranchHead => ({
  gameId: state.gameId,
  branchId: id('branch', 'main'),
  version: 42,
});

for (const count of [2, 4, 8]) {
  test(`current views expose only each bound seat's hand and stump handles at ${count} seats`, () => {
    const { history, seats } = fixture('reveal', count);
    const snapshot = history.read();
    const state = snapshot.state!;
    const before = structuredClone(snapshot);
    for (const seatId of seats) {
      const view = projectGame(snapshot, { type: 'seat', seatId });
      const player = state.players.find((player) => player.id === seatId)!;
      assert.deepEqual(view.head, snapshot.head);
      assert.deepEqual(view.state, {
        viewer: { type: 'participant', seatId },
        players: state.players.map((player) => ({
          id: player.id,
          status: player.status,
          handCount: player.hand.length,
          stumpCount: player.stumps.length,
        })),
        own: {
          seatId,
          hand: player.hand.map((cardId) => state.cards.find((card) => card.id === cardId)),
          stumps: player.stumps,
        },
        deckCount: 0,
        table: [],
        discardCount: 0,
        phase: { type: 'trump-reveal' },
      });
    }
    assert.deepEqual(snapshot, before);
    const publicView = projectGame(snapshot, { type: 'public' });
    assert.equal(publicView.state!.viewer.type, 'spectator');
    assert.equal(publicView.state!.own, null);
    assert.equal(JSON.stringify(publicView).includes('opaque-'), false);
  });
}

test('public table preserves bottom-to-top order and exposes only explicit card fields', () => {
  const state = scenario({
    hands: [[heart(10)], [heart(11)], [heart(12)]],
    table: [heart(6), heart(7)],
  });
  const view = projectGame({ head: head(state), state }, { type: 'public' });
  assert.deepEqual(
    view.state!.table,
    state.table.map((cardId) => state.cards.find((card) => card.id === cardId)),
  );
  assert.deepEqual(view.state!.phase, {
    type: 'round',
    number: 2,
    targetSize: 3,
    turnSeatId: seat(0),
  });
  assert.equal(view.state!.discardCount, 31);
  assert.equal(view.state!.own, null);
});

test('hidden faces, deck order, trump, private knowledge and procedure payloads do not affect a public view', () => {
  const { history, seats } = fixture('vote', 4);
  const snapshot = history.read();
  const state = snapshot.state!;
  const changed: GameState = {
    ...state,
    cards: [...state.cards]
      .reverse()
      .map((card, index) => ({ ...card, face: state.cards[index]!.face })),
    deck: [...state.deck].reverse(),
    trump: 'hearts',
    phase: { type: 'dealing', nextSeatId: seats[1]!, drawCount: 0 },
    peekedStumps: [{ seatId: seats[1]!, cardId: state.deck[0]! }],
    repetitions: { 'SECRET-REPETITION-KEY': 2 },
    lastRepetitionKey: 'SECRET-REPETITION-KEY',
    claims: [],
    procedure: null,
    pendingPenalties: [],
    automaticIncidents: ['SECRET-INCIDENT'],
  };
  assert.deepEqual(
    projectGame(snapshot, { type: 'public' }),
    projectGame({ head: snapshot.head, state: changed }, { type: 'public' }),
  );
  assert.deepEqual(projectGame(snapshot, { type: 'public' }).state!.phase, { type: 'dealing' });
});

test('changing opponents and closed stump faces cannot change a seated view', () => {
  const { history, seats } = fixture('reveal', 8);
  const snapshot = history.read();
  const state = snapshot.state!;
  const viewer = { type: 'seat' as const, seatId: seats[0]! };
  const ownHand = state.players[0]!.hand;
  const hidden = state.cards.filter((card) => !ownHand.includes(card.id));
  const changed: GameState = {
    ...state,
    cards: state.cards.map((card) => {
      const index = hidden.findIndex((item) => item.id === card.id);
      return index < 0 ? card : { id: card.id, face: hidden[(index + 1) % hidden.length]!.face };
    }),
  };
  assert.deepEqual(
    projectGame(snapshot, viewer),
    projectGame({ head: snapshot.head, state: changed }, viewer),
  );
});

test('finished seats and owner receive no administrative or post-game expansion of visibility', () => {
  const state = scenario({ hands: [[], [heart(10)]], wonSeats: [0], leader: 1 });
  const finished: GameState = {
    ...state,
    phase: { type: 'finished', result: { type: 'last-player', loserId: seat(1) } },
  };
  const view = projectGame(
    { head: head(finished), state: finished },
    { type: 'seat', seatId: seat(0) },
  );
  assert.deepEqual(view.state!.viewer, { type: 'finished-player', seatId: seat(0) });
  assert.deepEqual(view.state!.own, { seatId: seat(0), hand: [], stumps: [] });
  assert.deepEqual(view.state!.phase, {
    type: 'finished',
    result: { type: 'last-player', loserId: seat(1) },
  });
  assert.equal(JSON.stringify(view).includes('opaque-'), false);
});

test('all existing result variants remain explicit and do not reveal remaining cards', () => {
  const state = scenario({ hands: [[heart(10)], [spade(11)]] });
  for (const result of [
    { type: 'all-won' } as const,
    { type: 'draw', remainingSeatIds: [seat(0), seat(1)] } as const,
  ]) {
    const finished: GameState = { ...state, phase: { type: 'finished', result } };
    const view = projectGame({ head: head(state), state: finished }, { type: 'public' });
    assert.deepEqual(view.state!.phase, { type: 'finished', result });
    assert.equal(JSON.stringify(view).includes('opaque-'), false);
  }
});

test('between-rounds and pre-game phases disclose no extra authoritative fields', () => {
  const state = scenario({ hands: [[heart(10)], [heart(11)]], openingSeats: [] });
  assert.deepEqual(projectGame({ head: head(state), state }, { type: 'public' }).state!.phase, {
    type: 'between-rounds',
    leaderId: seat(0),
    nextRoundNumber: 2,
  });
  const beforePlay: GameState = {
    ...state,
    phase: { type: 'pre-game-penalties', firstLeaderId: seat(1) },
  };
  assert.deepEqual(
    projectGame({ head: head(state), state: beforePlay }, { type: 'public' }).state!.phase,
    { type: 'pre-game-penalties' },
  );
});

test('empty snapshots are safe and unknown seated viewers fail without identity disclosure', () => {
  const { history } = fixture('reveal');
  const snapshot = history.read();
  assert.deepEqual(projectGame({ head: snapshot.head, state: null }, { type: 'public' }), {
    head: snapshot.head,
    state: null,
  });
  assert.throws(
    () => projectGame(snapshot, { type: 'seat', seatId: id('seat', 'SECRET-FOREIGN-SEAT') }),
    { message: 'Unknown viewer seat' },
  );
  assert.throws(
    () =>
      projectGame(
        { ...snapshot, head: { ...snapshot.head, gameId: id('game', 'other') } },
        { type: 'public' },
      ),
    { message: 'Projection game mismatch' },
  );
});

test('projection output is detached and ignores additional properties on server objects', () => {
  const state = scenario({ hands: [[heart(10)], [heart(11)]], table: [heart(6)] });
  const snapshot = { head: head(state), state };
  Object.assign(snapshot.head, { secret: 'SECRET-HEAD' });
  for (const card of state.cards) {
    Object.assign(card.face, { secret: 'SECRET-FACE' });
    Object.assign(card, { secret: 'SECRET-CARD' });
  }
  const before = structuredClone(snapshot);
  const view = projectGame(snapshot, { type: 'seat', seatId: seat(0) });
  assert.equal(JSON.stringify(view).includes('SECRET-'), false);
  assert.notEqual(view.head, snapshot.head);
  assert.notEqual(view.state!.own!.stumps, state.players[0]!.stumps);
  const mutable = view as unknown as {
    head: { version: number };
    state: { own: { hand: { face: { rank: number } }[] }; table: unknown[] };
  };
  mutable.head.version = 900;
  mutable.state.own.hand[0]!.face.rank = 14;
  mutable.state.table.length = 0;
  assert.deepEqual(snapshot, before);
  assert.notEqual(
    view.state!.own!.hand[0]!.face,
    state.cards.find((card) => card.id === state.players[0]!.hand[0])!.face,
  );
  assert.notEqual(
    projectGame(snapshot, { type: 'public' }).state!.table[0]!.face,
    state.cards.find((card) => card.id === state.table[0])!.face,
  );
});
