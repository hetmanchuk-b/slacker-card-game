import type { CommandId } from '../game/ids.ts';
import type { ChatMessage } from '../persistence/lobby-contracts.ts';
import type { ChatPage } from '../protocol/contracts.ts';
import { makeChatPage } from '../protocol/messages.ts';

/** Match outbound's framing allowance. Preserve exact rows and an ordered prefix;
 * never skip/truncate an oversized row or return a misleading empty page for it.
 */
export function boundedChatPage(
  requestId: CommandId,
  messages: readonly ChatMessage[],
  maxBytes: number,
): ChatPage {
  const size = (page: ChatPage) => Buffer.byteLength(JSON.stringify(page)) + 128;
  let page = makeChatPage(requestId, []);
  if (size(page) > maxBytes) throw new Error('Chat page unavailable');
  for (const message of messages) {
    const next = {
      ...page,
      messages: [...page.messages, ...makeChatPage(requestId, [message]).messages],
    };
    if (size(next) > maxBytes) {
      if (!page.messages.length) throw new Error('Chat page unavailable');
      break;
    }
    page = next;
  }
  return page;
}
