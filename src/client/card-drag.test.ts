import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CardDrag } from './card-drag.ts';
const deck = { type: 'draw-card' } as const;
const hand = { type: 'play-card', cardId: 'opaque-own-card' } as const;
const point = (id = 1, x = 0, y = 0) => ({ pointerId: id, x, y });
test('tap stays native, threshold crossing dispatches original intent once and suppresses the ensuing click', () => {
  const drag = new CardDrag();
  assert.equal(drag.begin(deck, { ...point(), button: 0, isPrimary: true }), true);
  drag.move(point(1, 3, 2));
  assert.equal(drag.finish(point(1, 3, 2), true), null);
  assert.equal(drag.allowClick(deck, 1), true);
  drag.begin(hand, { ...point(), button: 0, isPrimary: true });
  assert.equal(drag.move(point(1, 10, 0)), true);
  assert.deepEqual(drag.finish(point(1, 100, 100), true), hand);
  assert.equal(drag.finish(point(1, 100, 100), true), null);
  assert.equal(
    drag.allowClick(hand, 1),
    false,
    'suppressed even if the command ack has already arrived',
  );
  assert.equal(drag.allowClick(hand, 0), true, 'keyboard/assistive activation remains native');
});
test('outside drop, pointer cancellation, lost capture and reset cancel without command or click fallback', () => {
  for (const reason of ['outside', 'cancel', 'reset', 'capture']) {
    const drag = new CardDrag();
    drag.begin(deck, { ...point(), button: 0, isPrimary: true });
    drag.move(point(1, 20, 0));
    if (reason === 'outside') assert.equal(drag.finish(point(1, 20, 0), false), null);
    else drag.cancel();
    drag.cancel();
    assert.equal(drag.finish(point(1, 100, 100), true), null);
    assert.equal(drag.allowClick(deck, 1), false, reason);
    assert.equal(drag.allowClick(hand, 1), true, 'unrelated source is not suppressed');
    drag.begin(deck, { ...point(2), button: 0, isPrimary: true });
    drag.finish(point(2), false);
    assert.equal(drag.allowClick(deck, 1), true, 'new deliberate pointer press remains usable');
  }
});
test('reset before threshold consumes the held pointer click; keyboard is never mistaken for a drag click', () => {
  const drag = new CardDrag();
  drag.begin(hand, { ...point(), button: 0, isPrimary: true });
  drag.cancel();
  assert.equal(drag.allowClick(hand, 0), true);
  assert.equal(drag.allowClick(hand, 1), false);
  assert.equal(drag.active, null);
});
test('document capture cancellation cannot let a second primary source take over or erase either click token', () => {
  const drag = new CardDrag();
  drag.press(1);
  drag.begin(deck, { ...point(), button: 0, isPrimary: true });
  drag.press(2);
  assert.equal(drag.compete(2), true);
  assert.equal(drag.begin(hand, { ...point(2), button: 0, isPrimary: true }), false);
  drag.end(1);
  drag.press(3);
  assert.equal(drag.compete(3), true, 'remaining cancelled contact keeps the cohort blocked');
  assert.equal(drag.begin(deck, { ...point(3), button: 0, isPrimary: true }), false);
  drag.end(2);
  drag.end(3);
  assert.equal(drag.allowClick(deck, 1, 1), false);
  assert.equal(drag.allowClick(hand, 1, 2), false);
  assert.equal(drag.allowClick(deck, 1, 3), false);
  drag.press(1);
  assert.equal(drag.begin(deck, { ...point(), button: 0, isPrimary: true }), true);
  drag.finish(point(), false);
  assert.equal(drag.allowClick(deck, 1, 1), true);
});
test('nonprimary buttons and competing pointers cannot take over or finish another gesture', () => {
  const drag = new CardDrag();
  assert.equal(drag.begin(deck, { ...point(), button: 2, isPrimary: true }), false);
  assert.equal(drag.begin(deck, { ...point(), button: 0, isPrimary: false }), false);
  drag.begin(deck, { ...point(), button: 0, isPrimary: true });
  assert.equal(drag.move(point(2, 100, 100)), false);
  assert.equal(drag.finish(point(2, 100, 100), true), null);
  assert.equal(drag.begin(hand, { ...point(2), button: 0, isPrimary: false }), false);
  assert.equal(
    drag.finish(point(1, 100, 100), true),
    null,
    'second contact cancels, never retargets',
  );
  assert.equal(drag.allowClick(deck, 1), false);
});
