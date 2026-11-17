import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canBeat, createDeck, RANKS, SUITS, trumpFromLastCard } from './cards.ts';
import type { Trump } from './cards.ts';

test('deck contains exactly 36 unique cards', () => {
  const deck = createDeck();
  assert.equal(deck.length, 36);
  assert.equal(new Set(deck.map(card => `${card.suit}:${card.rank}`)).size, 36);
  assert.notEqual(createDeck(), deck);
});

test('last spade means no trump; other suits become trump', () => {
  for (const suit of SUITS) {
    assert.equal(trumpFromLastCard({ suit, rank: 6 }), suit === 'spades' ? null : suit);
  }
});

test('all same-suit rank pairs follow ascending strength plus six over ace', () => {
  for (const suit of SUITS) {
    for (const top of RANKS) {
      for (const played of RANKS) {
        assert.equal(
          canBeat({ suit, rank: top }, { suit, rank: played }, null),
          played > top || (played === 6 && top === 14),
          `${suit}: ${played} against ${top}`,
        );
      }
    }
  }
});

test('all cross-suit pairs respect trump and absolute spade isolation', () => {
  const trumps: Trump[] = [null, 'clubs', 'diamonds', 'hearts'];
  for (const trump of trumps) {
    for (const topSuit of SUITS) {
      for (const playedSuit of SUITS) {
        if (topSuit === playedSuit) continue;
        for (const top of RANKS) {
          for (const played of RANKS) {
            assert.equal(
              canBeat({ suit: topSuit, rank: top }, { suit: playedSuit, rank: played }, trump),
              topSuit !== 'spades' && playedSuit === trump,
              `${playedSuit}:${played} against ${topSuit}:${top}, trump=${trump}`,
            );
          }
        }
      }
    }
  }
});
