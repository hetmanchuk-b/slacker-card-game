import { useCallback, useEffect, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, PointerEvent, RefObject } from 'react';
import { CardDrag } from './card-drag.ts';
import type { DragIntent } from './card-drag.ts';

export type CardDragUI = Readonly<{
  source: (
    intent: DragIntent,
    disabled: boolean,
    click: () => void,
  ) => ButtonHTMLAttributes<HTMLButtonElement>;
  handTarget: RefObject<HTMLUListElement | null>;
  tableTarget: RefObject<HTMLOListElement | null>;
  dragging: DragIntent | null;
  shortcutTarget: RefObject<HTMLDivElement | null>;
  cancel: () => void;
}>;
export function useCardDrag(onDrop: (intent: DragIntent) => void, busy: boolean): CardDragUI {
  const [gesture] = useState(() => new CardDrag());
  const [dragging, setDragging] = useState<DragIntent | null>(null);
  const handTarget = useRef<HTMLUListElement>(null);
  const tableTarget = useRef<HTMLOListElement>(null);
  const shortcutTarget = useRef<HTMLDivElement>(null);
  const capture = useRef<{ element: HTMLButtonElement; pointerId: number } | null>(null);
  const release = useCallback(() => {
    const held = capture.current;
    capture.current = null;
    if (held?.element.hasPointerCapture(held.pointerId))
      held.element.releasePointerCapture(held.pointerId);
  }, []);
  const cancel = useCallback(() => {
    gesture.cancel();
    release();
    setDragging(null);
  }, [gesture, release]);
  useEffect(() => {
    cancel();
  }, [busy, cancel]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && gesture.active) {
        event.preventDefault();
        cancel();
      }
    };
    const hidden = () => {
      if (document.hidden) cancel();
    };
    const competing = (event: globalThis.PointerEvent) => {
      gesture.press(event.pointerId);
      if (gesture.compete(event.pointerId)) {
        release();
        setDragging(null);
      }
    };
    const end = (event: globalThis.PointerEvent) => {
      if (event.type === 'pointercancel' && gesture.active?.start.pointerId === event.pointerId)
        cancel();
      gesture.end(event.pointerId);
    };
    window.addEventListener('blur', cancel);
    document.addEventListener('visibilitychange', hidden);
    document.addEventListener('keydown', key);
    document.addEventListener('pointerdown', competing, true);
    document.addEventListener('pointerup', end, true);
    document.addEventListener('pointercancel', end, true);
    return () => {
      window.removeEventListener('blur', cancel);
      document.removeEventListener('visibilitychange', hidden);
      document.removeEventListener('keydown', key);
      document.removeEventListener('pointerdown', competing, true);
      document.removeEventListener('pointerup', end, true);
      document.removeEventListener('pointercancel', end, true);
      cancel();
    };
  }, [cancel, gesture, release]);
  const point = (event: PointerEvent<HTMLButtonElement>) => ({
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
  });
  const onTarget = (intent: DragIntent, x: number, y: number) => {
    const targets = [
      intent.type === 'draw-card' ? handTarget.current : tableTarget.current,
      shortcutTarget.current,
    ];
    const hit = document.elementFromPoint(x, y);
    return targets.some((target) => {
      if (!target) return false;
      const rect = target.getBoundingClientRect();
      return (
        x >= rect.left &&
        x <= rect.right &&
        y >= rect.top &&
        y <= rect.bottom &&
        !!hit &&
        target.contains(hit)
      );
    });
  };
  return {
    handTarget,
    tableTarget,
    shortcutTarget,
    dragging,
    cancel,
    source: (intent, disabled, click) => ({
      className: 'card-drag-source',
      draggable: false,
      onDragStart: (event) => event.preventDefault(),
      onPointerDown: (event) => {
        if (disabled) return;
        if (
          !gesture.begin(intent, {
            ...point(event),
            button: event.button,
            isPrimary: event.isPrimary,
          })
        ) {
          cancel();
          return;
        }
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
          capture.current = { element: event.currentTarget, pointerId: event.pointerId };
        } catch {
          cancel();
        }
      },
      onPointerMove: (event) => {
        if (gesture.move(point(event))) setDragging(gesture.active!.intent);
      },
      onPointerUp: (event) => {
        const active = gesture.active;
        if (!active || active.start.pointerId !== event.pointerId) return;
        const command = gesture.finish(
          point(event),
          !disabled && onTarget(active.intent, event.clientX, event.clientY),
        );
        release();
        setDragging(null);
        if (command) onDrop(command);
      },
      onPointerCancel: (event) => {
        if (gesture.active?.start.pointerId === event.pointerId) cancel();
      },
      onLostPointerCapture: (event) => {
        if (gesture.active?.start.pointerId === event.pointerId) cancel();
      },
      onClick: (event) => {
        const native = event.nativeEvent;
        const pointerId =
          'pointerId' in native && typeof native.pointerId === 'number'
            ? native.pointerId
            : undefined;
        if (!gesture.allowClick(intent, event.detail, pointerId)) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (!disabled) {
          if (event.detail === 0) cancel();
          click();
        }
      },
    }),
  };
}
