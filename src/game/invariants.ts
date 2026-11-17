import { RANKS, SUITS, trumpFromLastCard } from './cards.ts';
import type { GameState, Timer } from './model.ts';

/** Diagnostics are server-only: they may identify private card locations. */
export function validateState(state: GameState): readonly string[] {
  const errors: string[] = [];
  if (state.schemaVersion !== 1) errors.push('Unsupported state schema');
  const seatIds = state.players.map((player) => player.id);
  if (seatIds.length < 2 || seatIds.length > 8) errors.push('Expected 2–8 seats');
  if (new Set(seatIds).size !== seatIds.length) errors.push('Duplicate seat IDs');
  if (!seatIds.includes(state.ownerId)) errors.push('Owner must occupy a seat');
  if (state.cards.length !== 36) errors.push('Expected a 36-card catalog');
  const catalogIds = state.cards.map((card) => card.id);
  if (new Set(catalogIds).size !== catalogIds.length) errors.push('Duplicate catalog card IDs');
  const faces = state.cards.map((card) => `${card.face.suit}:${card.face.rank}`);
  if (new Set(faces).size !== 36) errors.push('Expected 36 unique faces');
  if (
    state.cards.some((card) => !SUITS.includes(card.face.suit) || !RANKS.includes(card.face.rank))
  ) {
    errors.push('Unknown card face');
  }
  const locations = [
    ...state.deck,
    ...state.table,
    ...state.discard,
    ...state.players.flatMap((player) => [...player.hand, ...player.stumps]),
  ];
  if (locations.length !== 36) errors.push('Expected exactly 36 located cards');
  if (new Set(locations).size !== locations.length)
    errors.push('A card occupies multiple locations');
  const catalog = new Set(catalogIds);
  if (locations.some((card) => !catalog.has(card))) errors.push('Unknown located card');
  if (catalogIds.some((card) => !locations.includes(card)))
    errors.push('A catalog card has no location');
  for (const player of state.players) {
    if (player.stumps.length > 2) errors.push('A player has more than two stumps');
    if (player.status === 'won' && (player.hand.length > 0 || player.stumps.length > 0)) {
      errors.push('An exited player still owns cards');
    }
  }
  if (!Number.isSafeInteger(state.createdAtMs) || state.createdAtMs < 0)
    errors.push('Invalid creation time');
  if (!Number.isSafeInteger(state.completedRounds) || state.completedRounds < 0)
    errors.push('Invalid round count');
  if (state.phase.type === 'dealing') {
    if (!seatIds.includes(state.phase.nextSeatId)) errors.push('Unknown next recipient');
    if (state.phase.drawCount !== 36 - state.deck.length)
      errors.push('Draw count disagrees with deck');
    if (state.phase.drawCount < 0 || state.phase.drawCount >= 36)
      errors.push('Invalid dealing count');
    if (state.table.length !== 0 || state.discard.length !== 0)
      errors.push('Table/discard occupied during dealing');
    const expectedStumps = Math.min(state.phase.drawCount, state.players.length * 2);
    if (
      state.players.reduce((count, player) => count + player.stumps.length, 0) !== expectedStumps
    ) {
      errors.push('Dealing placed cards in the wrong destination');
    }
    if (state.trump !== null) errors.push('Trump assigned before the last draw');
  } else if (state.deck.length !== 0) {
    errors.push('The deck must be empty after dealing');
  }
  if (state.phase.type === 'trump-reveal') {
    const phase = state.phase;
    const recipient = state.players.find((player) => player.id === phase.recipientId);
    if (!recipient?.hand.includes(phase.cardId))
      errors.push('Revealed card must be in its recipient hand');
    const card = state.cards.find((card) => card.id === phase.cardId);
    if (card === undefined || state.trump !== trumpFromLastCard(card.face))
      errors.push('Trump disagrees with revealed card');
    errors.push(...validateTimer(phase.timer));
    if (state.players.some((player) => player.stumps.length !== 2))
      errors.push('Incomplete stump dealing at reveal');
  }
  if (state.phase.type === 'pre-game-penalties') {
    if (!seatIds.includes(state.phase.firstLeaderId)) errors.push('Unknown first leader');
    if (state.pendingPenalties.length === 0 && state.procedure === null)
      errors.push('No pending pre-game penalty');
  }
  if (state.phase.type === 'between-rounds') {
    const leaderId = state.phase.leaderId;
    if (!state.players.some((player) => player.id === leaderId && player.status === 'active'))
      errors.push('Invalid next leader');
    if (state.phase.nextRoundNumber !== state.completedRounds + 1)
      errors.push('Invalid next round number');
    if (state.table.length !== 0) errors.push('Table must be empty between rounds');
  }
  const activeIds = state.players
    .filter((player) => player.status === 'active')
    .map((player) => player.id);
  if (state.phase.type === 'round') {
    const phase = state.phase;
    if (
      phase.targetSize !== phase.participantIds.length ||
      phase.targetSize < 2 ||
      phase.targetSize > 8
    )
      errors.push('Round target disagrees with participants');
    if (JSON.stringify(phase.participantIds) !== JSON.stringify(activeIds))
      errors.push('Round participants disagree with active seats');
    if (!phase.participantIds.includes(phase.turnSeatId)) errors.push('Unknown round turn');
    if (phase.number !== state.completedRounds + 1) errors.push('Invalid active round number');
    if (state.table.length < 1 || state.table.length >= phase.targetSize)
      errors.push('Unsettled round table size');
  }
  if (
    state.phase.type === 'between-rounds' &&
    state.players.some(
      (player) =>
        player.status === 'active' && player.hand.length === 0 && player.stumps.length === 0,
    )
  )
    errors.push('Empty participant not finalized at boundary');
  if (state.phase.type === 'finished') {
    const result = state.phase.result;
    if (result.type === 'all-won' && activeIds.length !== 0)
      errors.push('All-won result still has participants');
    if (
      result.type === 'last-player' &&
      (activeIds.length !== 1 || activeIds[0] !== result.loserId)
    )
      errors.push('Last-player result disagrees with participants');
    if (
      result.type === 'draw' &&
      (activeIds.length < 2 ||
        JSON.stringify(result.remainingSeatIds) !== JSON.stringify(activeIds))
    )
      errors.push('Draw result disagrees with participants');
    if (
      (result.type !== 'draw' && state.table.length !== 0) ||
      state.procedure !== null ||
      state.pendingPenalties.length !== 0
    )
      errors.push('Finished game still has pending play');
    if (result.type === 'draw' && state.table.length >= activeIds.length)
      errors.push('Unsettled draw table size');
  }
  if (new Set(state.openingRights.map((right) => right.seatId)).size !== state.openingRights.length)
    errors.push('Duplicate opening right');
  for (const right of state.openingRights) {
    if (
      !state.players.some(
        (player) =>
          player.id === right.seatId && player.status === 'active' && player.stumps.length > 0,
      )
    )
      errors.push('Opening right without an active stump owner');
    if (
      (state.phase.type !== 'between-rounds' &&
        state.phase.type !== 'round' &&
        !(state.phase.type === 'finished' && state.phase.result.type === 'draw')) ||
      right.throughRound !== state.completedRounds + 1
    )
      errors.push('Expired or invalid opening right');
  }
  if (
    state.peekedStumps.some((peek) => !seatIds.includes(peek.seatId) || !catalog.has(peek.cardId))
  )
    errors.push('Unknown private peek seat/card');
  if (
    Object.values(state.repetitions).some(
      (count) => !Number.isSafeInteger(count) || count < 1 || count > 3,
    )
  )
    errors.push('Invalid repetition count');
  if (
    state.lastRepetitionKey !== null &&
    !Object.hasOwn(state.repetitions, state.lastRepetitionKey)
  )
    errors.push('Last repetition state has no occurrence');
  if (state.pendingPenalties.some((penalty) => !seatIds.includes(penalty.recipientId)))
    errors.push('Unknown penalty recipient');
  if (
    new Set(state.pendingPenalties.map((penalty) => penalty.incidentId)).size !==
    state.pendingPenalties.length
  )
    errors.push('Duplicate pending incident');
  if (state.procedure !== null) errors.push(...validateTimer(state.procedure.timer));
  if (state.procedure?.type === 'penalty') {
    const procedure = state.procedure;
    const donors = activeIds.filter((seat) => seat !== procedure.penalty.recipientId);
    if (!activeIds.includes(procedure.penalty.recipientId))
      errors.push('Invalid penalty recipient');
    if (JSON.stringify(procedure.eligibleSeatIds) !== JSON.stringify(donors))
      errors.push('Invalid penalty donors');
    if (Object.keys(procedure.responses).some((seat) => !donors.some((donor) => donor === seat)))
      errors.push('Unknown penalty response seat');
    for (const [seatId, response] of Object.entries(procedure.responses)) {
      if (response === undefined || response === 'refuse') continue;
      const player = state.players.find((player) => player.id === seatId);
      if (!player || player.hand.length < 2 || !player.hand.includes(response))
        errors.push('Invalid reserved penalty card');
    }
  }
  return errors;
}

function validateTimer(timer: Timer): string[] {
  const errors: string[] = [];
  if (!Number.isSafeInteger(timer.remainingMs) || timer.remainingMs < 0)
    errors.push('Invalid timer remaining time');
  if (
    timer.startedAtMs !== null &&
    (!Number.isSafeInteger(timer.startedAtMs) || timer.startedAtMs < 0)
  )
    errors.push('Invalid timer start time');
  return errors;
}
