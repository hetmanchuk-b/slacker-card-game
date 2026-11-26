import assert from 'node:assert/strict';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { id } from '../game/ids.ts';
import { GameRuntime } from '../runtime/runtime.ts';
import type { RuntimePublication } from '../runtime/runtime.ts';
import { fixture } from '../runtime/testing/fixtures.ts';
import { CaptureStore } from './capture-store.ts';

// Synthetic repetition-growth diagnostic, not a valid played match or capacity
// acceptance. It keeps full private position strings and exercises the actual
// estimator and provisional 2MiB publication/4MiB peer-debt candidates.
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
test('capture-store long repetition candidate profile (synthetic, not match acceptance)', async (t) => {
  const { options } = fixture('vote', 4);
  const runtime = await GameRuntime.create(options);
  let template: RuntimePublication | undefined;
  await runtime.subscribeCommittedCapture((p) => {
    template = p;
  });
  await runtime.dispose();
  const lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();
  for (const positions of [64, 512, 1024, 2048]) {
    const store = new CaptureStore();
    const writer = store.writer('profile', template!.snapshot.head.gameId);
    let prior = structuredClone(template!.snapshot.state!);
    const repetitions = Object.fromEntries(
      Array.from({ length: positions }, (_, i) => [`private-position-${i}:${'x'.repeat(400)}`, 1]),
    );
    prior = { ...prior, repetitions };
    const next = { ...prior, repetitions: { ...repetitions, 'private-next-position': 1 } };
    const head = template!.snapshot.head;
    const source = {
      ...template!,
      snapshot: {
        ...template!.snapshot,
        head: { ...head, version: head.version + 1 },
        state: next,
      },
      actions: [
        {
          before: { head, state: prior },
          after: { head: { ...head, version: head.version + 1 }, state: next },
          // Estimator fixture only: no action is projected or represented as gameplay.
          action: { commandId: id('command', 'profile'), occurredAtMs: 1000, events: [] },
          delivery: 'fresh',
        },
      ],
    } as RuntimePublication;
    const start = performance.now();
    const capture = freeze(structuredClone(source));
    const cloneFreezeMs = performance.now() - start;
    const sizingStart = performance.now();
    let bytes = 0,
      denied = false,
      highWater = 0;
    try {
      const owner = writer.capture(capture);
      bytes = owner.bytes;
      const peers = Array.from({ length: 4 }, () => owner.retain());
      highWater = store.stats().bytes;
      assert.equal(store.stats().handles, 5);
      peers.forEach((peer) => peer.release());
      owner.release();
    } catch {
      denied = true;
    }
    const sizingMs = performance.now() - sizingStart;
    assert.equal(store.stats().bytes, 0);
    assert.equal(store.stats().roots, 0);
    t.diagnostic(
      JSON.stringify({
        positions,
        bytes,
        denied,
        twoPeerJobsFit4MiB: !denied && bytes * 2 <= 4 * 1024 * 1024,
        threePeerJobsFit4MiB: !denied && bytes * 3 <= 4 * 1024 * 1024,
        highWater,
        cloneFreezeMs,
        sizingMs,
        heapUsed: process.memoryUsage().heapUsed,
        rss: process.memoryUsage().rss,
      }),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 12));
  }
  lag.disable();
  t.diagnostic(
    `eventLoopDelayMaxMs=${lag.max / 1e6}; runtime/source scratch and GC/RSS are not ledger bytes`,
  );
});
