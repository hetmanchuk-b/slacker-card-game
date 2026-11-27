import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { Pool } from 'pg';
import { id } from '../game/ids.ts';
import type { MatchStart } from '../persistence/lobby-contracts.ts';
import { migrate, PostgresSession } from '../persistence/postgres.ts';
import { FakeClock } from '../runtime/testing/fake-clock.ts';
import { finishMatch } from '../runtime/testing/match.ts';
import { PostgresGuestAccess } from './guest-access.ts';
import { PostgresGameHost } from './game-host.ts';
import { PostgresLobby } from '../persistence/lobby.ts';
import { RuntimeAdmissionError } from '../runtime/runtime.ts';
import { CaptureStore } from './capture-store.ts';
import type { CaptureHandle } from './capture-store.ts';
import type { HostPublication } from './game-host.ts';

const url = process.env.PENKY_TEST_DATABASE_URL;
test('PostgreSQL single-runtime game host', { skip: !url }, async (t) => {
  assert.ok(new URL(url!).pathname.endsWith('_test'));
  const pool = new Pool({ connectionString: url, max: 16, connectionTimeoutMillis: 3000 });
  pool.on('error', () => {});
  t.after(() => pool.end());
  await migrate(pool);
  const access = new PostgresGuestAccess(pool);
  async function failFrames(t: TestContext, gameId: string, condition = 'TRUE') {
    const name = `host_fail_${randomUUID().replaceAll('-', '')}`;
    // Only host-generated UUID identifiers are interpolated. The trigger is
    // game-specific, so concurrently running PostgreSQL suites are unaffected.
    await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.game_id = '${gameId}' AND (${condition}) THEN RAISE EXCEPTION 'injected host frame failure'; END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER ${name} BEFORE INSERT ON penky_game_frames FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    const remove = async () => {
      await pool.query(
        `DROP TRIGGER IF EXISTS ${name} ON penky_game_frames; DROP FUNCTION IF EXISTS ${name}()`,
      );
    };
    t.after(remove);
    return remove;
  }
  async function writerExited(gameId: string) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const result = await pool.query('SELECT 1 FROM pg_stat_activity WHERE application_name=$1', [
        `penky-game:${gameId}`,
      ]);
      if (!result.rowCount) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.fail('Disposed writer backend did not exit');
  }
  async function setup(t: TestContext, captures?: CaptureStore) {
    const clock = new FakeClock(1000);
    const reporters: ((error: unknown) => void)[] = [];
    const host = new PostgresGameHost(pool, {
      ...(captures ? { captures } : {}),
      inputs: (onError) => {
        reporters.push(onError);
        return {
          clock: {
            now: () => clock.now(),
            scheduleAt: (at, task) =>
              clock.scheduleAt(at, async () => {
                try {
                  await task();
                } catch (error) {
                  onError(error);
                }
              }),
          },
          randomInt: (upper) => upper - 1,
          nextCommandId: () => id('command', randomUUID()),
        };
      },
    });
    t.after(() => host.close());
    const owner = await access.issue(1000);
    const member = await access.createLobby(owner.token, id('lobby', randomUUID()), 1000);
    const guest = await access.issue(1000);
    const joined = await access.joinLobby(guest.token, member.lobbyId, 1000);
    const ownerBinding = await access.membership(owner.token, member.lobbyId, 1000);
    const leaveOwner = await host.attach(ownerBinding);
    const leaveGuest = await host.attach(joined);
    const request: MatchStart = {
      id: id('command', randomUUID()),
      actorSessionId: member.sessionId,
      expectedGameId: null,
      expectedHead: null,
      gameId: id('game', randomUUID()),
      branchId: id('branch', randomUUID()),
      seatIds: joined.seatIds,
      cardIds: Array.from({ length: 36 }, () => id('card', randomUUID())),
    };
    const acceptance = await access.lobbyState(owner.token, member.lobbyId, 1000);
    await Promise.all(
      [owner, guest].map((grant) =>
        access.setAcceptance(grant.token, member.lobbyId, acceptance.revision, true, 1000),
      ),
    );
    assert.equal((await host.startMatch(member.lobbyId, request)).type, 'started');
    return {
      host,
      clock,
      member,
      joined,
      owner,
      guest,
      request,
      leaveOwner,
      leaveGuest,
      reporters,
    };
  }

  async function replaceGuest(context: Awaited<ReturnType<typeof setup>>, pause = false) {
    const { host, member, joined, request, clock, leaveGuest } = context;
    await leaveGuest();
    await clock.advanceBy(30001);
    await host.withCurrent(member.lobbyId, request.gameId, async (runtime) => {
      const branch = { branchId: runtime.read().head.branchId };
      assert.equal(
        (
          await runtime.dispatch(
            {
              type: 'propose-bot',
              id: id('command', randomUUID()),
              actorId: member.seatId,
              seatId: joined.seatId,
            },
            branch,
          )
        ).type,
        'accepted',
      );
      const replacing = runtime.dispatch(
        {
          type: 'replacement-vote',
          id: id('command', randomUUID()),
          actorId: member.seatId,
          procedureId: runtime.read().replacementVote!.timer.id,
          vote: 'yes',
        },
        branch,
      );
      const leaving = pause
        ? runtime.dispatch({
            type: 'disconnect',
            id: id('command', randomUUID()),
            seatId: member.seatId,
          })
        : Promise.resolve();
      await replacing;
      await leaving;
      await runtime.observe(async () => {});
    });
  }

  await t.test(
    'runner rollback to null keeps current presence and excludes abandoned knowledge',
    async (t) => {
      const context = await setup(t);
      const { host, member, joined, request, clock, owner } = context;
      await replaceGuest(context);
      await host.withCurrent(member.lobbyId, request.gameId, async (runtime) => {
        const stale = runtime.botAdmission(joined.seatId, new AbortController().signal);
        const old = runtime.read().head;
        const result = await runtime.dispatch({
          type: 'rollback',
          id: id('command', randomUUID()),
          actorId: member.seatId,
          expected: old,
          beforeCommandId: request.id,
          knowledgeWarningAcknowledged: true,
        });
        await runtime.flushCommittedCaptures();
        assert.equal(result.type, 'accepted');
        await runtime.observe(async () => {});
        await runtime.dispatch({
          type: 'disconnect',
          id: id('command', randomUUID()),
          seatId: member.seatId,
        });
        await runtime.flushCommittedCaptures();
        assert.equal(runtime.read().state, null);
        assert.notEqual(runtime.read().head.branchId, old.branchId);
        assert.equal(
          runtime.read().connections.find((p) => p.seatId === joined.seatId)!.controller,
          'bot',
        );
        assert.equal(
          runtime.read().connections.find((p) => p.seatId === member.seatId)!.connected,
          false,
        );
        assert.throws(() => runtime.readBotMemory(joined.seatId), /Invalid bot seat/);
        await assert.rejects(
          runtime.dispatch(
            { type: 'draw-card', id: id('command', randomUUID()), actorId: joined.seatId },
            stale,
          ),
          RuntimeAdmissionError,
        );
      });
      await host.attach(await access.membership(owner.token, member.lobbyId, clock.now()));
      await host.recover(member.lobbyId);
      const current = (await host.read(member.lobbyId))!.snapshot;
      assert.equal(current.state, null);
      assert.equal(current.connections.find((p) => p.seatId === member.seatId)!.connected, true);
      assert.equal(current.connections.find((p) => p.seatId === joined.seatId)!.controller, 'bot');
    },
  );

  await t.test(
    'runner rollback before reveal forgets abandoned trump and preserves live absence',
    async (t) => {
      const context = await setup(t);
      const { host, member, joined, request, clock } = context;
      let finalDraw = id('command', randomUUID());
      await host.withCurrent(member.lobbyId, request.gameId, async (runtime) => {
        for (let i = 0; i < 36; i++) {
          const phase = runtime.read().state!.phase;
          if (phase.type !== 'dealing') assert.fail();
          finalDraw = id('command', randomUUID());
          await runtime.dispatch({ type: 'draw-card', id: finalDraw, actorId: phase.nextSeatId });
          await runtime.flushCommittedCaptures();
        }
        assert.notEqual(runtime.readBotMemory(joined.seatId).trump, null);
      });
      await replaceGuest(context);
      await host.withCurrent(member.lobbyId, request.gameId, async (runtime) => {
        assert.equal(
          (
            await runtime.dispatch({
              type: 'rollback',
              id: id('command', randomUUID()),
              actorId: member.seatId,
              expected: runtime.read().head,
              beforeCommandId: finalDraw,
              knowledgeWarningAcknowledged: true,
            })
          ).type,
          'accepted',
        );
        await runtime.observe(async () => {});
        await runtime.dispatch({
          type: 'disconnect',
          id: id('command', randomUUID()),
          seatId: member.seatId,
        });
        await runtime.flushCommittedCaptures();
        assert.equal(runtime.read().paused, true);
        assert.equal(runtime.read().state!.phase.type, 'dealing');
        assert.equal(runtime.read().state!.deck.length, 1);
        assert.equal(runtime.readBotMemory(joined.seatId).trump, null);
        assert.equal(runtime.readBotMemory(member.seatId).trump, null);
        assert.equal(
          runtime.read().connections.find((p) => p.seatId === joined.seatId)!.controller,
          'bot',
        );
      });
      await clock.advanceBy(20000);
      await host.recover(member.lobbyId);
      await host.withCurrent(member.lobbyId, request.gameId, async (runtime) => {
        assert.equal(runtime.read().state!.deck.length, 1);
        assert.equal(runtime.readBotMemory(joined.seatId).trump, null);
      });
    },
  );

  await t.test(
    'fresh Node host restores a paused bot and resumes a pending ballot exactly once',
    async (t) => {
      const context = await setup(t);
      const { host, member, joined, request, clock, leaveOwner, owner } = context;
      await host.withCurrent(member.lobbyId, request.gameId, async (runtime) => {
        assert.equal(
          (
            await runtime.dispatch({
              type: 'submit-claim',
              id: id('command', randomUUID()),
              actorId: joined.seatId,
              accusedId: member.seatId,
              reason: 'pending across process',
              incident: { type: 'spoken', key: 'fresh-process' },
              scope: 'dealing',
              scopeNumber: 0,
            })
          ).type,
          'accepted',
        );
      });
      await replaceGuest(context, true);
      await leaveOwner();
      await host.close();
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [fileURLToPath(new URL('./testing/recover-host-process.ts', import.meta.url))],
        {
          env: {
            ...process.env,
            PENKY_RECOVERY_LOBBY_ID: member.lobbyId,
            PENKY_RECOVERY_TOKEN: owner.token,
            PENKY_RECOVERY_NOW: String(clock.now()),
          },
          timeout: 15000,
        },
      );
      const result = JSON.parse(stdout) as {
        replies: number;
        vote: string;
        paused: boolean;
        trump: unknown;
      };
      assert.deepEqual(result, { replies: 1, vote: 'abstain', paused: false, trump: null });
    },
  );

  await t.test(
    'late successor not-ready refusal preserves the writer and runner through rollback to dealing',
    async (t) => {
      const context = await setup(t);
      const { host, member, joined, request, owner, guest, clock } = context;
      const firstDraw = id('command', randomUUID());
      const originalRuntime = await host.withCurrent(
        member.lobbyId,
        request.gameId,
        async (runtime) => {
          // Trusted finishing is only a lifecycle precondition, not autonomous-match evidence.
          for (let index = 0; index < 36; index++) {
            const phase = runtime.read().state!.phase;
            if (phase.type !== 'dealing') assert.fail();
            assert.equal(
              (
                await runtime.dispatch({
                  type: 'draw-card',
                  id: index === 0 ? firstDraw : id('command', randomUUID()),
                  actorId: phase.nextSeatId,
                })
              ).type,
              'accepted',
            );
          }
          await clock.advanceBy(10000);
          await finishMatch(runtime);
          return runtime;
        },
      );
      const before = (await host.read(member.lobbyId))!;
      assert.equal(before.snapshot.state!.phase.type, 'finished');
      const consent = await access.lobbyState(owner.token, member.lobbyId, clock.now());
      for (const grant of [owner, guest])
        await access.setAcceptance(
          grant.token,
          member.lobbyId,
          consent.revision,
          true,
          clock.now(),
        );
      const next = {
        ...request,
        id: id('command', randomUUID()),
        expectedGameId: request.gameId,
        expectedHead: before.snapshot.head,
        gameId: id('game', randomUUID()),
        branchId: id('branch', randomUUID()),
      };
      const startSuccessor = PostgresSession.prototype.startSuccessor;
      const prepared = t.mock.method(
        PostgresSession.prototype,
        'startSuccessor',
        async function (this: PostgresSession, ...args: Parameters<typeof startSuccessor>) {
          // This seam is reached only after private successor preparation and queued
          // handoff admission. Withdraw acceptance before the final transactional gate.
          await access.setAcceptance(
            guest.token,
            member.lobbyId,
            consent.revision,
            false,
            clock.now(),
          );
          return Reflect.apply(startSuccessor, this, args);
        },
      );
      try {
        assert.deepEqual(await host.startMatch(member.lobbyId, next), {
          type: 'rejected',
          code: 'not-ready',
        });
        assert.equal(prepared.mock.callCount(), 1);
      } finally {
        prepared.mock.restore();
      }
      const after = (await host.read(member.lobbyId))!;
      assert.equal(after.epoch, before.epoch);
      assert.deepEqual(after.snapshot, before.snapshot);
      assert.equal(
        await host.withCurrent(member.lobbyId, request.gameId, async (runtime) => runtime),
        originalRuntime,
      );
      assert.equal(
        await host.observeHistory(member.lobbyId, request.gameId, async (c) => c.closedRollback),
        false,
      );
      assert.equal(
        (await pool.query('SELECT 1 FROM penky_game_heads WHERE game_id=$1', [next.gameId]))
          .rowCount,
        0,
      );
      assert.equal(
        await (await PostgresLobby.open(pool, member.lobbyId)).startReceipt(next.id),
        null,
      );
      await host.withCurrent(member.lobbyId, request.gameId, async (runtime) => {
        assert.equal(
          (
            await runtime.dispatch({
              type: 'rollback',
              id: id('command', randomUUID()),
              actorId: member.seatId,
              expected: runtime.read().head,
              beforeCommandId: firstDraw,
              knowledgeWarningAcknowledged: true,
            })
          ).type,
          'accepted',
        );
        assert.equal(runtime.read().state!.phase.type, 'dealing');
        assert.equal(runtime.read().state!.deck.length, 36);
      });
      await replaceGuest(context);
      await host.withCurrent(member.lobbyId, request.gameId, async (runtime) => {
        assert.equal(runtime, originalRuntime);
        await runtime.observe(async () => {});
        const draws = (await runtime.checkpoint()).receipts.filter(
          (r) => r.controller === 'bot' && r.command.type === 'draw-card',
        );
        assert.equal(draws.length, 1);
        assert.equal(runtime.read().state!.deck.length, 35);
        assert.equal(runtime.readBotMemory(joined.seatId).gameId, request.gameId);
      });
      assert.equal((await host.read(member.lobbyId))!.epoch, before.epoch);
    },
  );

  await t.test(
    'live dealing runner commits one draw and recovers permitted seat knowledge',
    async (t) => {
      const { host, clock, member, joined, request, leaveGuest } = await setup(t);
      await leaveGuest();
      await clock.advanceBy(30001);
      await host.withCurrent(member.lobbyId, request.gameId, async (runtime) => {
        await runtime.dispatch({
          type: 'propose-bot',
          id: id('command', randomUUID()),
          actorId: member.seatId,
          seatId: joined.seatId,
        });
        await runtime.flushCommittedCaptures();
        await runtime.dispatch({
          type: 'replacement-vote',
          id: id('command', randomUUID()),
          actorId: member.seatId,
          procedureId: runtime.read().replacementVote!.timer.id,
          vote: 'yes',
        });
        await runtime.flushCommittedCaptures();
        await runtime.observe(async () => {});
        const checkpoint = await runtime.checkpoint();
        const draws = checkpoint.receipts.filter(
          (r) => r.controller === 'bot' && r.command.type === 'draw-card',
        );
        assert.equal(draws.length, 1);
        assert.equal(runtime.read().state!.deck.length, 35);
        assert.equal(runtime.readBotMemory(joined.seatId).dealing?.nextSeatId, member.seatId);
      });
      await host.recover(member.lobbyId);
      await host.withCurrent(member.lobbyId, request.gameId, async (runtime) => {
        assert.equal(runtime.read().state!.deck.length, 35);
        // Presence reconciliation has no fresh draw capture: continuity is unknown.
        assert.equal(runtime.readBotMemory(joined.seatId).dealing, null);
        assert.equal(
          (await runtime.checkpoint()).receipts.filter(
            (r) => r.controller === 'bot' && r.command.type === 'draw-card',
          ).length,
          1,
        );
      });
    },
  );

  await t.test(
    'live play runner commits a legal lead, recovers without replay and hands back',
    async (t) => {
      const { host, clock, member, joined, request, leaveOwner, owner } = await setup(t);
      await leaveOwner();
      await clock.advanceBy(30001);
      await host.withCurrent(member.lobbyId, request.gameId, async (runtime) => {
        await runtime.dispatch({
          type: 'propose-bot',
          id: id('command', randomUUID()),
          actorId: joined.seatId,
          seatId: member.seatId,
        });
        await runtime.flushCommittedCaptures();
        await runtime.dispatch({
          type: 'replacement-vote',
          id: id('command', randomUUID()),
          actorId: joined.seatId,
          procedureId: runtime.read().replacementVote!.timer.id,
          vote: 'yes',
        });
        await runtime.flushCommittedCaptures();
        for (let i = 0; i < 18; i++) {
          await runtime.dispatch({
            type: 'draw-card',
            id: id('command', randomUUID()),
            actorId: joined.seatId,
          });
          await runtime.flushCommittedCaptures();
          await runtime.observe(async () => {});
        }
        assert.equal(runtime.read().state!.phase.type, 'trump-reveal');
      });
      await clock.advanceBy(10000);
      await host.withCurrent(member.lobbyId, request.gameId, async (runtime) => {
        await runtime.observe(async () => {});
        const plays = (await runtime.checkpoint()).receipts.filter(
          (r) => r.controller === 'bot' && r.command.type === 'play-card',
        );
        assert.equal(plays.length, 1);
        assert.equal(runtime.read().state!.table.length, 1);
        assert.equal(runtime.read().state!.procedure, null);
      });
      await host.recover(member.lobbyId);
      const binding = await access.membership(owner.token, member.lobbyId, clock.now());
      await host.attach(binding);
      await host.withCurrent(member.lobbyId, request.gameId, async (runtime) => {
        await runtime.observe(async () => {});
        assert.equal(
          (await runtime.checkpoint()).receipts.filter(
            (r) => r.controller === 'bot' && r.command.type === 'play-card',
          ).length,
          1,
        );
        assert.equal(runtime.read().state!.table.length, 1);
        assert.equal(
          runtime.read().connections.find((p) => p.seatId === member.seatId)!.controller,
          'human',
        );
      });
    },
  );

  await t.test(
    'live procedure runner persists explicit abstention and withdrawal consent across recovery',
    async (t) => {
      const { host, clock, member, joined, request, leaveGuest } = await setup(t);
      await host.withCurrent(member.lobbyId, request.gameId, async (runtime) => {
        assert.equal(
          (
            await runtime.dispatch({
              type: 'submit-claim',
              id: id('command', randomUUID()),
              actorId: joined.seatId,
              accusedId: member.seatId,
              reason: 'claimant becomes bot',
              incident: { type: 'spoken', key: 'first' },
              scope: 'dealing',
              scopeNumber: 0,
            })
          ).type,
          'accepted',
        );
      });
      await leaveGuest();
      await clock.advanceBy(30001);
      await host.withCurrent(member.lobbyId, request.gameId, async (runtime) => {
        await runtime.dispatch({
          type: 'propose-bot',
          id: id('command', randomUUID()),
          actorId: member.seatId,
          seatId: joined.seatId,
        });
        await runtime.flushCommittedCaptures();
        await runtime.dispatch({
          type: 'replacement-vote',
          id: id('command', randomUUID()),
          actorId: member.seatId,
          procedureId: runtime.read().replacementVote!.timer.id,
          vote: 'yes',
        });
        await runtime.flushCommittedCaptures();
        for (let i = 0; i < 8; i++) await runtime.observe(async () => {});
        assert.equal(runtime.read().state!.claims[0]!.resolution, 'tied');
        await runtime.dispatch({
          type: 'submit-claim',
          id: id('command', randomUUID()),
          actorId: member.seatId,
          accusedId: joined.seatId,
          reason: 'accused consents',
          incident: { type: 'chat', messageId: 'trusted-fixture-message' },
          scope: 'dealing',
          scopeNumber: 0,
        });
        await runtime.flushCommittedCaptures();
        await runtime.dispatch({
          type: 'request-withdrawal',
          id: id('command', randomUUID()),
          actorId: member.seatId,
          claimId: runtime.read().state!.claims[1]!.claim.id,
        });
        await runtime.flushCommittedCaptures();
        for (let i = 0; i < 8; i++) await runtime.observe(async () => {});
        assert.equal(runtime.read().state!.claims[1]!.resolution, 'withdrawn');
        const commands = (await runtime.checkpoint()).receipts
          .filter((r) => r.controller === 'bot')
          .map((r) => r.command);
        assert.deepEqual(
          commands
            .filter((c) => c.type === 'cast-vote' || c.type === 'withdrawal-response')
            .map((c) => (c.type === 'cast-vote' ? c.vote : c.approve)),
          ['abstain', true],
        );
      });
      await host.recover(member.lobbyId);
      await host.withCurrent(member.lobbyId, request.gameId, async (runtime) => {
        assert.deepEqual(
          runtime.read().state!.claims.map((c) => c.resolution),
          ['tied', 'withdrawn'],
        );
        const responses = (await runtime.checkpoint()).receipts.filter(
          (r) =>
            r.controller === 'bot' &&
            (r.command.type === 'cast-vote' || r.command.type === 'withdrawal-response'),
        );
        assert.equal(responses.length, 2);
      });
    },
  );

  await t.test(
    'live runner replaces an absent seat, refuses once, recovers and returns human control',
    async (t) => {
      const { host, clock, member, joined, request, leaveGuest, guest } = await setup(t);
      await host.withCurrent(member.lobbyId, request.gameId, async (runtime) => {
        assert.equal(
          (
            await runtime.dispatch({
              type: 'draw-card',
              id: id('command', randomUUID()),
              actorId: member.seatId,
            })
          ).type,
          'accepted',
        );
        for (let index = 0; index < 36; index++) {
          const phase = runtime.read().state!.phase;
          if (phase.type !== 'dealing') assert.fail();
          await runtime.dispatch({
            type: 'draw-card',
            id: id('command', randomUUID()),
            actorId: phase.nextSeatId,
          });
          await runtime.flushCommittedCaptures();
        }
        await clock.advanceBy(10000);
        assert.equal(runtime.read().state!.procedure?.type, 'penalty');
      });
      await leaveGuest();
      await clock.advanceBy(30001);
      await host.withCurrent(member.lobbyId, request.gameId, async (runtime) => {
        await runtime.dispatch({
          type: 'propose-bot',
          id: id('command', randomUUID()),
          actorId: member.seatId,
          seatId: joined.seatId,
        });
        await runtime.flushCommittedCaptures();
        await runtime.dispatch({
          type: 'replacement-vote',
          id: id('command', randomUUID()),
          actorId: member.seatId,
          procedureId: runtime.read().replacementVote!.timer.id,
          vote: 'yes',
        });
        await runtime.flushCommittedCaptures();
        await runtime.observe(async () => {});
        assert.equal(runtime.read().state!.procedure, null);
        const checkpoint = await runtime.checkpoint();
        const refusals = checkpoint.receipts.filter((r) => r.command.type === 'penalty-response');
        assert.equal(refusals.length, 1);
        assert.equal(refusals[0]!.controller, 'bot');
      });
      const previous = (await host.read(member.lobbyId))!.epoch;
      await host.recover(member.lobbyId);
      assert.notEqual((await host.read(member.lobbyId))!.epoch, previous);
      await host.withCurrent(member.lobbyId, request.gameId, async (runtime) => {
        assert.equal(
          (await runtime.checkpoint()).receipts.filter((r) => r.command.type === 'penalty-response')
            .length,
          1,
        );
      });
      const leaveAgain = await host.attach(
        await access.membership(guest.token, member.lobbyId, clock.now()),
      );
      t.after(leaveAgain);
      assert.equal(
        (await host.read(member.lobbyId))!.snapshot.connections.find(
          (p) => p.seatId === joined.seatId,
        )!.controller,
        'human',
      );
    },
  );

  await t.test(
    'autonomous refusal commit failure invalidates its writer without another host request',
    { timeout: 10000 },
    async (t) => {
      const { host, clock, member, joined, request, leaveGuest } = await setup(t);
      await host.withCurrent(member.lobbyId, request.gameId, async (runtime) => {
        await runtime.dispatch({
          type: 'draw-card',
          id: id('command', randomUUID()),
          actorId: member.seatId,
        });
        await runtime.flushCommittedCaptures();
        for (let index = 0; index < 36; index++) {
          const phase = runtime.read().state!.phase;
          if (phase.type !== 'dealing') assert.fail();
          await runtime.dispatch({
            type: 'draw-card',
            id: id('command', randomUUID()),
            actorId: phase.nextSeatId,
          });
          await runtime.flushCommittedCaptures();
        }
        await clock.advanceBy(10000);
      });
      await leaveGuest();
      await clock.advanceBy(30001);
      const before = (await host.read(member.lobbyId))!;
      const notices: HostPublication[] = [];
      let invalidate!: () => void;
      const invalidated = new Promise<void>((resolve) => {
        invalidate = resolve;
      });
      const stop = await host.subscribeCommittedCapture(member.lobbyId, (notice) => {
        notices.push(notice);
        if (notice.type === 'invalidated') invalidate();
      });
      t.after(stop);
      const lock = Number.parseInt(randomUUID().slice(0, 8), 16);
      const blocker = await pool.connect();
      const remove = await failFrames(
        t,
        request.gameId,
        `jsonb_path_exists(NEW.payload, '$.checkpoint.receipts[*] ? (@.command.type == "penalty-response")') AND (SELECT true FROM pg_advisory_xact_lock(${lock}::bigint))`,
      );
      await blocker.query('SELECT pg_advisory_lock($1::bigint)', [lock]);
      try {
        await host.withCurrent(member.lobbyId, request.gameId, async (runtime) => {
          await runtime.dispatch({
            type: 'propose-bot',
            id: id('command', randomUUID()),
            actorId: member.seatId,
            seatId: joined.seatId,
          });
          await runtime.flushCommittedCaptures();
          await runtime.dispatch({
            type: 'replacement-vote',
            id: id('command', randomUUID()),
            actorId: member.seatId,
            procedureId: runtime.read().replacementVote!.timer.id,
            vote: 'yes',
          });
          await runtime.flushCommittedCaptures();
        });
        // The host operation is now finished. Only the autonomous commit remains;
        // SQL holds its failure until no host request can discover the fault.
      } finally {
        await blocker.query('SELECT pg_advisory_unlock($1::bigint)', [lock]);
        blocker.release();
      }
      let timeout: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        invalidated,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Autonomous fault did not invalidate writer')),
            3000,
          );
        }),
      ]).finally(() => clearTimeout(timeout));
      assert.equal(notices.at(-1)!.type, 'invalidated');
      assert.equal(notices.at(-1)!.epoch, before.epoch);
      assert.equal(
        notices.some(
          (notice) =>
            notice.type === 'publication' &&
            notice.publication.actions.some((pair) =>
              pair.action.events.some(({ event }) => event.type === 'penalty-answered'),
            ),
        ),
        false,
      );
      const publications = notices.filter((notice) => notice.type === 'publication');
      assert.equal(publications.at(-1)!.publication.snapshot.state!.procedure?.type, 'penalty');
      await writerExited(request.gameId);
      await remove();
      // Recovery must load the durable pre-refusal penalty, then safely reconsider
      // it once with the newly installed runner rather than publishing the draft.
      const recovered = (await host.read(member.lobbyId))!;
      assert.notEqual(recovered.epoch, before.epoch);
      await host.withCurrent(member.lobbyId, request.gameId, async (runtime) => {
        await runtime.observe(async () => {});
        const checkpoint = await runtime.checkpoint();
        assert.equal(
          checkpoint.receipts.filter((r) => r.command.type === 'penalty-response').length,
          1,
        );
        assert.equal(runtime.read().state!.procedure, null);
      });
    },
  );

  await t.test(
    'late start denial remains unauthorized while failed authorization remains unavailable without closing rollback',
    async (t) => {
      const { host, clock, member, owner, request } = await setup(t);
      await host.withCurrent(member.lobbyId, request.gameId, async (runtime) => {
        for (let index = 0; index < 36; index++) {
          const phase = runtime.read().state!.phase;
          if (phase.type !== 'dealing') assert.fail();
          await runtime.dispatch({
            type: 'draw-card',
            id: id('command', randomUUID()),
            actorId: phase.nextSeatId,
          });
          await runtime.flushCommittedCaptures();
        }
        await clock.advanceBy(10000);
        await finishMatch(runtime);
      });
      const before = (await host.read(member.lobbyId))!.snapshot;
      for (const [denyAt, infrastructure] of [
        [2, false],
        [3, false],
        [3, true],
      ] as const) {
        let calls = 0;
        const commandId = id('command', randomUUID());
        await assert.rejects(
          host.startFromIntent(
            member.lobbyId,
            { id: commandId, actorSessionId: member.sessionId, expectedHead: before.head },
            async () => {
              if (++calls === denyAt) {
                if (infrastructure) throw new Error('PRIVATE SQL');
                return null;
              }
              return access.requireOwner(owner.token, member.lobbyId, 1000);
            },
          ),
          (error: unknown) => {
            assert.ok(error instanceof RuntimeAdmissionError);
            assert.equal(error.code, infrastructure ? 'unavailable' : 'unauthorized');
            return true;
          },
        );
        assert.equal(calls, denyAt);
        assert.deepEqual((await host.read(member.lobbyId))!.snapshot, before);
        assert.equal(
          await host.observeHistory(
            member.lobbyId,
            request.gameId,
            async (capture) => capture.closedRollback,
          ),
          false,
        );
        assert.equal(
          await (await PostgresLobby.open(pool, member.lobbyId)).startReceipt(commandId),
          null,
        );
        await host.withCurrent(member.lobbyId, request.gameId, async (runtime) => {
          await runtime.checkpoint();
        });
      }
    },
  );

  await t.test(
    'canonical start retries authorize before lookup and never prepare a second configuration',
    async (t) => {
      const { host, member, request, owner, reporters } = await setup(t);
      const input = { id: request.id, actorSessionId: member.sessionId, expectedHead: null };
      const binding = () => access.requireOwner(owner.token, member.lobbyId, 1000);
      const prepared = reporters.length;
      await assert.rejects(host.startFromIntent(member.lobbyId, input, async () => null));
      const duplicate = await host.startFromIntent(member.lobbyId, input, binding);
      assert.deepEqual(duplicate, { type: 'duplicate', gameId: request.gameId });
      assert.equal(reporters.length, prepared);
      const changed = await host.startFromIntent(
        member.lobbyId,
        { ...input, expectedHead: (await host.read(member.lobbyId))!.snapshot.head },
        binding,
      );
      assert.deepEqual(changed, { type: 'rejected', code: 'command-id-reused' });
      await host.recover(member.lobbyId);
      const restored = reporters.length;
      assert.deepEqual(await host.startFromIntent(member.lobbyId, input, binding), duplicate);
      assert.equal(reporters.length, restored);
    },
  );

  await t.test(
    'owner captures include committed same-head closure and dispatch still enforces it',
    async (t) => {
      const { host, clock, member, request } = await setup(t);
      await host.withCurrent(member.lobbyId, request.gameId, async (runtime) => {
        for (let index = 0; index < 36; index++) {
          const phase = runtime.read().state!.phase;
          if (phase.type !== 'dealing') assert.fail();
          await runtime.dispatch({
            type: 'draw-card',
            id: id('command', randomUUID()),
            actorId: phase.nextSeatId,
          });
          await runtime.flushCommittedCaptures();
        }
        await clock.advanceBy(10000);
        await finishMatch(runtime);
      });
      const before = await host.observeHistory(
        member.lobbyId,
        request.gameId,
        async (capture) => capture,
      );
      assert.equal(before.closedRollback, false);
      await host.withCurrent(member.lobbyId, request.gameId, async (runtime) => {
        assert.equal(await runtime.closeForNextMatch(), true);
      });
      const after = await host.observeHistory(
        member.lobbyId,
        request.gameId,
        async (capture) => capture,
      );
      assert.deepEqual(after.active.head, before.active.head);
      assert.equal(after.closedRollback, true);
      const result = await host.rollback(member.lobbyId, request.gameId, {
        id: id('command', randomUUID()),
        actorId: member.seatId,
        target: {
          expected: { gameId: request.gameId, branch: 1, version: after.active.head.version },
          beforeActionVersion: 1,
        },
        knowledgeWarningAcknowledged: true,
      });
      assert.equal(result.type, 'rejected');
      if (result.type === 'rejected') assert.equal(result.code, 'rollback-closed');
    },
  );

  await t.test(
    'failed durable rollback never publishes a notice or exposes its staged branch to owner capture',
    async (t) => {
      const { host, member, request } = await setup(t);
      const before = await host.observeHistory(
        member.lobbyId,
        request.gameId,
        async (capture) => capture,
      );
      const notices: HostPublication[] = [];
      await host.subscribeCommittedCapture(member.lobbyId, (notice) => {
        notices.push(notice);
      });
      const input = {
        id: id('command', randomUUID()),
        actorId: member.seatId,
        target: {
          expected: { gameId: request.gameId, branch: 1, version: before.active.head.version },
          beforeActionVersion: 1,
        },
        knowledgeWarningAcknowledged: true,
      };
      const remove = await failFrames(t, request.gameId);
      await assert.rejects(host.rollback(member.lobbyId, request.gameId, input));
      await remove();
      await writerExited(request.gameId);
      const recovered = await host.observeHistory(
        member.lobbyId,
        request.gameId,
        async (capture) => capture,
      );
      assert.equal(recovered.archives.length, 0);
      assert.equal(recovered.audit.length, 0);
      assert.equal(recovered.parents.length, 1);
      assert.equal(
        notices.some((notice) => notice.type === 'publication' && notice.rollback !== undefined),
        false,
      );
    },
  );

  await t.test(
    'committed owner captures resolve ordinal rollbacks and stable retries, including before creation',
    async (t) => {
      const { host, member, joined, request } = await setup(t);
      const notices: HostPublication[] = [];
      await host.subscribeCommittedCapture(member.lobbyId, (notice) => {
        notices.push(notice);
      });
      const capture = await host.observeHistory(
        member.lobbyId,
        request.gameId,
        async (capture) => capture,
      );
      assert.equal(capture.ownerId, member.seatId);
      assert.ok(capture.active.head.version >= 1);
      const rollback = {
        id: id('command', randomUUID()),
        actorId: member.seatId,
        target: {
          expected: { gameId: request.gameId, branch: 1, version: capture.active.head.version },
          beforeActionVersion: 1,
        },
        knowledgeWarningAcknowledged: true,
      };
      await assert.rejects(
        host.rollback(member.lobbyId, request.gameId, { ...rollback, actorId: joined.seatId }),
      );
      const first = await host.rollback(member.lobbyId, request.gameId, rollback);
      assert.equal(first.type, 'accepted');
      const empty = await host.observeHistory(
        member.lobbyId,
        request.gameId,
        async (capture) => capture,
      );
      assert.equal(empty.active.head.version, 0);
      assert.equal(empty.ownerId, member.seatId);
      const fresh = notices.filter((notice) => notice.type === 'publication' && notice.rollback);
      assert.equal(fresh.length, 1);
      if (fresh[0]!.type !== 'publication') assert.fail();
      assert.equal(fresh[0]!.rollback!.target.beforeActionVersion, 1);
      assert.ok(Object.isFrozen(fresh[0]!.rollback!.target.expected));
      assert.ok(Object.isFrozen(fresh[0]!.rollback!.target));
      assert.ok(Object.isFrozen(fresh[0]!.rollback!.head));
      const frozenTarget = fresh[0]!.rollback!.target.expected;
      assert.throws(() => Object.assign(frozenTarget, { version: -1 }));
      const late: HostPublication[] = [];
      await host.subscribeCommittedCapture(member.lobbyId, (n) => {
        late.push(n);
      });
      const baseline = late[0]!;
      if (baseline.type !== 'publication') assert.fail();
      assert.equal(baseline.rollback, undefined);
      assert.deepEqual(baseline.publication.actions, []);

      assert.deepEqual(await host.rollback(member.lobbyId, request.gameId, rollback), {
        ...first,
        duplicate: true,
      });
      await host.recover(member.lobbyId);
      assert.deepEqual(await host.rollback(member.lobbyId, request.gameId, rollback), {
        ...first,
        duplicate: true,
      });
      const collision = await host.rollback(member.lobbyId, request.gameId, {
        ...rollback,
        knowledgeWarningAcknowledged: false,
      });
      assert.equal(collision.type, 'rejected');
      if (collision.type === 'rejected') assert.equal(collision.code, 'command-id-reused');
      assert.equal(
        notices.filter((notice) => notice.type === 'publication' && notice.rollback).length,
        1,
      );
    },
  );

  await t.test(
    'loading a ninth writer after capture saturation preserves authoritative routing',
    async (t) => {
      const captures = new CaptureStore();
      const stops = [];
      for (let i = 0; i < 8; i++) {
        const game = await setup(t, captures);
        stops.push(await game.host.subscribeCommittedCapture(game.member.lobbyId, () => {}));
      }
      assert.equal(captures.stats().games, 8);
      const ninth = await setup(t, captures);
      const before = await ninth.host.read(ninth.member.lobbyId);
      assert.ok(before);
      await assert.rejects(
        ninth.host.subscribeCommittedCapture(ninth.member.lobbyId, () => {}),
        /game-unavailable/,
      );
      const result = await ninth.host.withCurrent(
        ninth.member.lobbyId,
        ninth.request.gameId,
        async (runtime) => {
          const phase = runtime.read().state!.phase;
          if (phase.type !== 'dealing') assert.fail();
          return runtime.dispatch({
            type: 'draw-card',
            id: id('command', randomUUID()),
            actorId: phase.nextSeatId,
          });
        },
      );
      assert.equal(result.type, 'accepted');
      assert.equal((await ninth.host.read(ninth.member.lobbyId))!.epoch, before.epoch);
      stops.forEach((stop) => stop());
      const notices: HostPublication[] = [];
      const stop = await ninth.host.subscribeCommittedCapture(ninth.member.lobbyId, (notice) => {
        notices.push(notice);
      });
      assert.equal(notices.length, 1);
      stop();
      assert.equal(captures.stats().bytes, 0);
    },
  );

  await t.test(
    'failed pending owner baseline cannot reinstall a dead owner before fresh registration',
    async (t) => {
      const captures = new CaptureStore();
      const construct = captures.construct;
      const gate = Promise.withResolvers<void>(),
        entered = Promise.withResolvers<void>();
      let blocked = true,
        denyUpdates = true;
      t.mock.method(captures, 'construct', (...[source, deliver]: Parameters<typeof construct>) => {
        if (denyUpdates && source.kind !== 'initial') throw new Error('construction refused');
        return construct(source, async (capture) => {
          if (blocked) {
            entered.resolve();
            await gate.promise;
          }
          deliver(capture);
        });
      });
      t.after(() => gate.resolve());
      const { host, member, request } = await setup(t, captures);
      const runtime = await host.withCurrent(member.lobbyId, request.gameId, async (r) => r);
      const registration = host.subscribeCommittedCapture(member.lobbyId, () =>
        assert.fail('cancelled baseline'),
      );
      const rejected = assert.rejects(registration, /game-unavailable/);
      await entered.promise;
      await runtime.dispatch({
        type: 'disconnect',
        id: id('command', randomUUID()),
        seatId: request.seatIds[1]!,
      });
      gate.resolve();
      await rejected;
      await runtime.flushCommittedCaptures();
      assert.equal(captures.stats().bytes, 0);
      blocked = false;
      denyUpdates = false;
      const notices: HostPublication[] = [];
      const stop = await host.subscribeCommittedCapture(member.lobbyId, (notice) => {
        notices.push(notice);
      });
      await runtime.dispatch({
        type: 'reconnect',
        id: id('command', randomUUID()),
        seatId: request.seatIds[1]!,
      });
      await runtime.flushCommittedCaptures();
      assert.equal(notices.length, 2, 'fresh registration has a live update owner');
      stop();
      assert.equal(captures.stats().bytes, 0);
    },
  );

  await t.test(
    'last shared unsubscribe stops idle ownership before paced rollback captures',
    async (t) => {
      const captures = new CaptureStore();
      const construct = t.mock.method(captures, 'construct');
      const { host, member, request } = await setup(t, captures);
      const runtime = await host.withCurrent(member.lobbyId, request.gameId, async (r) => r);
      const stop = await host.subscribeCommittedCapture(member.lobbyId, () => {});
      stop();
      const calls = construct.mock.callCount();
      for (let i = 0; i < 3; i++) {
        const phase = runtime.read().state!.phase;
        if (phase.type !== 'dealing') assert.fail();
        const commandId = id('command', randomUUID());
        await runtime.dispatch({ type: 'draw-card', id: commandId, actorId: phase.nextSeatId });
        await runtime.dispatch({
          type: 'rollback',
          id: id('command', randomUUID()),
          actorId: member.seatId,
          expected: runtime.read().head,
          beforeCommandId: commandId,
          knowledgeWarningAcknowledged: true,
        });
        await runtime.flushCommittedCaptures();
      }
      assert.equal(
        construct.mock.callCount(),
        calls,
        'no idle source or rollback-sidecar owner remains',
      );
      assert.equal(captures.stats().bytes, 0);
    },
  );

  await t.test(
    'idle capture owners release ninth-game admission while live in-flight handles still pin slots',
    async (t) => {
      const captures = new CaptureStore();
      const games = [];
      for (let i = 0; i < 9; i++) games.push(await setup(t, captures));
      let pinned: CaptureHandle | undefined;
      const stops = [];
      for (let i = 0; i < 8; i++) {
        const game = games[i]!;
        stops.push(
          await game.host.subscribeCommittedCapture(game.member.lobbyId, (notice) => {
            if (i === 0 && notice.type === 'publication') pinned = notice.capture!.retain();
          }),
        );
      }
      assert.equal(captures.stats().games, 8);
      const ninth = games[8]!;
      const before = await ninth.host.read(ninth.member.lobbyId);
      await assert.rejects(
        ninth.host.subscribeCommittedCapture(ninth.member.lobbyId, () => {}),
        /game-unavailable/,
      );
      stops[0]!();
      stops[0]!();
      assert.equal(captures.stats().games, 8);
      await assert.rejects(
        ninth.host.subscribeCommittedCapture(ninth.member.lobbyId, () => {}),
        /game-unavailable/,
      );
      pinned!.release();
      assert.equal(captures.stats().games, 7);
      const notices: HostPublication[] = [];
      const stopNinth = await ninth.host.subscribeCommittedCapture(
        ninth.member.lobbyId,
        (notice) => {
          notices.push(notice);
        },
      );
      const notice = notices[0]!;
      if (notice.type !== 'publication') assert.fail();
      assert.equal(notice.epoch, before!.epoch);
      assert.equal(notice.publication.kind, 'initial');
      assert.deepEqual(notice.publication.actions, []);
      assert.deepEqual(notice.publication.snapshot.head, before!.snapshot.head);
      stops.forEach((stop) => stop());
      stopNinth();
      assert.equal(captures.stats().games, 0);
      assert.equal(captures.stats().handles, 0);
      assert.equal(
        (await games[0]!.host.read(games[0]!.member.lobbyId))!.snapshot.state!.phase.type,
        'dealing',
      );
    },
  );

  await t.test(
    'capture admission refusal clears ownership without rejecting committed play or replacing its writer',
    async (t) => {
      const captures = new CaptureStore({ handles: 4 });
      const { host, member, request } = await setup(t, captures);
      let pinned: CaptureHandle | undefined;
      let reports = 0;
      const stop = await host.subscribeCommittedCapture(
        member.lobbyId,
        (notice) => {
          if (notice.type === 'publication') pinned = notice.capture!.retain();
        },
        () => {
          reports++;
        },
      );
      const before = await host.read(member.lobbyId);
      const result = await host.withCurrent(member.lobbyId, request.gameId, (runtime) => {
        const phase = runtime.read().state!.phase;
        if (phase.type !== 'dealing') assert.fail();
        return runtime.dispatch({
          type: 'draw-card',
          id: id('command', randomUUID()),
          actorId: phase.nextSeatId,
        });
      });
      await host.withCurrent(member.lobbyId, request.gameId, async (runtime) =>
        runtime.flushCommittedCaptures(),
      );
      assert.equal(result.type, 'accepted');
      assert.equal(reports, 1);
      assert.equal((await host.read(member.lobbyId))!.epoch, before!.epoch);
      assert.equal(captures.stats().handles, 1); // only the old active consumer
      stop();
      pinned!.release();
      const baseline: HostPublication[] = [];
      const stopFresh = await host.subscribeCommittedCapture(member.lobbyId, (notice) => {
        baseline.push(notice);
      });
      if (baseline[0]!.type !== 'publication') assert.fail();
      assert.equal(baseline[0]!.publication.kind, 'initial');
      assert.deepEqual(baseline[0]!.publication.actions, []);
      assert.equal(
        baseline[0]!.publication.snapshot.head.version,
        before!.snapshot.head.version + 1,
      );
      stopFresh();
      assert.equal(captures.stats().bytes, 0);
    },
  );

  await t.test(
    'shared capture owner fans out frozen graphs while legacy observers remain detached',
    async (t) => {
      const { host, member, request } = await setup(t);
      const a: HostPublication[] = [],
        b: HostPublication[] = [],
        legacy: HostPublication[] = [];
      const stopA = await host.subscribeCommittedCapture(member.lobbyId, (n) => {
        a.push(n);
      });
      await host.subscribeCommittedCapture(member.lobbyId, (n) => {
        b.push(n);
      });
      await host.subscribe(member.lobbyId, (n) => {
        legacy.push(n);
      });
      await host.withCurrent(member.lobbyId, request.gameId, async (runtime) => {
        const phase = runtime.read().state!.phase;
        if (phase.type !== 'dealing') assert.fail();
        await runtime.dispatch({
          type: 'draw-card',
          id: id('command', randomUUID()),
          actorId: phase.nextSeatId,
        });
        assert.equal(legacy.length, 2, 'legacy host callback precedes dispatch resolution');
        assert.equal(a.length, 1, 'shared host construction remains scheduled');
        await runtime.flushCommittedCaptures();
      });
      const first = a.at(-1)!,
        second = b.at(-1)!,
        detached = legacy.at(-1)!;
      assert.equal(first, second);
      assert.notEqual(first, detached);
      if (first.type !== 'publication' || detached.type !== 'publication') assert.fail();
      assert.ok(Object.isFrozen(first.publication.snapshot.state));
      assert.throws(() => {
        Object.assign(first.publication.snapshot.head, { version: -1 });
      });
      Object.assign(detached.publication.snapshot.head, { version: -1 });
      assert.notEqual(first.publication.snapshot.head.version, -1);
      const late: HostPublication[] = [];
      await host.subscribeCommittedCapture(member.lobbyId, (n) => {
        late.push(n);
      });
      const baseline = late[0]!;
      if (baseline.type !== 'publication') assert.fail();
      assert.equal(baseline.publication.kind, 'initial');
      assert.equal(baseline.publication.snapshot, first.publication.snapshot);
      assert.deepEqual(baseline.publication.actions, []);
      stopA();
      stopA();
      const count = a.length;
      await host.recover(member.lobbyId);
      assert.equal(a.length, count);
      assert.ok(b.some((n) => n.type === 'invalidated'));
      const sharedInvalidation = b.find((n) => n.type === 'invalidated')!;
      const legacyInvalidation = legacy.find((n) => n.type === 'invalidated')!;
      assert.ok(Object.isFrozen(sharedInvalidation));
      assert.equal(Object.isFrozen(legacyInvalidation), false);
      Object.assign(legacyInvalidation, { epoch: 'mutable-legacy' });
      assert.notEqual(sharedInvalidation.epoch, 'mutable-legacy');
      const recovered = b.at(-1)!;
      if (recovered.type !== 'publication') assert.fail();
      assert.notEqual(recovered.epoch, first.epoch);
      assert.equal(recovered.publication.kind, 'initial');
      assert.deepEqual(recovered.publication.actions, []);
    },
  );

  await t.test(
    'late baseline rejects when its existing owner loses finalization before delivery',
    async (t) => {
      const captures = new CaptureStore();
      const construct = captures.construct;
      const writer = captures.writer.bind(captures);
      const ownerEntered = Promise.withResolvers<void>(),
        ownerGate = Promise.withResolvers<void>();
      const baselineEntered = Promise.withResolvers<void>(),
        baselineGate = Promise.withResolvers<void>();
      const ownerFailed = Promise.withResolvers<void>();
      let holdUpdate = false,
        holdBaseline = false,
        refuseUpdate = false;
      t.mock.method(captures, 'construct', (...[source, deliver]: Parameters<typeof construct>) =>
        construct(source, async (capture) => {
          if (holdUpdate && capture.kind === 'update') {
            ownerEntered.resolve();
            await ownerGate.promise;
          }
          if (holdBaseline && capture.kind === 'initial') {
            baselineEntered.resolve();
            await baselineGate.promise;
          }
          deliver(capture);
        }),
      );
      t.mock.method(captures, 'writer', (...args: Parameters<typeof writer>) => {
        const actual = writer(...args);
        return Object.freeze({
          capture: (...input: Parameters<typeof actual.capture>) => {
            if (refuseUpdate && input[0].kind === 'update') {
              refuseUpdate = false;
              throw new Error('injected owner finalization refusal');
            }
            return actual.capture(...input);
          },
        });
      });
      t.after(() => {
        ownerGate.resolve();
        baselineGate.resolve();
      });
      const { host, member, request } = await setup(t, captures);
      const runtime = await host.withCurrent(member.lobbyId, request.gameId, async (r) => r);
      const stopEarly = await host.subscribeCommittedCapture(
        member.lobbyId,
        () => {},
        () => ownerFailed.resolve(),
      );
      t.after(stopEarly);
      holdUpdate = true;
      const phase = runtime.read().state!.phase;
      if (phase.type !== 'dealing') assert.fail();
      const result = await runtime.dispatch({
        type: 'draw-card',
        id: id('command', randomUUID()),
        actorId: phase.nextSeatId,
      });
      assert.equal(result.type, 'accepted');
      await ownerEntered.promise;
      holdBaseline = true;
      const late: HostPublication[] = [];
      const registration = host.subscribeCommittedCapture(member.lobbyId, (notice) => {
        late.push(notice);
      });
      const rejected = assert.rejects(registration, /game-unavailable/);
      await baselineEntered.promise;
      refuseUpdate = true;
      ownerGate.resolve();
      await ownerFailed.promise;
      assert.equal(late.length, 0);
      baselineGate.resolve();
      await rejected;
      await runtime.flushCommittedCaptures();
      assert.equal(
        late.length,
        0,
        'lost owner cannot be replaced by a successful-looking baseline',
      );
      holdUpdate = false;
      holdBaseline = false;
      const fresh: HostPublication[] = [];
      const stopFresh = await host.subscribeCommittedCapture(member.lobbyId, (notice) => {
        fresh.push(notice);
      });
      const next = runtime.read().state!.phase;
      if (next.type !== 'dealing') assert.fail();
      await runtime.dispatch({
        type: 'draw-card',
        id: id('command', randomUUID()),
        actorId: next.nextSeatId,
      });
      await runtime.flushCommittedCaptures();
      assert.equal(fresh.length, 2, 'only explicit fresh registration obtains a live update owner');
      assert.equal(late.length, 0);
      stopFresh();
      stopEarly();
      assert.equal(captures.stats().bytes, 0);
    },
  );

  await t.test(
    'shared late registration waits for scheduled current baseline even with an older owner',
    async (t) => {
      const captures = new CaptureStore();
      const construct = captures.construct;
      const gate = Promise.withResolvers<void>(),
        entered = Promise.withResolvers<void>();
      let blocked = false;
      t.mock.method(captures, 'construct', (...[source, deliver]: Parameters<typeof construct>) =>
        construct(source, async (capture) => {
          if (blocked) {
            entered.resolve();
            await gate.promise;
          }
          deliver(capture);
        }),
      );
      t.after(() => gate.resolve());
      const { host, member, request } = await setup(t, captures);
      const runtime = await host.withCurrent(member.lobbyId, request.gameId, async (r) => r);
      const early: HostPublication[] = [],
        late: HostPublication[] = [];
      await host.subscribeCommittedCapture(member.lobbyId, (notice) => {
        early.push(notice);
      });
      blocked = true;
      const phase = runtime.read().state!.phase;
      if (phase.type !== 'dealing') assert.fail();
      await runtime.dispatch({
        type: 'draw-card',
        id: id('command', randomUUID()),
        actorId: phase.nextSeatId,
      });
      await entered.promise;
      assert.equal(early.length, 1, 'dispatch does not wait for construction');
      let registered = false;
      const registration = host
        .subscribeCommittedCapture(member.lobbyId, (notice) => {
          late.push(notice);
        })
        .then(() => {
          registered = true;
        });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(registered, false, 'registration waits for its own baseline, not an old owner');
      gate.resolve();
      await registration;
      await runtime.flushCommittedCaptures();
      assert.equal(registered, true);
      const baseline = late[0]!,
        update = early.at(-1)!;
      if (baseline.type !== 'publication' || update.type !== 'publication') assert.fail();
      assert.equal(baseline.publication.kind, 'initial');
      assert.deepEqual(baseline.publication.actions, []);
      assert.equal(baseline.publication.sequence, update.publication.sequence);
      assert.deepEqual(baseline.publication.snapshot, runtime.read());
    },
  );

  await t.test(
    'lobby subscriptions invalidate retired writers and rebind state-only after recovery without action replay',
    async (t) => {
      const { host, member, request } = await setup(t);
      const notices: HostPublication[] = [];
      const stop = await host.subscribeCommittedCapture(member.lobbyId, (notice) => {
        notices.push(notice);
      });
      assert.equal(notices[0]!.type, 'publication');
      const first = notices[0]!;
      if (first.type !== 'publication') assert.fail();
      assert.equal(first.publication.kind, 'initial');
      assert.deepEqual(first.publication.actions, []);
      await host.withCurrent(member.lobbyId, request.gameId, async (runtime) => {
        const phase = runtime.read().state!.phase;
        if (phase.type !== 'dealing') assert.fail();
        await runtime.dispatch({
          type: 'draw-card',
          id: id('command', randomUUID()),
          actorId: phase.nextSeatId,
        });
        await runtime.flushCommittedCaptures();
      });
      assert.equal(notices.at(-1)!.type, 'publication');
      await host.recover(member.lobbyId);
      const invalidated = notices.find((notice) => notice.type === 'invalidated');
      assert.equal(invalidated?.epoch, first.epoch);
      assert.ok(Object.isFrozen(invalidated));
      assert.throws(() => Object.assign(invalidated!, { epoch: 'mutated' }));
      const baseline = notices.at(-1)!;
      if (baseline.type !== 'publication') assert.fail();
      assert.notEqual(baseline.epoch, first.epoch);
      assert.equal(baseline.publication.kind, 'initial');
      assert.deepEqual(baseline.publication.actions, []);
      stop();
      stop();
      const count = notices.length;
      await host.recover(member.lobbyId);
      assert.equal(notices.length, count);
    },
  );

  await t.test(
    'held rollback captures retain their original synchronous metadata across a second rollback to null',
    async (t) => {
      const captures = new CaptureStore();
      const construct = captures.construct;
      const gate = Promise.withResolvers<void>();
      let blocked = false;
      t.mock.method(captures, 'construct', (...[source, deliver]: Parameters<typeof construct>) =>
        construct(source, async (capture) => {
          if (blocked) await gate.promise;
          deliver(capture);
        }),
      );
      t.after(() => gate.resolve());
      const { host, member, request } = await setup(t, captures);
      const runtime = await host.withCurrent(member.lobbyId, request.gameId, async (r) => r);
      const seen: HostPublication[] = [];
      await host.subscribeCommittedCapture(member.lobbyId, (notice) => {
        seen.push(notice);
      });
      const phase = runtime.read().state!.phase;
      if (phase.type !== 'dealing') assert.fail();
      await runtime.dispatch({
        type: 'draw-card',
        id: id('command', randomUUID()),
        actorId: phase.nextSeatId,
      });
      await runtime.flushCommittedCaptures();
      const history = await host.observeHistory(
        member.lobbyId,
        request.gameId,
        async (value) => value,
      );
      const targets = [history.active.actions.at(-1)!, history.active.actions[0]!];
      blocked = true;
      const results = [];
      for (const action of targets) {
        const result = await runtime.dispatch({
          type: 'rollback',
          id: id('command', randomUUID()),
          actorId: member.seatId,
          expected: runtime.read().head,
          beforeCommandId: action.commandId,
          knowledgeWarningAcknowledged: true,
        });
        assert.equal(result.type, 'accepted');
        results.push(result.head);
      }
      assert.equal(runtime.read().state, null);
      assert.equal(
        seen.filter((notice) => notice.type === 'publication' && notice.rollback).length,
        0,
      );
      gate.resolve();
      await runtime.flushCommittedCaptures();
      const rollbacks = seen.filter((notice) => notice.type === 'publication' && notice.rollback);
      assert.equal(rollbacks.length, 2);
      for (let i = 0; i < 2; i++) {
        const notice = rollbacks[i]!;
        if (notice.type !== 'publication') assert.fail();
        assert.deepEqual(notice.publication.snapshot.head, results[i]);
        assert.equal(notice.rollback!.head.version, results[i]!.version);
        assert.equal(
          notice.rollback!.target.beforeActionVersion,
          i === 0 ? history.active.actions.length : 1,
        );
        assert.equal(notice.rollback!.actorId, member.seatId);
        assert.equal(Object.isFrozen(notice.rollback!.target.expected), true);
      }
    },
  );

  await t.test(
    'owner capture failure reports to every bound observer without undoing the commit',
    async (t) => {
      const { host, member, request } = await setup(t);
      const runtime = await host.withCurrent(member.lobbyId, request.gameId, async (r) => r);
      const capture = await host.observeHistory(
        member.lobbyId,
        request.gameId,
        async (value) => value,
      );
      const reports: string[] = [];
      const seen: HostPublication[] = [];
      await host.subscribeCommittedCapture(
        member.lobbyId,
        () => {},
        () => {
          reports.push('throwing');
          throw new Error('reporter failure');
        },
      );
      await host.subscribeCommittedCapture(
        member.lobbyId,
        () => {},
        () => {
          reports.push('rejecting');
          return Promise.reject(new Error('async reporter failure'));
        },
      );
      await host.subscribe(
        member.lobbyId,
        (notice) => {
          seen.push(notice);
        },
        () => {
          reports.push('legacy');
        },
      );
      const stop = await host.subscribeCommittedCapture(
        member.lobbyId,
        () => {},
        () => {
          reports.push('unsubscribed');
        },
      );
      stop();
      // Only the owner history capture reads this public method during direct rollback.
      const read = t.mock.method(runtime, 'read', () => {
        throw new Error('injected capture failure');
      });
      try {
        const result = await runtime.dispatch({
          type: 'rollback',
          id: id('command', randomUUID()),
          actorId: member.seatId,
          expected: capture.active.head,
          beforeCommandId: capture.active.actions.at(-1)!.commandId,
          knowledgeWarningAcknowledged: true,
        });
        await runtime.flushCommittedCaptures();
        assert.equal(result.type, 'accepted');
      } finally {
        read.mock.restore();
      }
      assert.deepEqual(reports, ['throwing', 'rejecting', 'legacy']);
      assert.equal(seen.length, 1); // Failure precedes fanout; no partial rollback delivery.
      assert.notEqual(
        (await host.read(member.lobbyId))!.snapshot.head.branchId,
        capture.active.head.branchId,
      );
      await host.recover(member.lobbyId);
      assert.equal(seen.at(-1)!.type, 'publication');
    },
  );

  await t.test(
    'host listener and reporter failures cannot block commits, recovery or other subscriptions',
    async (t) => {
      const { host, member, request } = await setup(t);
      const seen: HostPublication[] = [];
      const stopBad = await host.subscribeCommittedCapture(
        member.lobbyId,
        async () => {
          throw new Error('private listener failure');
        },
        () => {
          return Promise.reject(new Error('private reporter failure'));
        },
      );
      const stopGood = await host.subscribeCommittedCapture(member.lobbyId, (notice) => {
        seen.push(notice);
      });
      await host.withCurrent(member.lobbyId, request.gameId, async (runtime) => {
        const phase = runtime.read().state!.phase;
        if (phase.type !== 'dealing') assert.fail();
        assert.equal(
          (
            await runtime.dispatch({
              type: 'draw-card',
              id: id('command', randomUUID()),
              actorId: phase.nextSeatId,
            })
          ).type,
          'accepted',
        );
      });
      await host.recover(member.lobbyId);
      assert.ok(seen.some((notice) => notice.type === 'invalidated'));
      assert.equal(seen.at(-1)!.type, 'publication');
      stopBad();
      stopGood();
    },
  );

  await t.test(
    'concurrent acquisition shares a writer and epoch; competing hosts respect its lease',
    async (t) => {
      const { host, member, request } = await setup(t);
      const views = await Promise.all(Array.from({ length: 8 }, () => host.read(member.lobbyId)));
      assert.equal(new Set(views.map((view) => view!.epoch)).size, 1);
      const other = new PostgresGameHost(pool);
      t.after(() => other.close());
      await assert.rejects(other.read(member.lobbyId), { message: 'game-unavailable' });
      await assert.rejects(
        host.withCurrent(member.lobbyId, id('game', 'wrong'), async () => assert.fail()),
        { message: 'wrong-game' },
      );
      assert.equal(views[0]!.snapshot.head.gameId, request.gameId);
      await host.close();
      const recovered = await other.read(member.lobbyId);
      assert.ok(recovered);
      assert.notEqual(recovered.epoch, views[0]!.epoch);
      assert.equal(recovered.snapshot.paused, true);
      await assert.rejects(host.read(member.lobbyId), { message: 'host-closed' });
    },
  );

  await t.test(
    'concurrent cold requests perform one restoration and share its baseline epoch',
    async (t) => {
      const { host, member } = await setup(t);
      await host.close();
      const other = new PostgresGameHost(pool);
      t.after(() => other.close());
      const views = await Promise.all(Array.from({ length: 12 }, () => other.read(member.lobbyId)));
      assert.equal(new Set(views.map((view) => view!.epoch)).size, 1);
      assert.equal(
        views[0]!.snapshot.controlEvents.filter((event) => event.type === 'runtime-restored')
          .length,
        1,
      );
      assert.deepEqual(
        views.map((view) => view!.snapshot.head),
        Array(12).fill(views[0]!.snapshot.head),
      );
    },
  );

  await t.test(
    'an aborted attachment queued behind other host work never enters the connection ledger',
    async (t) => {
      const context = await setup(t);
      const binding = await access.membership(context.owner.token, context.member.lobbyId, 1000);
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const blocked = context.host.withCurrent(
        context.member.lobbyId,
        context.request.gameId,
        async () => {
          entered();
          await gate;
        },
      );
      await waiting;
      const controller = new AbortController();
      const attachment = context.host.attach(binding, controller.signal);
      controller.abort();
      release();
      await blocked;
      await assert.rejects(attachment, { name: 'AbortError' });
      await context.leaveOwner();
      assert.equal(
        (await context.host.read(context.member.lobbyId))!.snapshot.paused,
        true,
        'no ghost connection remains after the original departs',
      );
    },
  );

  await t.test(
    'presence counts connections, ignores duplicate detach and reconnects only on transitions',
    async (t) => {
      const context = await setup(t);
      const { host, member, guest, leaveGuest } = context;
      const binding = await access.membership(guest.token, member.lobbyId, 1000);
      const leaveSecond = await host.attach(binding);
      const before = (await host.read(member.lobbyId))!.snapshot.controlEvents.length;
      await leaveGuest();
      await leaveGuest();
      assert.equal((await host.read(member.lobbyId))!.snapshot.paused, false);
      assert.equal((await host.read(member.lobbyId))!.snapshot.controlEvents.length, before);
      await leaveSecond();
      assert.equal((await host.read(member.lobbyId))!.snapshot.paused, true);
      const leaveNew = await host.attach(binding);
      await leaveSecond();
      assert.equal((await host.read(member.lobbyId))!.snapshot.paused, false);
      await leaveNew();
      assert.equal((await host.read(member.lobbyId))!.snapshot.paused, true);
    },
  );

  await t.test(
    'recovery restores durable receipts and a new baseline without replaying actions',
    async (t) => {
      const { host, member, request } = await setup(t);
      const before = (await host.read(member.lobbyId))!;
      const phase = before.snapshot.state!.phase;
      if (phase.type !== 'dealing') assert.fail();
      const command = {
        type: 'draw-card' as const,
        id: id('command', randomUUID()),
        actorId: phase.nextSeatId,
      };
      const accepted = await host.withCurrent(member.lobbyId, request.gameId, (runtime) =>
        runtime.dispatch(command),
      );
      assert.equal(accepted.type, 'accepted');
      await host.recover(member.lobbyId);
      const after = (await host.read(member.lobbyId))!;
      assert.notEqual(after.epoch, before.epoch);
      assert.equal(after.snapshot.paused, false, 'live ledger is reconciled after restore');
      const notices: number[] = [];
      await host.withCurrent(member.lobbyId, request.gameId, (runtime) =>
        runtime.subscribe((notice) => {
          notices.push(notice.actions.length);
        }),
      );
      const duplicate = await host.withCurrent(member.lobbyId, request.gameId, (runtime) =>
        runtime.dispatch(command),
      );
      assert.equal(duplicate.type, 'accepted');
      if (duplicate.type === 'accepted') assert.equal(duplicate.duplicate, true);
      assert.deepEqual(notices, [0]);
    },
  );

  await t.test(
    'faulted callbacks cannot poison current routing or evict a later epoch',
    async (t) => {
      const { host, member, request, reporters } = await setup(t);
      const before = (await host.read(member.lobbyId))!;
      // Simulate a scheduling failure through the real public runtime failure path.
      await assert.rejects(
        host.withCurrent(member.lobbyId, request.gameId, async (runtime) => {
          await runtime.dispatch({
            type: 'disconnect',
            id: id('command', randomUUID()),
            seatId: member.seatId,
          });
          await runtime.flushCommittedCaptures();
          await pool.query(
            'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1',
            [`penky-game:${request.gameId}`],
          );
          // Deliberately catch the dispatch failure: acquisition must detect the
          // poisoned runtime even when an integration callback swallowed its error.
          await runtime
            .dispatch({ type: 'reconnect', id: id('command', randomUUID()), seatId: member.seatId })
            .catch(() => {});
          throw new Error('callback failure');
        }),
      );
      const recovered = (await host.read(member.lobbyId))!;
      assert.notEqual(recovered.epoch, before.epoch);
      const oldReporter = reporters[0]!;
      oldReporter(new Error('late old clock failure'));
      assert.equal((await host.read(member.lobbyId))!.epoch, recovered.epoch);
    },
  );

  await t.test(
    'automatic acquisition detects a fault even if a callback swallowed its dispatch error',
    async (t) => {
      const { host, member, request } = await setup(t);
      const before = (await host.read(member.lobbyId))!;
      await host.withCurrent(member.lobbyId, request.gameId, async (runtime) => {
        await pool.query(
          'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1',
          [`penky-game:${request.gameId}`],
        );
        await runtime
          .dispatch({ type: 'disconnect', id: id('command', randomUUID()), seatId: member.seatId })
          .catch(() => {});
      });
      assert.notEqual((await host.read(member.lobbyId))!.epoch, before.epoch);
    },
  );

  await t.test(
    'failed durable action is not published or retried and the draft is discarded',
    async (t) => {
      const { host, member, request } = await setup(t);
      const before = (await host.read(member.lobbyId))!;
      const phase = before.snapshot.state!.phase;
      if (phase.type !== 'dealing') assert.fail();
      const command = {
        type: 'draw-card' as const,
        id: id('command', randomUUID()),
        actorId: phase.nextSeatId,
      };
      const notices: number[] = [];
      await host.withCurrent(member.lobbyId, request.gameId, (runtime) =>
        runtime.subscribe((notice) => {
          notices.push(notice.actions.length);
        }),
      );
      await pool.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1',
        [`penky-game:${request.gameId}`],
      );
      await assert.rejects(
        host.withCurrent(member.lobbyId, request.gameId, (runtime) => runtime.dispatch(command)),
      );
      assert.deepEqual(notices, [0]);
      const after = (await host.read(member.lobbyId))!;
      assert.deepEqual(after.snapshot.state!.deck, before.snapshot.state!.deck);
      const stored = await PostgresSession.load(pool, request.gameId);
      assert.equal(
        stored!.checkpoint.receipts.some((receipt) => receipt.command.id === command.id),
        false,
      );
      const retry = await host.withCurrent(member.lobbyId, request.gameId, (runtime) =>
        runtime.dispatch(command),
      );
      assert.equal(retry.type, 'accepted');
      if (retry.type === 'accepted') assert.equal(retry.duplicate, false);
    },
  );

  await t.test(
    'failed detach lookup evicts stale presence while retaining the connection departure',
    async (t) => {
      const { host, member, leaveGuest } = await setup(t);
      const before = (await host.read(member.lobbyId))!;
      const query = pool.query;
      let fail = true;
      const mock = t.mock.method(pool, 'query', function (this: Pool, ...args: unknown[]) {
        if (fail && typeof args[0] === 'string' && args[0].includes('FROM penky_lobbies')) {
          fail = false;
          throw new Error('one-shot lookup failure');
        }
        return Reflect.apply(query, this, args);
      });
      await assert.rejects(leaveGuest());
      mock.mock.restore();
      const after = (await host.read(member.lobbyId))!;
      assert.notEqual(after.epoch, before.epoch);
      assert.equal(after.snapshot.paused, true);
      await leaveGuest();
      assert.equal((await host.read(member.lobbyId))!.snapshot.paused, true);
    },
  );

  await t.test(
    'deadline commit faults release the writer and recover without publishing the draft',
    async (t) => {
      const { host, clock, member, request } = await setup(t);
      await host.withCurrent(member.lobbyId, request.gameId, async (runtime) => {
        for (let index = 0; index < 36; index++) {
          const phase = runtime.read().state!.phase;
          if (phase.type !== 'dealing') assert.fail();
          await runtime.dispatch({
            type: 'draw-card',
            id: id('command', randomUUID()),
            actorId: phase.nextSeatId,
          });
          await runtime.flushCommittedCaptures();
        }
      });
      const before = (await host.read(member.lobbyId))!;
      const notices: number[] = [];
      await host.withCurrent(member.lobbyId, request.gameId, (runtime) =>
        runtime.subscribe((notice) => {
          notices.push(notice.actions.length);
        }),
      );
      const remove = await failFrames(t, request.gameId);
      await clock.advanceBy(10000);
      await remove();
      // Do not touch the original host: automatic cleanup must release its live
      // backend/lease even though the runtime consumes the deadline rejection.
      const other = new PostgresGameHost(pool);
      t.after(() => other.close());
      const recovered = (await other.read(member.lobbyId))!;
      assert.notEqual(recovered.epoch, before.epoch);
      assert.equal(recovered.snapshot.state!.phase.type, 'trump-reveal');
      assert.deepEqual(notices, [0]);
    },
  );

  await t.test(
    'corrupt recovery releases acquisition resources and never creates a replacement game',
    async (t) => {
      const { host, member, request } = await setup(t);
      await host.close();
      const stored = await pool.query<{ checksum: string }>(
        'SELECT checksum FROM penky_game_frames WHERE game_id=$1 ORDER BY revision DESC LIMIT 1',
        [request.gameId],
      );
      await pool.query(
        "UPDATE penky_game_frames SET checksum='invalid' WHERE game_id=$1 AND revision=(SELECT revision FROM penky_game_heads WHERE game_id=$1)",
        [request.gameId],
      );
      const other = new PostgresGameHost(pool);
      t.after(() => other.close());
      await assert.rejects(other.read(member.lobbyId), { message: 'game-unavailable' });
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1',
            [`penky-game:${request.gameId}`],
          )
        ).rows[0].count,
        0,
      );
      await pool.query(
        'UPDATE penky_game_frames SET checksum=$2 WHERE game_id=$1 AND revision=(SELECT revision FROM penky_game_heads WHERE game_id=$1)',
        [request.gameId, stored.rows[0]!.checksum],
      );
      // Only the latest frame is read; repairing the deliberately damaged checksum
      // permits a later explicit attempt, not an automatic integrity-error retry.
      assert.equal((await other.read(member.lobbyId))!.snapshot.head.gameId, request.gameId);
    },
  );

  await t.test(
    'presence failure after restoration releases the lease and retains live connection intent',
    async (t) => {
      const { host, member, request, clock } = await setup(t);
      const remove = await failFrames(
        t,
        request.gameId,
        `jsonb_path_exists(NEW.payload, '$.checkpoint.connections[*] ? (@.connected == true)')`,
      );
      await assert.rejects(host.recover(member.lobbyId), { message: 'game-unavailable' });
      await remove();
      await writerExited(request.gameId);
      const other = new PostgresGameHost(pool, {
        inputs: () => ({
          clock,
          randomInt: (upper) => upper - 1,
          nextCommandId: () => id('command', randomUUID()),
        }),
      });
      t.after(() => other.close());
      assert.ok(await other.read(member.lobbyId), 'failed acquisition did not retain its lease');
      await other.close();
      assert.equal((await host.read(member.lobbyId))!.snapshot.paused, false);
    },
  );

  await t.test(
    'shutdown drains queued reads and releases every game even when a checkpoint fails',
    async (t) => {
      const first = await setup(t);
      const second = await setup(t);
      await first.host.close();
      await second.host.close();
      const host = new PostgresGameHost(pool);
      t.after(() => host.close().catch(() => {})); // this test deliberately faults close
      await host.read(first.member.lobbyId);
      await host.read(second.member.lobbyId);
      const remove = await failFrames(t, first.request.gameId);
      const queued = host.read(second.member.lobbyId);
      const closing = host.close();
      const rejected = assert.rejects(closing, { message: 'game-unavailable' });
      assert.ok(await queued);
      await rejected;
      assert.equal(host.close(), closing);
      await assert.rejects(host.read(first.member.lobbyId), { message: 'host-closed' });
      await remove();
      await writerExited(first.request.gameId);
      const other = new PostgresGameHost(pool);
      t.after(() => other.close());
      assert.ok(await other.read(first.member.lobbyId));
      assert.ok(await other.read(second.member.lobbyId));
    },
  );

  await t.test(
    'recovery preserves nested suspended timers and reconciles connected seats',
    async (t) => {
      const { host, clock, member, joined, request } = await setup(t);
      await host.withCurrent(member.lobbyId, request.gameId, async (runtime) => {
        await runtime.dispatch({
          type: 'submit-claim',
          id: id('command', randomUUID()),
          actorId: member.seatId,
          accusedId: joined.seatId,
          reason: 'Spoken incident',
          incident: { type: 'spoken', key: 'episode' },
          scope: 'dealing',
          scopeNumber: 0,
        });
        await runtime.flushCommittedCaptures();
        await clock.advanceBy(4000);
        await runtime.dispatch({
          type: 'request-withdrawal',
          id: id('command', randomUUID()),
          actorId: member.seatId,
          claimId: runtime.read().state!.claims[0]!.claim.id,
        });
        await runtime.flushCommittedCaptures();
        await clock.advanceBy(1000);
        await runtime.checkpoint();
      });
      await host.recover(member.lobbyId);
      const procedure = (await host.read(member.lobbyId))!.snapshot.state!.procedure;
      if (procedure?.type !== 'withdrawal' || !procedure.suspendedVote) assert.fail();
      assert.equal(procedure.timer.remainingMs, 9000);
      assert.equal(procedure.suspendedVote.timer.remainingMs, 6000);
      assert.equal(procedure.suspendedVote.timer.startedAtMs, null);
      await clock.advanceBy(9000);
      assert.equal(
        (await host.read(member.lobbyId))!.snapshot.state!.procedure?.type,
        'claim-vote',
      );
    },
  );

  await t.test(
    'atomic successor is adopted without another lease; old routing and stale bindings fail',
    async (t) => {
      const context = await setup(t);
      const { host, clock, member, request, guest, owner, joined } = context;
      const oldRuntime = await host.withCurrent(
        member.lobbyId,
        request.gameId,
        async (runtime) => runtime,
      );
      await host.withCurrent(member.lobbyId, request.gameId, async (runtime) => {
        for (let index = 0; index < 36; index++) {
          const phase = runtime.read().state!.phase;
          if (phase.type !== 'dealing') assert.fail();
          await runtime.dispatch({
            type: 'draw-card',
            id: id('command', randomUUID()),
            actorId: phase.nextSeatId,
          });
          await runtime.flushCommittedCaptures();
        }
        await clock.advanceBy(10000);
        await finishMatch(runtime);
      });
      const old = (await host.read(member.lobbyId))!;
      const newcomer = await access.issue(1000);
      const newBinding = await access.joinLobby(newcomer.token, member.lobbyId, 1000);
      const leaveNewcomer = await host.attach(newBinding);
      assert.equal(
        (await host.read(member.lobbyId))!.snapshot.connections.length,
        2,
        'lobby membership does not add a participant to an old match',
      );
      const stale = await access.membership(guest.token, member.lobbyId, 1000);
      const next: MatchStart = {
        ...request,
        id: id('command', randomUUID()),
        expectedGameId: request.gameId,
        expectedHead: old.snapshot.head,
        gameId: id('game', randomUUID()),
        branchId: id('branch', randomUUID()),
        seatIds: newBinding.seatIds,
      };
      const acceptance = await access.lobbyState(owner.token, member.lobbyId, 1000);
      await Promise.all(
        [owner, guest, newcomer].map((grant) =>
          access.setAcceptance(grant.token, member.lobbyId, acceptance.revision, true, 1000),
        ),
      );
      const remove = await failFrames(t, request.gameId);
      await assert.rejects(host.startMatch(member.lobbyId, next), { message: 'game-unavailable' });
      await remove();
      assert.equal(
        (
          await pool.query('SELECT current_game_id FROM penky_lobbies WHERE lobby_id=$1', [
            member.lobbyId,
          ])
        ).rows[0].current_game_id,
        request.gameId,
      );
      assert.equal(
        (await pool.query('SELECT 1 FROM penky_game_heads WHERE game_id=$1', [next.gameId]))
          .rowCount,
        0,
        'failed preparation is not adopted or persisted',
      );
      const restored = (await host.read(member.lobbyId))!;
      assert.notEqual(restored.epoch, old.epoch);
      await assert.rejects(
        oldRuntime.dispatch({
          type: 'draw-card',
          id: id('command', randomUUID()),
          actorId: joined.seatId,
        }),
        /Runtime is faulted/,
      );
      const retiringRuntime = await host.withCurrent(
        member.lobbyId,
        request.gameId,
        async (runtime) => runtime,
      );
      const retry = { ...next, expectedHead: restored.snapshot.head };
      assert.equal((await host.startMatch(member.lobbyId, retry)).type, 'started');
      const current = (await host.read(member.lobbyId))!;
      assert.equal(current.snapshot.head.gameId, next.gameId);
      assert.notEqual(current.epoch, old.epoch);
      assert.equal(current.snapshot.paused, false);
      await assert.rejects(
        host.withCurrent(member.lobbyId, request.gameId, async () => assert.fail()),
        { message: 'wrong-game' },
      );
      await assert.rejects(host.attach(stale), { message: 'wrong-game' });
      assert.equal((await host.startMatch(member.lobbyId, retry)).type, 'duplicate');
      assert.equal(current.snapshot.connections.length, 3);
      const retired = await retiringRuntime.dispatch({
        type: 'draw-card',
        id: id('command', randomUUID()),
        actorId: joined.seatId,
      });
      assert.equal(retired.type, 'rejected');
      if (retired.type === 'rejected') assert.equal(retired.code, 'closed');
      await host.withCurrent(member.lobbyId, next.gameId, async (runtime) => {
        for (const seatId of next.seatIds) {
          const memory = runtime.readBotMemory(seatId);
          assert.equal(memory.gameId, next.gameId);
          assert.equal(memory.trump, null);
          assert.equal(memory.opening, null);
        }
      });
      await replaceGuest({ ...context, request: next });
      await host.withCurrent(member.lobbyId, next.gameId, async (runtime) => {
        await runtime.dispatch({
          type: 'replacement-vote',
          id: id('command', randomUUID()),
          actorId: newBinding.seatId,
          procedureId: runtime.read().replacementVote!.timer.id,
          vote: 'yes',
        });
        await runtime.flushCommittedCaptures();
      });
      await host.withCurrent(member.lobbyId, next.gameId, async (runtime) => {
        assert.equal(
          runtime.read().connections.find((p) => p.seatId === joined.seatId)!.controller,
          'bot',
        );
        for (let i = 0; i < 3; i++) {
          await runtime.observe(async () => {});
          if (
            (await runtime.checkpoint()).receipts.some(
              (r) => r.controller === 'bot' && r.command.type === 'draw-card',
            )
          )
            break;
          const phase = runtime.read().state!.phase;
          if (phase.type !== 'dealing') assert.fail();
          assert.notEqual(phase.nextSeatId, joined.seatId);
          await runtime.dispatch({
            type: 'draw-card',
            id: id('command', randomUUID()),
            actorId: phase.nextSeatId,
          });
          await runtime.flushCommittedCaptures();
        }
        assert.equal(
          (await runtime.checkpoint()).receipts.filter(
            (r) => r.controller === 'bot' && r.command.type === 'draw-card',
          ).length,
          1,
        );
        assert.ok(runtime.read().state!.deck.length < 36);
      });

      await leaveNewcomer();
      assert.equal((await host.read(member.lobbyId))!.snapshot.paused, true);
    },
  );
});
