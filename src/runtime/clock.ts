export type CancelTask = () => void;

/** Absolute millisecond deadlines; tasks resolve after their queued runtime work finishes. */
export interface Clock {
  now(): number;
  scheduleAt(deadlineMs: number, task: () => Promise<void>): CancelTask;
}
