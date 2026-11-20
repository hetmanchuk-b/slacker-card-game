export type DragIntent =
  Readonly<{ type: 'draw-card' }> | Readonly<{ type: 'play-card'; cardId: string }>;
type Point = Readonly<{ pointerId: number; x: number; y: number }>;
const same = (a: DragIntent, b: DragIntent) =>
  a.type === b.type &&
  (a.type === 'draw-card' || (b.type === 'play-card' && a.cardId === b.cardId));
/** Ephemeral intent only: no faces, card movement, authority or command retry. */
export class CardDrag {
  #active: Readonly<{ intent: DragIntent; start: Point; dragging: boolean }> | null = null;
  // Cancelled contacts must all end before another source can take over. Mouse,
  // touch and pen may each have a primary pointer at the same time.
  #blocked = new Set<number>();
  #suppress = new Map<number, DragIntent>();
  get active() {
    return this.#active;
  }
  /** Document capture: a fresh down begins a new physical cycle for this pointer ID. */
  press(pointerId: number) {
    this.#blocked.delete(pointerId);
    this.#suppress.delete(pointerId);
  }
  compete(pointerId: number): boolean {
    if (this.#active?.start.pointerId === pointerId) return false;
    if (!this.#active && this.#blocked.size === 0) return false;
    this.cancel();
    this.#blocked.add(pointerId);
    return true;
  }
  end(pointerId: number) {
    this.#blocked.delete(pointerId);
  }
  begin(
    intent: DragIntent,
    point: Point & Readonly<{ button: number; isPrimary: boolean }>,
  ): boolean {
    if (this.#active) {
      const original = this.#active.start.pointerId;
      this.cancel();
      if (point.pointerId !== original) {
        this.#blocked.add(point.pointerId);
        this.#suppress.set(point.pointerId, { ...intent });
      }
      return false;
    }
    if (this.#blocked.size > 0) {
      this.#blocked.add(point.pointerId);
      this.#suppress.set(point.pointerId, { ...intent });
      return false;
    }
    if (point.button !== 0 || !point.isPrimary) return false;
    this.#suppress.clear();
    this.#active = {
      intent: { ...intent },
      start: { pointerId: point.pointerId, x: point.x, y: point.y },
      dragging: false,
    };
    return true;
  }
  move(point: Point): boolean {
    const active = this.#active;
    if (!active || point.pointerId !== active.start.pointerId || active.dragging) return false;
    if (Math.hypot(point.x - active.start.x, point.y - active.start.y) < 8) return false;
    this.#active = { ...active, dragging: true };
    return true;
  }
  finish(point: Point, onTarget: boolean): DragIntent | null {
    this.end(point.pointerId);
    if (!this.#active || this.#active.start.pointerId !== point.pointerId) return null;
    this.move(point);
    const active = this.#active;
    this.#active = null; // Clear before a callback can synchronously replace the UI.
    if (!active.dragging) return null;
    this.#suppress.set(point.pointerId, active.intent);
    return onTarget ? active.intent : null;
  }
  cancel(pointerId?: number): void {
    if (!this.#active || (pointerId !== undefined && pointerId !== this.#active.start.pointerId))
      return;
    this.#suppress.set(this.#active.start.pointerId, this.#active.intent);
    this.#blocked.add(this.#active.start.pointerId);
    this.#active = null;
  }
  allowClick(intent: DragIntent, detail: number, pointerId?: number): boolean {
    if (detail === 0) return true; // Native keyboard/assistive activation has no pointer click count.
    const match =
      pointerId === undefined
        ? [...this.#suppress].find(([, source]) => same(intent, source))
        : this.#suppress.has(pointerId)
          ? ([pointerId, this.#suppress.get(pointerId)!] as const)
          : undefined;
    if (match && same(intent, match[1])) {
      this.#suppress.delete(match[0]);
      return false;
    }
    return true;
  }
}
