import { useEffect, useState } from 'react';
import { remainingTime } from './game-stream.ts';
import type { DisplayTimer } from './game-stream.ts';

/** Presentation only. Reaching zero never submits a timeout or completes a procedure. */
export function useRemainingTime(timer: DisplayTimer | null): number {
  const [, refresh] = useState(0);
  const remaining = timer ? remainingTime(timer, performance.now()) : 0;
  const running = !!timer && !timer.paused && remaining > 0;
  useEffect(() => {
    if (!running) return;
    const interval = setInterval(() => refresh((value) => value + 1), 250);
    return () => clearInterval(interval);
  }, [running]);
  return remaining;
}
export function RemainingTime({
  remainingMs,
  paused,
}: Readonly<{ remainingMs: number; paused: boolean }>) {
  return (
    <p data-testid="procedure-time">
      {paused
        ? 'Paused'
        : remainingMs > 0
          ? 'Approximate time remaining'
          : 'Awaiting server completion'}
      : {Math.ceil(remainingMs / 1000)}s
    </p>
  );
}
