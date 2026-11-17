# Open decisions discovered during implementation

## D001 — Repetition entirely inside one round

**Status:** approved and resolved in specification revision 1.3. No open product decision remains for D001.

The original criterion checked only settled round boundaries. It covered scenario 16 but missed states recurring inside one round. The approved extension checks settled states after gameplay actions as well.

### Minimal reproducer

Three participants, no trump, no stumps. A round is already active with target N = 3. The table contains A♥ (ace of hearts), and A is next.

- Player A: 6♥, 6♣.
- Player B: 7♣.
- Player C: 7♥, 8♣.
- All other cards are in discard.

| Action | Table, bottom to top | Effect |
| --- | --- | --- |
| A plays 6♥ | A♥, 6♥ | Six legally beats same-suit ace |
| B takes bottom A♥ | 6♥ | B now owns the ace |
| C plays 7♥ | 6♥, 7♥ | Seven legally beats six |
| A takes bottom 6♥ | 7♥ | A recovers the six |
| B plays A♥ | 7♥, A♥ | Ace legally beats seven |
| C takes bottom 7♥ | A♥ | C recovers the seven; A is next |

The same meaningful state returns after six actions. Table size alternates between 1 and 2: it never reaches 0 or N = 3. Extra club cards prevent automatic pickups from changing the cycle. If the initial state was observed after C's opening ace, its third occurrence is after twelve further actions. The updated engine declares a draw there, preserving the table card.

### Current behavior

- Both boundary and in-round repetition are implemented.
- `src/game/repetition.test.ts` verifies the former six-action loop now draws, without discarding or moving its table card.
- `src/game/match.test.ts` runs complete deterministic matches for all supported seat counts and replays their recorded actions. The previously looping five-seat match now ends in a draw.

### Approved decision

Extend repetition checks to settled states after completed gameplay actions, not only round boundaries. Include the active phase, ordered table stack, current turn, fixed round target/participants, and normalized opening rights, in addition to the already agreed card/seat/trump data. Exclude action IDs, timestamps, chat, and hand order as before.

Count complete atomic actions after automatic consequences; do not count retransmissions, rejected commands, or intermediate events as additional occurrences. Keep the threshold of three and preserve previous winners.

The engine records an explicit `repetition-checked` event only after automatic consequences settle. It also retains the last observed key so unchanged no-op procedures are not extra occurrences. Both the occurrence map and last key belong to rollbackable state. No turn cap or forced discard was introduced.
