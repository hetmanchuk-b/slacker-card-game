import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { Pool } from 'pg';
import { id } from '../game/ids.ts';
import { migrate, PostgresSession } from './postgres.ts';
import { GameRuntime, RuntimeAdmissionError } from '../runtime/runtime.ts';
import { finishMatch } from '../runtime/testing/match.ts';
import type { LobbyBinding, MatchStart } from './lobby-contracts.ts';
import type { LiveMatch } from './lobby.ts';
import { ChatAdmissionError, PostgresLobby } from './lobby.ts';
import { FakeClock } from '../runtime/testing/fake-clock.ts';
import { canBeat } from '../game/cards.ts';

const url = process.env.PENKY_TEST_DATABASE_URL;
test('PostgreSQL lobby persistence', { skip: !url }, async (t) => {
  assert.ok(new URL(url!).pathname.endsWith('_test'));
  const pool = new Pool({ connectionString: url, max: 8, connectionTimeoutMillis: 3000 });
  pool.on('error', () => {});
  t.after(() => pool.end());
  await migrate(pool);
  function requestFor(
    binding: LobbyBinding,
    expectedGameId: MatchStart['expectedGameId'] = null,
    expectedHead: MatchStart['expectedHead'] = null,
  ): MatchStart {
    return {
      id: id('command', randomUUID()),
      actorSessionId: binding.ownerSessionId,
      expectedGameId,
      expectedHead,
      gameId: id('game', randomUUID()),
      branchId: id('branch', 'main'),
      seatIds: [binding.ownerSeatId, id('seat', randomUUID())],
      cardIds: Array.from({ length: 36 }, () => id('card', randomUUID())),
    };
  }
  function inputsFor(request: MatchStart, clock = new FakeClock(1000)) {
    return {
      clock,
      connectedSeatIds: request.seatIds,
      randomInt: (upper: number) => upper - 1,
      nextCommandId: () => id('command', randomUUID()),
    };
  }
  async function setup(t: TestContext) {
    const binding = {
      id: id('lobby', randomUUID()),
      ownerSessionId: id('session', randomUUID()),
      ownerSeatId: id('seat', randomUUID()),
    };
    const lobby = await PostgresLobby.create(pool, binding);
    const request = requestFor(binding);
    const inputs = inputsFor(request);
    const live = await lobby.startMatch(request, inputs);
    if (live.type !== 'started') assert.fail('Expected initial match');
    t.after(async () => {
      await live.runtime.dispose();
      await live.session.close();
    });
    return { binding, lobby, request, inputs, live };
  }
  async function finish(live: LiveMatch, clock: FakeClock) {
    for (let index = 0; index < 36; index++) {
      const phase = live.runtime.read().state!.phase;
      if (phase.type !== 'dealing') assert.fail('Expected dealing');
      assert.equal(
        (
          await live.runtime.dispatch({
            type: 'draw-card',
            id: id('command', randomUUID()),
            actorId: phase.nextSeatId,
          })
        ).type,
        'accepted',
      );
    }
    await clock.advanceBy(10000);
    await finishMatch(live.runtime);
  }
  await t.test(
    'start admission protects receipt lookup and first-match commit without leaving private preparation',
    async (t) => {
      const binding = {
        id: id('lobby', randomUUID()),
        ownerSessionId: id('session', randomUUID()),
        ownerSeatId: id('seat', randomUUID()),
      };
      const lobby = await PostgresLobby.create(pool, binding);
      const request = requestFor(binding);
      const inputs = inputsFor(request);
      const attempt = async (admit: () => boolean) => {
        const result = await lobby.startMatch(request, inputs, undefined, { admit });
        if (result.type === 'started')
          t.after(async () => {
            await result.runtime.dispose();
            await result.session.close();
          });
        return result;
      };
      await assert.rejects(
        attempt(() => false),
        RuntimeAdmissionError,
      );
      let admissions = 0;
      await assert.rejects(
        attempt(() => ++admissions === 1),
        RuntimeAdmissionError,
      );
      assert.equal(admissions, 2);
      assert.equal(await lobby.startReceipt(request.id), null);
      assert.equal((await lobby.read()).currentGameId, null);
      const first = await lobby.startMatch(request, inputs, undefined, { admit: () => true });
      if (first.type !== 'started') assert.fail();
      t.after(async () => {
        await first.runtime.dispose();
        await first.session.close();
      });
      await assert.rejects(
        lobby.startMatch(request, inputs, undefined, { admit: () => false }),
        RuntimeAdmissionError,
      );
      assert.equal(
        (await lobby.startMatch(request, inputs, undefined, { admit: () => true })).type,
        'duplicate',
      );
    },
  );

  await t.test(
    'denied queued successor admission leaves rollback open and the original writer usable',
    async (t) => {
      const { binding, lobby, live, inputs } = await setup(t);
      await finish(live, inputs.clock);
      const before = live.runtime.read();
      const request = requestFor(binding, before.head.gameId, before.head);
      let admissions = 0;
      await assert.rejects(
        lobby
          .startMatch(request, inputsFor(request, inputs.clock), live, {
            admit: () => ++admissions === 1,
          })
          .then((result) => {
            if (result.type === 'started')
              t.after(async () => {
                await result.runtime.dispose();
                await result.session.close();
              });
            return result;
          }),
        RuntimeAdmissionError,
      );
      assert.equal(admissions, 2);
      assert.deepEqual(live.runtime.read(), before);
      assert.equal(live.session.history.snapshot().value.closedRollback, false);
      assert.equal(await lobby.startReceipt(request.id), null);
      await live.runtime.checkpoint();
    },
  );

  await t.test(
    'chat admission runs in queue before immutable-message retries and failures do not fault gameplay',
    async (t) => {
      const { binding, lobby, live } = await setup(t);
      const input = {
        id: id('message', randomUUID()),
        authorSessionId: binding.ownerSessionId,
        authorSeatId: binding.ownerSeatId,
        text: 'Exact text',
      };
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const blocked = live.runtime.observe(async () => {
        entered();
        await gate;
      });
      await waiting;
      let permitted = true;
      const pending = lobby.postChat(input, 1000, live.runtime, { admit: () => permitted });
      permitted = false;
      release();
      await blocked;
      await assert.rejects(
        pending,
        (error: unknown) => error instanceof ChatAdmissionError && error.code === 'unauthorized',
      );
      assert.deepEqual(await lobby.messages(), []);
      const first = await lobby.postChat(input, 1000, live.runtime, { admit: () => true });
      await assert.rejects(
        lobby.postChat(input, 1000, live.runtime, { admit: () => false }),
        ChatAdmissionError,
      );
      await assert.rejects(
        lobby.postChat(input, 1000, live.runtime, {
          admit: () => {
            throw new Error('PRIVATE SQL');
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof ChatAdmissionError);
          assert.equal(error.code, 'unavailable');
          assert.equal(error.cause, undefined);
          assert.equal(error.message.includes('PRIVATE'), false);
          return true;
        },
      );
      assert.deepEqual(await lobby.messages(), [first]);
      assert.doesNotThrow(() => live.runtime.read());
    },
  );

  await t.test(
    'chat retains original authors and verbatim text across reopening and retries',
    async () => {
      const binding = {
        id: id('lobby', randomUUID()),
        ownerSessionId: id('session', randomUUID()),
        ownerSeatId: id('seat', randomUUID()),
      };
      const lobby = await PostgresLobby.create(pool, binding);
      const input = {
        id: id('message', randomUUID()),
        authorSessionId: binding.ownerSessionId,
        authorSeatId: binding.ownerSeatId,
        text: '  Привіт!  ',
      };
      const first = await lobby.postChat(input, 1000);
      const reopened = await PostgresLobby.open(pool, binding.id);
      assert.equal((await reopened.read()).ownerSessionId, binding.ownerSessionId);
      assert.deepEqual(await reopened.postChat(input, 5000), first);
      assert.deepEqual(await reopened.messages(), [first]);
      assert.deepEqual(await reopened.message(input.id), first);
      assert.equal(await reopened.message(id('message', 'unknown')), null);
      assert.equal(first.text, input.text);
      assert.deepEqual(first.context, { head: null, scope: 'lobby', scopeNumber: null });
      await assert.rejects(reopened.postChat({ ...input, text: 'changed' }, 5000), /reused/);
      await assert.rejects(
        PostgresLobby.create(pool, { ...binding, ownerSessionId: id('session', 'impostor') }),
        /ownership/,
      );
    },
  );
  await t.test(
    'starting a lobby match atomically persists the game, lobby pointer and retry receipt',
    async (t) => {
      const binding = {
        id: id('lobby', randomUUID()),
        ownerSessionId: id('session', randomUUID()),
        ownerSeatId: id('seat', randomUUID()),
      };
      const lobby = await PostgresLobby.create(pool, binding);
      const seats = [binding.ownerSeatId, id('seat', randomUUID())];
      const request = {
        id: id('command', randomUUID()),
        actorSessionId: binding.ownerSessionId,
        expectedGameId: null,
        expectedHead: null,
        gameId: id('game', randomUUID()),
        branchId: id('branch', 'main'),
        seatIds: seats,
        cardIds: Array.from({ length: 36 }, () => id('card', randomUUID())),
      };
      const inputs = {
        clock: new FakeClock(1000),
        connectedSeatIds: seats,
        randomInt: (upper: number) => upper - 1,
        nextCommandId: () => id('command', randomUUID()),
      };
      const result = await lobby.startMatch(request, inputs);
      assert.equal(result.type, 'started');
      if (result.type !== 'started') assert.fail('Expected initial match');
      t.after(async () => {
        await result.runtime.dispose();
        await result.session.close();
      });
      assert.equal(result.runtime.read().state?.phase.type, 'dealing');
      assert.equal((await lobby.read()).currentGameId, request.gameId);
      const retry = await lobby.startMatch(request, inputs);
      assert.deepEqual(retry, { type: 'duplicate', gameId: request.gameId });
    },
  );

  await t.test(
    'chat survives rollback with immutable old-branch provenance and stable pagination',
    async (t) => {
      const { binding, lobby, live } = await setup(t);
      const input = {
        id: id('message', randomUUID()),
        authorSessionId: binding.ownerSessionId,
        authorSeatId: binding.ownerSeatId,
        text: 'до ходу',
      };
      const first = await lobby.postChat(input, 9999, live.runtime);
      assert.equal(first.atMs, 1000);
      const phase = live.runtime.read().state!.phase;
      if (phase.type !== 'dealing') assert.fail('Expected dealing');
      const command = {
        type: 'draw-card' as const,
        id: id('command', randomUUID()),
        actorId: phase.nextSeatId,
      };
      await live.runtime.dispatch(command);
      const secondInput = { ...input, id: id('message', randomUUID()), text: 'скасоване майбутнє' };
      const second = await lobby.postChat(secondInput, 9999, live.runtime);
      const head = live.runtime.read().head;
      await live.runtime.dispatch({
        type: 'rollback',
        id: id('command', randomUUID()),
        actorId: binding.ownerSeatId,
        expected: head,
        beforeCommandId: command.id,
        knowledgeWarningAcknowledged: true,
      });
      const third = await lobby.postChat(
        { ...input, id: id('message', randomUUID()), text: 'нова гілка' },
        9999,
        live.runtime,
      );
      assert.notEqual(third.context.head?.branchId, second.context.head?.branchId);
      assert.deepEqual(await lobby.postChat(secondInput, 50000, live.runtime), second);
      assert.deepEqual(await lobby.messages(), [first, second, third]);
      assert.deepEqual(await lobby.messages(first.sequence, 1), [second]);
      assert.deepEqual(third.context.scope, 'dealing');
      await assert.rejects(
        lobby.postChat(
          { ...input, id: id('message', randomUUID()), text: '\u0000' },
          1000,
          live.runtime,
        ),
        /Invalid chat/,
      );
      await assert.rejects(
        lobby.postChat({ ...input, id: id('message', randomUUID()) }, 1000),
        /context changed/,
      );
      assert.doesNotThrow(() => live.runtime.read());
    },
  );

  await t.test(
    'actual successor creation seals old rollback and retains chat across restart',
    async (t) => {
      const { binding, lobby, live, inputs } = await setup(t);
      await finish(live, inputs.clock);
      const old = live.runtime.read();
      const message = await lobby.postChat(
        {
          id: id('message', randomUUID()),
          authorSessionId: binding.ownerSessionId,
          authorSeatId: binding.ownerSeatId,
          text: 'між партіями',
        },
        1000,
        live.runtime,
      );
      const request = requestFor(binding, old.head.gameId, old.head);
      const next = await lobby.startMatch(request, inputsFor(request, inputs.clock), live);
      if (next.type !== 'started') assert.fail('Expected successor');
      t.after(async () => {
        await next.runtime.dispose();
        await next.session.close();
      });
      assert.equal((await lobby.read()).currentGameId, request.gameId);
      const nextPhase = next.runtime.read().state!.phase;
      if (nextPhase.type !== 'dealing') assert.fail('Expected fresh dealing');
      assert.equal(
        (
          await next.runtime.dispatch({
            type: 'draw-card',
            id: id('command', randomUUID()),
            actorId: nextPhase.nextSeatId,
          })
        ).type,
        'accepted',
      );
      assert.deepEqual(
        (await PostgresSession.load(pool, request.gameId))?.snapshot.head,
        next.runtime.read().head,
      );
      const oldStored = await PostgresSession.load(pool, old.head.gameId);
      assert.ok(
        oldStored?.history.operations.some((operation) => operation.type === 'close-rollback'),
      );
      const retired = await live.runtime.dispatch({
        type: 'rollback',
        id: id('command', randomUUID()),
        actorId: binding.ownerSeatId,
        expected: old.head,
        beforeCommandId: live.session.history.read().actions.at(-1)!.commandId,
        knowledgeWarningAcknowledged: true,
      });
      assert.equal(retired.type, 'rejected');
      if (retired.type === 'rejected') assert.equal(retired.code, 'closed');
      await next.runtime.dispose();
      await next.session.close();
      const reopened = await PostgresLobby.create(pool, binding);
      assert.deepEqual(await reopened.messages(), [message]);
      const receipt = await reopened.startReceipt(request.id);
      assert.deepEqual(receipt?.request, request);
      assert.equal(receipt?.gameId, request.gameId);
      assert.deepEqual(
        await reopened.startMatch(receipt!.request, inputsFor(request, inputs.clock)),
        {
          type: 'duplicate',
          gameId: request.gameId,
        },
      );
      const newSession = await PostgresSession.open(pool, request.gameId, request.branchId);
      t.after(() => newSession.close());
      const newRuntime = await GameRuntime.restore(
        {
          ...inputsFor(request, inputs.clock),
          history: newSession.history,
          commit: newSession.commit,
        },
        newSession.checkpoint!,
      );
      t.after(() => newRuntime.dispose());
      assert.equal(newRuntime.read().state?.phase.type, 'dealing');
      assert.equal(newRuntime.read().head.gameId, request.gameId);
      const oldSession = await PostgresSession.open(pool, old.head.gameId, id('branch', 'main'));
      t.after(() => oldSession.close());
      const recovered = await GameRuntime.restore(
        { ...inputs, history: oldSession.history, commit: oldSession.commit },
        oldSession.checkpoint!,
      );
      t.after(() => recovered.dispose());
      await recovered.dispatch({
        type: 'reconnect',
        id: id('command', randomUUID()),
        seatId: binding.ownerSeatId,
      });
      const rejected = await recovered.dispatch({
        type: 'rollback',
        id: id('command', randomUUID()),
        actorId: binding.ownerSeatId,
        expected: recovered.read().head,
        beforeCommandId: oldSession.history.read().actions.at(-1)!.commandId,
        knowledgeWarningAcknowledged: true,
      });
      assert.equal(rejected.type, 'rejected');
      if (rejected.type === 'rejected') assert.equal(rejected.code, 'rollback-closed');
    },
  );

  await t.test(
    'invalid and unauthorized starts cannot close an existing rollback window',
    async (t) => {
      const { binding, lobby, live, inputs } = await setup(t);
      let request = requestFor(binding, live.runtime.read().head.gameId, live.runtime.read().head);
      assert.deepEqual(
        await lobby.startMatch(
          request,
          {
            ...inputsFor(request),
            randomInt: () => {
              throw new Error('Unfinished start consumed randomness');
            },
          },
          live,
        ),
        {
          type: 'rejected',
          code: 'match-not-finished',
        },
      );
      assert.deepEqual(
        await lobby.startMatch(
          { ...request, actorSessionId: id('session', 'forged') },
          inputsFor(request),
          live,
        ),
        { type: 'rejected', code: 'owner-only' },
      );
      await finish(live, inputs.clock);
      request = { ...request, expectedHead: live.runtime.read().head };
      await assert.rejects(
        lobby.startMatch(
          request,
          {
            ...inputsFor(request),
            randomInt: () => {
              throw new Error('Preparation failed');
            },
          },
          live,
        ),
        /Preparation failed/,
      );
      const bad = await lobby.startMatch({ ...request, cardIds: [] }, inputsFor(request), live);
      assert.deepEqual(bad, { type: 'rejected', code: 'invalid-configuration' });
      const head = live.runtime.read().head;
      assert.equal(
        (
          await live.runtime.dispatch({
            type: 'rollback',
            id: id('command', randomUUID()),
            actorId: binding.ownerSeatId,
            expected: head,
            beforeCommandId: live.session.history.read().actions.at(-1)!.commandId,
            knowledgeWarningAcknowledged: true,
          })
        ).type,
        'accepted',
      );
    },
  );

  await t.test(
    'failed successor insertion leaves the old lobby and rollback window durably intact',
    async (t) => {
      const { binding, lobby, live, inputs } = await setup(t);
      await finish(live, inputs.clock);
      const old = live.runtime.read();
      const before = await PostgresSession.load(pool, old.head.gameId);
      const request = requestFor(binding, old.head.gameId, old.head);
      const functionName = `penky_next_fail_${randomUUID().replaceAll('-', '')}`;
      await pool.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.game_id = '${request.gameId}' THEN RAISE EXCEPTION 'injected handoff failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER ${functionName} BEFORE INSERT ON penky_game_frames FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
      t.after(() =>
        pool.query(
          `DROP TRIGGER IF EXISTS ${functionName} ON penky_game_frames; DROP FUNCTION IF EXISTS ${functionName}()`,
        ),
      );
      await assert.rejects(
        lobby.startMatch(request, inputsFor(request, inputs.clock), live),
        /injected handoff failure/,
      );
      assert.equal((await lobby.read()).currentGameId, old.head.gameId);
      assert.deepEqual(await PostgresSession.load(pool, old.head.gameId), before);
      assert.equal(await PostgresSession.load(pool, request.gameId), null);
      const session = await PostgresSession.open(pool, old.head.gameId, id('branch', 'main'));
      t.after(() => session.close());
      const recovered = await GameRuntime.restore(
        { ...inputs, history: session.history, commit: session.commit },
        session.checkpoint!,
      );
      t.after(() => recovered.dispose());
      await recovered.dispatch({
        type: 'reconnect',
        id: id('command', randomUUID()),
        seatId: binding.ownerSeatId,
      });
      assert.equal(
        (
          await recovered.dispatch({
            type: 'rollback',
            id: id('command', randomUUID()),
            actorId: binding.ownerSeatId,
            expected: recovered.read().head,
            beforeCommandId: session.history.read().actions.at(-1)!.commandId,
            knowledgeWarningAcknowledged: true,
          })
        ).type,
        'accepted',
      );
    },
  );

  await t.test(
    'a stale result head cannot start another match even if the same game is finished',
    async (t) => {
      const { binding, lobby, live, inputs } = await setup(t);
      await finish(live, inputs.clock);
      const head = live.runtime.read().head;
      const request = {
        ...requestFor(binding, head.gameId),
        expectedHead: { ...head, branchId: id('branch', 'abandoned-result') },
      };
      const result = await lobby.startMatch(request, inputsFor(request, inputs.clock), live);
      if (result.type === 'started')
        t.after(async () => {
          await result.runtime.dispose();
          await result.session.close();
        });
      assert.deepEqual(result, { type: 'rejected', code: 'stale-head' });
      assert.equal((await lobby.read()).currentGameId, head.gameId);
      assert.equal(await PostgresSession.load(pool, request.gameId), null);
    },
  );

  await t.test(
    'chat is queued before a later gameplay action, not after its database lookup',
    async (t) => {
      const { binding, lobby, live } = await setup(t);
      const before = live.runtime.read();
      const phase = before.state!.phase;
      if (phase.type !== 'dealing') assert.fail('Expected dealing');
      const posted = lobby.postChat(
        {
          id: id('message', randomUUID()),
          authorSessionId: binding.ownerSessionId,
          authorSeatId: binding.ownerSeatId,
          text: 'first',
        },
        1000,
        live.runtime,
      );
      const played = live.runtime.dispatch({
        type: 'draw-card',
        id: id('command', randomUUID()),
        actorId: phase.nextSeatId,
      });
      const [message, action] = await Promise.all([posted, played]);
      assert.equal(action.type, 'accepted');
      assert.deepEqual(message.context.head, before.head);
      assert.equal(live.runtime.read().head.version, before.head.version + 1);
    },
  );

  await t.test('a racing rollback and actual start never both commit', async (t) => {
    const { binding, lobby, live, inputs } = await setup(t);
    await finish(live, inputs.clock);
    const old = live.runtime.read();
    const request = requestFor(binding, old.head.gameId, old.head);
    const start = lobby.startMatch(request, inputsFor(request, inputs.clock), live);
    const undo = live.runtime.dispatch({
      type: 'rollback',
      id: id('command', randomUUID()),
      actorId: binding.ownerSeatId,
      expected: old.head,
      beforeCommandId: live.session.history.read().actions.at(-1)!.commandId,
      knowledgeWarningAcknowledged: true,
    });
    const [result, rolled] = await Promise.all([start, undo]);
    if (result.type === 'started') {
      t.after(async () => {
        await result.runtime.dispose();
        await result.session.close();
      });
      assert.equal(rolled.type, 'rejected');
      assert.equal((await lobby.read()).currentGameId, request.gameId);
    } else {
      assert.equal(result.type, 'rejected');
      if (result.type === 'rejected')
        assert.ok(['match-not-finished', 'stale-head'].includes(result.code));
      assert.equal(rolled.type, 'accepted');
      assert.equal((await lobby.read()).currentGameId, old.head.gameId);
      assert.equal(await PostgresSession.load(pool, request.gameId), null);
    }
  });

  await t.test(
    'chat context follows dealing, active round and settled between-round scopes',
    async (t) => {
      const { binding, lobby, live, inputs } = await setup(t);
      const message = () => ({
        id: id('message', randomUUID()),
        authorSessionId: binding.ownerSessionId,
        authorSeatId: binding.ownerSeatId,
        text: 'scope',
      });
      for (let index = 0; index < 36; index++) {
        const phase = live.runtime.read().state!.phase;
        if (phase.type !== 'dealing') assert.fail('Expected dealing');
        await live.runtime.dispatch({
          type: 'draw-card',
          id: id('command', randomUUID()),
          actorId: phase.nextSeatId,
        });
      }
      await inputs.clock.advanceBy(10000);
      assert.equal((await lobby.postChat(message(), 1000, live.runtime)).context.scope, 'dealing');
      let state = live.runtime.read().state!;
      if (state.phase.type !== 'between-rounds') assert.fail('Expected boundary');
      const leaderId = state.phase.leaderId;
      const player = state.players.find((player) => player.id === leaderId)!;
      await live.runtime.dispatch({
        type: 'play-card',
        id: id('command', randomUUID()),
        actorId: leaderId,
        cardId: player.hand[0]!,
      });
      const during = await lobby.postChat(message(), 1000, live.runtime);
      assert.equal(during.context.scope, 'round');
      assert.equal(during.context.scopeNumber, 1);
      state = live.runtime.read().state!;
      if (state.phase.type !== 'round') assert.fail('Expected round');
      const turnId = state.phase.turnSeatId;
      const next = state.players.find((player) => player.id === turnId)!;
      const top = state.cards.find((card) => card.id === state.table.at(-1))!.face;
      const cardId = next.hand.find((card) =>
        canBeat(top, state.cards.find((item) => item.id === card)!.face, state.trump),
      );
      await live.runtime.dispatch(
        cardId
          ? { type: 'play-card', id: id('command', randomUUID()), actorId: turnId, cardId }
          : { type: 'take-bottom', id: id('command', randomUUID()), actorId: turnId },
      );
      const between = await lobby.postChat(message(), 1000, live.runtime);
      assert.equal(between.context.scope, 'between-rounds');
      assert.equal(between.context.scopeNumber, 1);
    },
  );

  await t.test(
    'concurrent duplicate chat deliveries commit once without relabeling the message',
    async () => {
      const binding = {
        id: id('lobby', randomUUID()),
        ownerSessionId: id('session', randomUUID()),
        ownerSeatId: id('seat', randomUUID()),
      };
      const lobby = await PostgresLobby.create(pool, binding);
      const input = {
        id: id('message', randomUUID()),
        authorSessionId: binding.ownerSessionId,
        authorSeatId: binding.ownerSeatId,
        text: 'same',
      };
      const connections = await Promise.all(Array.from({ length: 8 }, () => pool.connect()));
      for (const client of connections) client.release();
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, index) => lobby.postChat(input, 1000 + index)),
      );
      assert.equal(new Set(results.map((message) => message.sequence)).size, 1);
      assert.equal((await lobby.messages()).length, 1);
    },
  );
});
