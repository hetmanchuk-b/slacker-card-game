export const SUITS = ['clubs', 'diamonds', 'hearts', 'spades'] as const;
export const RANKS = [6, 7, 8, 9, 10, 11, 12, 13, 14] as const;

export type Suit = (typeof SUITS)[number];
export type Rank = (typeof RANKS)[number];
export type Trump = Exclude<Suit, 'spades'> | null;
export type Card = Readonly<{ suit: Suit; rank: Rank }>;

export function createDeck(): Card[] {
  return SUITS.flatMap((suit) => RANKS.map((rank) => ({ suit, rank })));
}

export function trumpFromLastCard(card: Card): Trump {
  return card.suit === 'spades' ? null : card.suit;
}

/** Pure rule evaluation; illegal attempts are handled by the game engine. */
export function canBeat(top: Card, played: Card, trump: Trump): boolean {
  if (top.suit === played.suit) {
    return played.rank > top.rank || (played.rank === 6 && top.rank === 14);
  }
  return top.suit !== 'spades' && played.suit === trump;
}
