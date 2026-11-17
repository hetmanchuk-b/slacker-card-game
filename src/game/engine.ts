import { createDeck, trumpFromLastCard } from './cards.ts';
import { id } from './ids.ts';
import { applyClaimEvent, automaticClaimEvent, decideClaimCommand, incidentKey } from './claims.ts';
import { automaticRepetitionEvent, recordRepetition } from './repetition.ts';
import { validateState } from './invariants.ts';
import {
  applyRoundEvent,
  automaticRoundEvent,
  decideRoundCommand,
  enterBetweenRounds,
} from './rounds.ts';
import { applyPenaltyEvent, automaticPenaltyEvent, decidePenaltyCommand } from './penalties.ts';
import type {
  ActionBatch,
  Decision,
  DecisionContext,
  DomainEvent,
  GameCommand,
} from './contracts.ts';
import type { CommandId } from './ids.ts';
import type { GameState } from './model.ts';

export { validateState } from './invariants.ts';

export function decide(
  state: GameState | null,
  command: GameCommand,
  context: DecisionContext,
): Decision {
  const decision = decideCommand(state, command, context);
  if (decision.type === 'rejected') return decision;
  const events = [...decision.action.events];
  let next = applyAction(state, decision.action);
  let automatic = automaticEvent(next, command.id, events.length);
  while (automatic !== null) {
    const envelope = { id: id('event', `${command.id}:${events.length}`), event: automatic };
    events.push(envelope);
    next = applyAction(next, { ...decision.action, events: [envelope] });
    automatic = automaticEvent(next, command.id, events.length);
  }
  return { ...decision, action: { ...decision.action, events } };
}

function automaticEvent(state: GameState, commandId: CommandId, index: number): DomainEvent | null {
  return (
    automaticPenaltyEvent(state, id('procedure', `${commandId}:${index}:penalty`)) ??
    automaticClaimEvent(state, id('procedure', `${commandId}:${index}:claim`)) ??
    automaticRoundEvent(state) ??
    automaticRepetitionEvent(state)
  );
}

function decideCommand(
  state: GameState | null,
  command: GameCommand,
  context: DecisionContext,
): Decision {
  if (!Number.isSafeInteger(context.nowMs) || context.nowMs < (state?.createdAtMs ?? 0)) {
    return { type: 'rejected', code: 'invalid-time' };
  }
  if (
    command.type === 'submit-claim' ||
    command.type === 'cast-vote' ||
    command.type === 'expire-claim-vote' ||
    command.type === 'request-withdrawal' ||
    command.type === 'withdrawal-response' ||
    command.type === 'expire-withdrawal'
  )
    return decideClaimCommand(state, command, context);
  if (command.type === 'penalty-response' || command.type === 'expire-penalty') {
    return decidePenaltyCommand(state, command, context);
  }
  if (
    command.type === 'play-card' ||
    command.type === 'take-bottom' ||
    command.type === 'open-stump'
  ) {
    return decideRoundCommand(state, command, context);
  }
  if (command.type === 'expire-reveal') {
    if (state === null) return { type: 'rejected', code: 'not-started' };
    if (state.phase.type !== 'trump-reveal') return { type: 'rejected', code: 'wrong-phase' };
    if (state.procedure !== null) return { type: 'rejected', code: 'procedure-active' };
    const timer = state.phase.timer;
    if (timer.id !== command.timerId) return { type: 'rejected', code: 'stale-timer' };
    if (timer.startedAtMs === null || context.nowMs - timer.startedAtMs < timer.remainingMs) {
      return { type: 'rejected', code: 'timer-not-due' };
    }
    return {
      type: 'accepted',
      outcome: 'played',
      action: {
        commandId: command.id,
        occurredAtMs: context.nowMs,
        events: [
          {
            id: id('event', `${command.id}:0`),
            event: { type: 'reveal-finished', timerId: command.timerId },
          },
        ],
      },
    };
  }
  if (command.type === 'draw-card') {
    if (state === null) return { type: 'rejected', code: 'not-started' };
    if (!state.players.some((player) => player.id === command.actorId))
      return { type: 'rejected', code: 'unknown-seat' };
    if (state.phase.type !== 'dealing') return { type: 'rejected', code: 'wrong-phase' };
    if (state.procedure !== null) return { type: 'rejected', code: 'procedure-active' };
    if (command.actorId !== state.phase.nextSeatId) {
      return {
        type: 'accepted',
        outcome: 'violation',
        action: {
          commandId: command.id,
          occurredAtMs: context.nowMs,
          events: [
            {
              id: id('event', `${command.id}:0`),
              event: {
                type: 'out-of-turn-draw',
                seatId: command.actorId,
                cardId: state.deck[0]!,
                reinsertionIndex: boundedRandom(context, state.deck.length),
              },
            },
          ],
        },
      };
    }
    return {
      type: 'accepted',
      outcome: 'played',
      action: {
        commandId: command.id,
        occurredAtMs: context.nowMs,
        events: [
          {
            id: id('event', `${command.id}:0`),
            event: {
              type: 'card-drawn',
              seatId: command.actorId,
              cardId: state.deck[0]!,
              destination: state.phase.drawCount < state.players.length * 2 ? 'stump' : 'hand',
            },
          },
        ],
      },
    };
  }
  if (state !== null) return { type: 'rejected', code: 'already-started' };
  if (
    command.seatIds.length < 2 ||
    command.seatIds.length > 8 ||
    new Set(command.seatIds).size !== command.seatIds.length ||
    !command.seatIds.includes(command.ownerId) ||
    command.cardIds.length !== 36 ||
    new Set(command.cardIds).size !== 36
  ) {
    return { type: 'rejected', code: 'invalid-configuration' };
  }
  const faces = createDeck();
  const cards = command.cardIds.map((cardId, index) => ({ id: cardId, face: faces[index]! }));
  const deck = [...command.cardIds];
  for (let index = deck.length - 1; index > 0; index--) {
    const other = boundedRandom(context, index + 1);
    [deck[index], deck[other]] = [deck[other]!, deck[index]!];
  }
  const firstRecipientId = command.seatIds[boundedRandom(context, command.seatIds.length)]!;
  return {
    type: 'accepted',
    outcome: 'played',
    action: {
      commandId: command.id,
      occurredAtMs: context.nowMs,
      events: [
        {
          id: id('event', `${command.id}:0`),
          event: {
            type: 'game-started',
            gameId: command.gameId,
            ownerId: command.ownerId,
            seatIds: [...command.seatIds],
            cards,
            deck,
            firstRecipientId,
          },
        },
      ],
    },
  };
}

function boundedRandom(context: DecisionContext, upper: number): number {
  const value = context.randomInt(upper);
  if (!Number.isInteger(value) || value < 0 || value >= upper) {
    throw new RangeError('Random source returned a value outside its declared range');
  }
  return value;
}

/** Applies a trusted committed action. Never pass raw client input to replay. */
export function applyAction(state: GameState | null, action: ActionBatch): GameState {
  if (
    !Number.isSafeInteger(action.occurredAtMs) ||
    action.occurredAtMs < (state?.createdAtMs ?? 0)
  ) {
    throw new Error('Invalid action timestamp');
  }
  if (action.events.length === 0) throw new Error('An action must contain at least one event');
  if (new Set(action.events.map((item) => item.id)).size !== action.events.length) {
    throw new Error('Duplicate event IDs within an action');
  }
  let next = state;
  for (const { event } of action.events) {
    switch (event.type) {
      case 'reveal-resumed':
      case 'withdrawal-requested':
      case 'withdrawal-started':
      case 'withdrawal-answered':
      case 'withdrawal-expired':
      case 'withdrawal-resolved':
      case 'claim-submitted':
      case 'claim-vote-started':
      case 'claim-vote-cast':
      case 'claim-vote-expired':
      case 'claim-vote-resolved': {
        if (next === null) throw new Error('Claim before game creation');
        next = applyClaimEvent(next, event, action.occurredAtMs);
        break;
      }
      case 'repetition-checked': {
        if (next === null) throw new Error('Repetition before game creation');
        next = recordRepetition(next);
        break;
      }
      case 'penalty-started':
      case 'penalty-answered':
      case 'penalty-expired':
      case 'penalty-completed': {
        if (next === null) throw new Error('Penalty before game creation');
        next = applyPenaltyEvent(next, event, action.occurredAtMs);
        break;
      }
      case 'card-played':
      case 'stump-opened':
      case 'bottom-taken':
      case 'violation-detected': {
        if (next === null) throw new Error('Round event before game creation');
        next = applyRoundEvent(next, event);
        break;
      }
      case 'reveal-finished': {
        if (next === null || next.phase.type !== 'trump-reveal')
          throw new Error('Reveal completion outside reveal');
        const timer = next.phase.timer;
        if (
          timer.id !== event.timerId ||
          timer.startedAtMs === null ||
          action.occurredAtMs - timer.startedAtMs < timer.remainingMs
        ) {
          throw new Error('Reveal timer is not due');
        }
        next =
          next.pendingPenalties.length > 0
            ? {
                ...next,
                phase: { type: 'pre-game-penalties', firstLeaderId: next.phase.recipientId },
              }
            : enterBetweenRounds(next, next.phase.recipientId);
        break;
      }
      case 'out-of-turn-draw': {
        if (next === null || next.phase.type !== 'dealing')
          throw new Error('Draw violation outside dealing');
        if (
          event.seatId === next.phase.nextSeatId ||
          !next.players.some((player) => player.id === event.seatId) ||
          event.cardId !== next.deck[0]
        ) {
          throw new Error('Invalid draw violation');
        }
        if (
          !Number.isInteger(event.reinsertionIndex) ||
          event.reinsertionIndex < 0 ||
          event.reinsertionIndex >= next.deck.length
        ) {
          throw new Error('Invalid reinsertion position');
        }
        const deck = next.deck.slice(1);
        deck.splice(event.reinsertionIndex, 0, event.cardId);
        next = {
          ...next,
          deck,
          automaticIncidents: [
            ...new Set([
              ...next.automaticIncidents,
              incidentKey({ type: 'action', commandId: action.commandId }),
            ]),
          ],
          pendingPenalties: [
            ...next.pendingPenalties,
            {
              incidentId: action.commandId,
              recipientId: event.seatId,
              reason: 'draw-out-of-turn',
            },
          ],
        };
        break;
      }
      case 'card-drawn': {
        if (next === null || next.phase.type !== 'dealing') throw new Error('Draw outside dealing');
        if (event.seatId !== next.phase.nextSeatId || event.cardId !== next.deck[0])
          throw new Error('Draw disagrees with dealing order');
        const destination = next.phase.drawCount < next.players.length * 2 ? 'stump' : 'hand';
        if (event.destination !== destination) throw new Error('Wrong draw destination');
        const playerIndex = next.players.findIndex((player) => player.id === event.seatId);
        const nextPlayer = next.players[(playerIndex + 1) % next.players.length]!;
        const deck = next.deck.slice(1);
        const face = next.cards.find((card) => card.id === event.cardId)!.face;
        next = {
          ...next,
          deck,
          players: next.players.map((player) =>
            player.id !== event.seatId
              ? player
              : {
                  ...player,
                  hand: destination === 'hand' ? [...player.hand, event.cardId] : player.hand,
                  stumps:
                    destination === 'stump' ? [...player.stumps, event.cardId] : player.stumps,
                },
          ),
          trump: deck.length === 0 ? trumpFromLastCard(face) : next.trump,
          phase:
            deck.length === 0
              ? {
                  type: 'trump-reveal',
                  cardId: event.cardId,
                  recipientId: event.seatId,
                  timer: {
                    id: id('procedure', `${action.commandId}:reveal`),
                    remainingMs: 10000,
                    startedAtMs: action.occurredAtMs,
                  },
                }
              : { type: 'dealing', nextSeatId: nextPlayer.id, drawCount: next.phase.drawCount + 1 },
        };
        break;
      }
      case 'game-started': {
        if (next !== null) throw new Error('Cannot start an existing game');
        next = {
          schemaVersion: 1,
          gameId: event.gameId,
          ownerId: event.ownerId,
          createdAtMs: action.occurredAtMs,
          cards: structuredClone(event.cards),
          players: event.seatIds.map((seatId) => ({
            id: seatId,
            hand: [],
            stumps: [],
            status: 'active',
          })),
          deck: [...event.deck],
          table: [],
          discard: [],
          trump: null,
          phase: { type: 'dealing', nextSeatId: event.firstRecipientId, drawCount: 0 },
          procedure: null,
          pendingPenalties: [],
          claims: [],
          automaticIncidents: [],
          completedRounds: 0,
          openingRights: [],
          repetitions: {},
          lastRepetitionKey: null,
          peekedStumps: [],
        };
        break;
      }
      default: {
        const unknownEvent: never = event;
        throw new Error(`Unknown domain event: ${JSON.stringify(unknownEvent)}`);
      }
    }
  }
  if (next === null) throw new Error('Action did not produce a game');
  const errors = validateState(next);
  if (errors.length > 0) throw new Error(`Invalid replay state: ${errors.join('; ')}`);
  return next;
}
