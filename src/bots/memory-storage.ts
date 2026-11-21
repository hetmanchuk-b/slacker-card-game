import type { BotMemory } from './memory.ts';
import type { BranchHead } from '../game/contracts.ts';
import type { CommandId, SeatId } from '../game/ids.ts';
import type { History } from '../persistence/history.ts';

/** FIFO knowledge-only retention; evicted rollback targets restore unknown. */
export const BOT_MEMORY_CHECKPOINT_CAPACITY = 256;
export type BotMemoryStorage = Readonly<{
  schemaVersion: 1;
  current: readonly BotMemory[];
  beforeCommands: readonly Readonly<{
    commandId: CommandId;
    head: BranchHead;
    memories: readonly BotMemory[];
  }>[];
}>;

/** Fail closed before recovery can consume any persisted knowledge. */
export function validateBotMemoryStorage(
  value: BotMemoryStorage,
  history: History,
  seats: readonly SeatId[],
): void {
  const fail = (): never => {
    throw new Error('Invalid bot memory checkpoint');
  };
  const keys = (x: object, expected: string[]) =>
    Object.keys(x).sort().join() === expected.sort().join();
  const natural = (x: number) => Number.isSafeInteger(x) && x >= 0;
  const branches = history.branches();
  function ancestor(source: BranchHead, target: BranchHead): boolean {
    if (
      !source ||
      !keys(source, ['gameId', 'branchId', 'version']) ||
      !natural(source.version) ||
      source.gameId !== target.gameId
    )
      return false;
    let cursor: BranchHead | null = target;
    while (cursor) {
      if (cursor.branchId === source.branchId) return source.version <= cursor.version;
      cursor = branches.find((branch) => branch.head.branchId === cursor!.branchId)?.parent ?? null;
    }
    return false;
  }
  function memories(items: readonly BotMemory[], head: BranchHead) {
    if (
      !Array.isArray(items) ||
      items.length !== seats.length ||
      items.length > 8 ||
      new Set(items.map((m) => m?.seatId)).size !== items.length
    )
      fail();
    for (const m of items) {
      if (
        !m ||
        !keys(m, ['gameId', 'seatId', 'head', 'trump', 'dealing', 'opening', 'phase']) ||
        m.gameId !== head.gameId ||
        !seats.includes(m.seatId) ||
        (m.head !== null &&
          (!ancestor(m.head, head) ||
            m.head.branchId !== head.branchId ||
            m.head.version !== head.version)) ||
        (m.phase !== null &&
          !(
            /^(dealing|trump-reveal|pre-game-penalties|finished):$/.test(m.phase) ||
            (/^(round|between-rounds):[1-9]\d*$/.test(m.phase) &&
              natural(Number(m.phase.split(':')[1])))
          ))
      )
        fail();
      for (const source of [m.trump, m.dealing, m.opening])
        if (source !== null && (!m.head || !ancestor(source.head, head))) fail();
      if (
        m.trump !== null &&
        (!keys(m.trump, ['head', 'suit']) ||
          ![null, 'clubs', 'diamonds', 'hearts'].includes(m.trump.suit))
      )
        fail();
      if (
        m.dealing !== null &&
        (!keys(m.dealing, ['head', 'nextSeatId', 'successfulDraws']) ||
          !seats.includes(m.dealing.nextSeatId) ||
          (m.dealing.successfulDraws !== null &&
            (!natural(m.dealing.successfulDraws) || m.dealing.successfulDraws > 36)))
      )
        fail();
      if (
        m.opening !== null &&
        (!keys(m.opening, ['head', 'round', 'available']) ||
          !natural(m.opening.round) ||
          typeof m.opening.available !== 'boolean')
      )
        fail();
    }
  }
  if (
    !value ||
    !keys(value, ['schemaVersion', 'current', 'beforeCommands']) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.beforeCommands) ||
    value.beforeCommands.length > BOT_MEMORY_CHECKPOINT_CAPACITY ||
    new Set(value.beforeCommands.map((item) => item?.commandId)).size !==
      value.beforeCommands.length
  )
    fail();
  memories(value.current, history.read().head);
  for (const item of value.beforeCommands) {
    if (
      !item ||
      !keys(item, ['commandId', 'head', 'memories']) ||
      typeof item.commandId !== 'string' ||
      !item.commandId.trim() ||
      !branches.some((branch) => ancestor(item.head, branch.head)) ||
      history.read(item.head.branchId).actions[item.head.version]?.commandId !== item.commandId
    )
      fail();
    memories(item.memories, item.head);
  }
}
