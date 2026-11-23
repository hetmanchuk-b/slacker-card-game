import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { id } from '../../game/ids.ts';
import { FakeClock } from '../../runtime/testing/fake-clock.ts';
import { PostgresGameHost } from '../game-host.ts';
import { PostgresGuestAccess } from '../guest-access.ts';

const pool = new Pool({ connectionString: process.env.PENKY_TEST_DATABASE_URL });
const clock = new FakeClock(Number(process.env.PENKY_RECOVERY_NOW));
const host = new PostgresGameHost(pool, {
  inputs: () => ({
    clock,
    randomInt: (upper) => upper - 1,
    nextCommandId: () => id('command', randomUUID()),
  }),
});
try {
  const lobbyId = id('lobby', process.env.PENKY_RECOVERY_LOBBY_ID!);
  const before = (await host.read(lobbyId))!;
  if (!before.snapshot.paused) throw new Error('Fresh process must start without humans');
  let initialActions = -1;
  const stop = await host.subscribe(lobbyId, (notice) => {
    if (initialActions === -1 && notice.type === 'publication')
      initialActions = notice.publication.actions.length;
  });
  stop();
  if (initialActions !== 0) throw new Error('Recovery replayed historical actions');
  await host.withCurrent(lobbyId, before.snapshot.head.gameId, async (runtime) => {
    const receipts = (await runtime.checkpoint()).receipts;
    if (
      !receipts.some((r) => r.command.type === 'submit-claim') ||
      !receipts.some((r) => r.command.type === 'replacement-vote')
    )
      throw new Error('Lost durable claim or replacement receipt');
    if (receipts.some((r) => r.controller === 'bot' && r.command.type === 'cast-vote'))
      throw new Error('Bot responded without a connected human');
  });
  const access = new PostgresGuestAccess(pool);
  await host.attach(
    await access.membership(process.env.PENKY_RECOVERY_TOKEN!, lobbyId, clock.now()),
  );
  const current = (await host.read(lobbyId))!;
  await host.withCurrent(lobbyId, current.snapshot.head.gameId, async (runtime) => {
    for (let i = 0; i < 6; i++) await runtime.observe(async () => {});
    const replies = (await runtime.checkpoint()).receipts.filter(
      (r) => r.controller === 'bot' && r.command.type === 'cast-vote',
    );
    const bot = runtime.read().connections.find((p) => p.controller === 'bot')!;
    const command = replies[0]?.command;
    process.stdout.write(
      JSON.stringify({
        replies: replies.length,
        vote: command?.type === 'cast-vote' ? command.vote : null,
        paused: runtime.read().paused,
        trump: runtime.readBotMemory(bot.seatId).trump,
      }),
    );
  });
} finally {
  await host.close();
  await pool.end();
}
