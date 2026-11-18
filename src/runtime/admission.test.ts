import assert from 'node:assert/strict';
import { test } from 'node:test';
import { id } from '../game/ids.ts';
import { GameRuntime, RuntimeAdmissionError } from './runtime.ts';
import { fixture } from './testing/fixtures.ts';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test('denied admission changes no state, receipt, commit or timer and does not fault the runtime', async () => {
  const { options, clock, seats } = fixture('reveal');
  let commits = 0;
  const runtime = await GameRuntime.create({
    ...options,
    commit: async () => {
      commits++;
    },
  });
  const before = runtime.read();
  const saved = commits;
  const command = {
    type: 'open-stump' as const,
    id: id('command', 'denied'),
    actorId: seats[0]!,
    cardId: before.state!.players[0]!.stumps[0]!,
  };
  await assert.rejects(runtime.dispatch(command, { admit: () => false }), RuntimeAdmissionError);
  assert.deepEqual(runtime.read(), before);
  assert.equal(commits, saved);
  await clock.advanceBy(10000);
  assert.equal(runtime.read().state!.phase.type, 'between-rounds');
  assert.equal(
    (await runtime.checkpoint()).receipts.some((receipt) => receipt.command.id === command.id),
    false,
  );
  await runtime.dispose();
});

test('admission runs after preceding queued work and before cached receipt disclosure', async () => {
  const { options, seats } = fixture('vote');
  const runtime = await GameRuntime.create(options);
  const procedure = runtime.read().state!.procedure;
  if (procedure?.type !== 'claim-vote') assert.fail();
  const command = {
    type: 'cast-vote' as const,
    id: id('command', 'ballot'),
    actorId: seats[0]!,
    procedureId: procedure.timer.id,
    vote: 'abstain' as const,
  };
  assert.equal((await runtime.dispatch(command)).type, 'accepted');
  const before = runtime.read();
  const pending = gate();
  const entered = gate();
  const blocked = runtime.observe(async () => {
    entered.release();
    await pending.promise;
  });
  await entered.promise;
  let authorized = true;
  const retry = runtime.dispatch(command, { admit: () => authorized });
  authorized = false;
  pending.release();
  await blocked;
  await assert.rejects(retry, RuntimeAdmissionError);
  assert.deepEqual(runtime.read(), before);
  const accepted = await runtime.dispatch(command, { admit: () => true });
  assert.equal(accepted.type, 'accepted');
  if (accepted.type === 'accepted') assert.equal(accepted.duplicate, true);
  await runtime.dispose();
});

test('async failed or throwing guards redact errors and preserve the queue, snapshots and deadline', async () => {
  const { options, clock, seats } = fixture('reveal');
  let commits = 0;
  const runtime = await GameRuntime.create({
    ...options,
    commit: async () => {
      commits++;
    },
  });
  const before = runtime.read();
  const saved = commits;
  const command = {
    type: 'take-bottom' as const,
    id: id('command', 'guard-errors'),
    actorId: seats[0]!,
  };
  for (const admit of [
    () => {
      throw new Error('PRIVATE GUARD DIAGNOSTIC');
    },
    async () => {
      throw new Error('PRIVATE SQL DIAGNOSTIC');
    },
  ]) {
    await assert.rejects(runtime.dispatch(command, { admit }), (error: unknown) => {
      assert.ok(error instanceof RuntimeAdmissionError);
      assert.equal(error.message, 'Runtime admission denied');
      assert.equal(error.code, 'unavailable');
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  await assert.rejects(
    runtime.dispatch(command, {
      admit: async (snapshot) => {
        (snapshot.connections[0] as { connected: boolean }).connected = false;
        await Promise.resolve();
        return false;
      },
    }),
    RuntimeAdmissionError,
  );
  assert.deepEqual(runtime.read(), before);
  assert.equal(commits, saved);
  await clock.advanceBy(10000);
  assert.equal(runtime.read().state!.phase.type, 'between-rounds');
  await runtime.dispose();
});

test('a command already admitted finishes its atomic commit even if authorization changes during storage', async () => {
  const { options, seats } = fixture('vote');
  const storage = gate();
  const saving = gate();
  let block = false;
  const runtime = await GameRuntime.create({
    ...options,
    commit: async () => {
      if (block) {
        saving.release();
        await storage.promise;
      }
    },
  });
  const procedure = runtime.read().state!.procedure;
  if (procedure?.type !== 'claim-vote') assert.fail();
  let authorized = true;
  block = true;
  const dispatch = runtime.dispatch(
    {
      type: 'cast-vote',
      id: id('command', 'admitted'),
      actorId: seats[0]!,
      procedureId: procedure.timer.id,
      vote: 'yes',
    },
    { admit: () => authorized },
  );
  await saving.promise;
  authorized = false;
  storage.release();
  assert.equal((await dispatch).type, 'accepted');
  assert.equal(
    (await runtime.checkpoint()).receipts.some((receipt) => receipt.command.id === 'admitted'),
    true,
  );
  await runtime.dispose();
});
