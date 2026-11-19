import assert from 'node:assert/strict';
import { test } from 'node:test';
import { id } from '../game/ids.ts';
import { GameRuntime } from '../runtime/runtime.ts';
import { fixture } from '../runtime/testing/fixtures.ts';
import { resolveClaimEvidence } from './claim-evidence.ts';
import type { ClaimRequest } from '../runtime/runtime.ts';
import type { ChatMessage } from '../persistence/lobby-contracts.ts';

const lobby = id('lobby', 'evidence-lobby');
test('action evidence uses the initiating actor and original pre-action dealing scope', async () => {
  const { options, seats } = fixture('reveal');
  const runtime = await GameRuntime.create(options);
  const request = {
    type: 'submit-claim' as const,
    id: id('command', 'report-draw'),
    actorId: seats[0]!,
    accusedId: seats[1]!,
    reason: 'Observed action',
    incident: { type: 'action' as const, commandId: id('command', 'draw-0') },
  };
  const result = await runtime.dispatchClaim(request, async (capture) =>
    resolveClaimEvidence(request, capture, lobby, null),
  );
  assert.equal(result.type, 'accepted');
  const claim = runtime.read().state!.claims.at(-1)!.claim;
  assert.equal(claim.scope, 'dealing');
  assert.equal(claim.scopeNumber, 0);
  const mismatch = { ...request, id: id('command', 'mismatch'), accusedId: seats[0]! };
  const denied = await runtime.dispatchClaim(mismatch, async (capture) =>
    resolveClaimEvidence(mismatch, capture, lobby, null),
  );
  assert.equal(denied.type, 'rejected');
  if (denied.type === 'rejected') assert.equal(denied.code, 'invalid-claim');
  await runtime.dispose();
});

test('system/unknown actions are invalid evidence and automatic violations cannot be punished twice', async () => {
  const { options, seats } = fixture('penalty');
  const runtime = await GameRuntime.create(options);
  for (const [commandId, code] of [
    ['wrong-draw', 'incident-already-handled'],
    ['reveal-done', 'invalid-claim'],
    ['unknown', 'invalid-claim'],
  ] as const) {
    const request: ClaimRequest = {
      type: 'submit-claim',
      id: id('command', `report-${commandId}`),
      actorId: seats[1]!,
      accusedId: seats[0]!,
      reason: 'Action',
      incident: { type: 'action', commandId: id('command', commandId) },
    };
    const result = await runtime.dispatchClaim(request, async (capture) =>
      resolveClaimEvidence(request, capture, lobby, null),
    );
    assert.equal(result.type, 'rejected');
    if (result.type === 'rejected') assert.equal(result.code, code);
  }
  assert.equal(runtime.read().state!.claims.length, 0);
  await runtime.dispose();
});

test('the first lead belongs to its new round, and a final pickup cannot be relabeled into the next gap', async () => {
  const { options, seats, clock } = fixture('reveal');
  const runtime = await GameRuntime.create(options);
  await clock.advanceBy(10000);
  let state = runtime.read().state!;
  if (state.phase.type !== 'between-rounds') assert.fail();
  const leader = state.phase.leaderId;
  const leadId = id('command', 'first-lead');
  await runtime.dispatch({
    type: 'play-card',
    id: leadId,
    actorId: leader,
    cardId: state.players.find((player) => player.id === leader)!.hand[0]!,
  });
  const request: ClaimRequest = {
    type: 'submit-claim',
    id: id('command', 'lead-claim'),
    actorId: seats[0]!,
    accusedId: leader,
    reason: 'Lead episode',
    incident: { type: 'action', commandId: leadId },
  };
  const lead = await runtime.dispatchClaim(request, async (capture) =>
    resolveClaimEvidence(request, capture, lobby, null),
  );
  assert.equal(lead.type, 'accepted');
  assert.equal(runtime.read().state!.claims[0]!.claim.scope, 'round');
  await clock.advanceBy(10000);
  state = runtime.read().state!;
  if (state.phase.type !== 'round') assert.fail();
  const taker = state.phase.turnSeatId;
  const takeId = id('command', 'final-pickup');
  assert.equal(
    (await runtime.dispatch({ type: 'take-bottom', id: takeId, actorId: taker })).type,
    'accepted',
  );
  const late = {
    ...request,
    id: id('command', 'late'),
    accusedId: taker,
    incident: { type: 'action' as const, commandId: takeId },
  };
  const result = await runtime.dispatchClaim(late, async (capture) =>
    resolveClaimEvidence(late, capture, lobby, null),
  );
  assert.equal(result.type, 'rejected');
  if (result.type === 'rejected') assert.equal(result.code, 'scope-closed');
  await runtime.dispose();
});

test('chat evidence retains original author, scope, game and nested inherited-prefix provenance', async () => {
  const { options, seats, history } = fixture('reveal');
  const runtime = await GameRuntime.create(options);
  const original = runtime.read().head;
  const request: ClaimRequest = {
    type: 'submit-claim',
    id: id('command', 'chat-claim'),
    actorId: seats[0]!,
    accusedId: seats[1]!,
    reason: 'Chat',
    incident: { type: 'chat', messageId: 'message' },
  };
  const chat: ChatMessage = {
    id: id('message', 'message'),
    authorSessionId: id('session', 'author'),
    authorSeatId: seats[1]!,
    text: 'Original',
    lobbyId: lobby,
    sequence: '1',
    atMs: 1000,
    context: { head: { ...original, version: 2 }, scope: 'dealing', scopeNumber: 0 },
  };
  const check = (message: ChatMessage | null) =>
    resolveClaimEvidence(
      request,
      {
        snapshot: runtime.read(),
        history: history.read(),
        branches: history.branches(),
      },
      lobby,
      message,
    );
  assert.deepEqual(check(chat), { type: 'resolved', scope: 'dealing', scopeNumber: 0 });
  for (const changed of [
    null,
    { ...chat, authorSeatId: seats[0]! },
    { ...chat, lobbyId: id('lobby', 'other') },
    { ...chat, context: { ...chat.context, head: { ...original, gameId: id('game', 'other') } } },
  ])
    assert.deepEqual(check(changed), { type: 'rejected', code: 'invalid-claim' });
  await runtime.dispatch({
    type: 'rollback',
    id: id('command', 'fork-one'),
    actorId: seats[0]!,
    expected: runtime.read().head,
    beforeCommandId: id('command', 'draw-35'),
    knowledgeWarningAcknowledged: true,
  });
  assert.deepEqual(check(chat), { type: 'resolved', scope: 'dealing', scopeNumber: 0 });
  assert.deepEqual(check({ ...chat, context: { ...chat.context, head: original } }), {
    type: 'rejected',
    code: 'invalid-claim',
  });
  const child = runtime.read().head;
  await runtime.dispatch(
    {
      type: 'rollback',
      id: id('command', 'fork-two'),
      actorId: seats[0]!,
      expected: child,
      beforeCommandId: id('command', 'draw-1'),
      knowledgeWarningAcknowledged: true,
    },
    { branchId: child.branchId },
  );
  assert.deepEqual(check(chat), { type: 'resolved', scope: 'dealing', scopeNumber: 0 });
  assert.deepEqual(
    check({ ...chat, context: { ...chat.context, head: { ...original, version: 3 } } }),
    { type: 'rejected', code: 'invalid-claim' },
  );
  assert.deepEqual(check({ ...chat, context: { ...chat.context, head: child } }), {
    type: 'rejected',
    code: 'invalid-claim',
  });
  await runtime.dispose();
});
