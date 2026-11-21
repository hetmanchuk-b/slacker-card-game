import { createHash } from 'node:crypto';
import type { CommandId } from '../game/ids.ts';
import type { OwnerHistoryView } from '../projections/history.ts';
import type {
  Delivery,
  OwnerHistoryCursor,
  OwnerHistoryEntry,
  OwnerHistoryPageMessage,
} from './contracts.ts';

/** Input MUST be the complete allowlisted projectOwnerHistory result, never a
 * private capture. Stateless pages bound wire bytes, not projection CPU/memory.
 */
export function makeOwnerHistoryPage(
  view: OwnerHistoryView,
  requestId: CommandId,
  delivery: Delivery,
  cursor: OwnerHistoryCursor | null,
  limit: number,
  maxBytes: number,
): OwnerHistoryPageMessage {
  const envelope = {
    protocolVersion: 1 as const,
    type: 'owner-history-page' as const,
    requestId,
    delivery: { epoch: delivery.epoch, sequence: delivery.sequence },
  };
  const failure = (type: 'stale' | 'unavailable'): OwnerHistoryPageMessage => ({
    ...envelope,
    result: { type },
  });
  const snapshot = createHash('sha256')
    .update('owner-history-page-v1\n')
    .update(JSON.stringify(view))
    .digest('hex');
  if (cursor && cursor.snapshot !== snapshot) return failure('stale');
  const entries: OwnerHistoryEntry[] = [];
  for (const branch of view.branches) {
    entries.push({
      type: 'branch',
      branch: { head: branch.head, label: branch.label, parent: branch.parent },
    });
    for (const action of branch.actions)
      entries.push({ type: 'action', branch: branch.head.branch, action });
  }
  for (const rollback of view.rollbacks) entries.push({ type: 'rollback', rollback });
  const offset = cursor?.offset ?? 0;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    (cursor && offset >= entries.length) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    return failure('unavailable');
  let best: OwnerHistoryPageMessage | null = null;
  for (let end = offset + 1; end <= Math.min(entries.length, offset + limit); end++) {
    const candidate: OwnerHistoryPageMessage = {
      ...envelope,
      result: {
        type: 'page',
        head: view.head,
        rollbackOpen: view.rollbackOpen,
        snapshot,
        entries: entries.slice(offset, end),
        next: end < entries.length ? { snapshot, offset: end } : null,
      },
    };
    if (Buffer.byteLength(JSON.stringify(candidate)) + 128 <= maxBytes) best = candidate;
  }
  return best ?? failure('unavailable');
}
