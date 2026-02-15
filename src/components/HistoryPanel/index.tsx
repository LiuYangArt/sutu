import { useCallback, useMemo, useRef, useState } from 'react';
import { useHistoryStore, type HistoryEntry } from '@/stores/history';
import {
  buildHistoryTimeline,
  formatHistoryEntryLabel,
  getHistoryEntryKey,
} from './historyTimeline';
import './HistoryPanel.css';

type HistoryPanelWindow = Window & {
  __canvasHistoryJumpTo?: (targetIndex: number) => Promise<boolean>;
};

interface DisplayHistoryItem {
  entry: HistoryEntry;
  index: number;
  key: string;
  label: string;
  isCurrent: boolean;
  isFuture: boolean;
}

export function HistoryPanel(): JSX.Element {
  const undoStack = useHistoryStore((s) => s.undoStack);
  const redoStack = useHistoryStore((s) => s.redoStack);
  const [pendingIndex, setPendingIndex] = useState<number | null>(null);
  const jumpingRef = useRef(false);

  const { entries, currentIndex } = useMemo(
    () => buildHistoryTimeline(undoStack, redoStack),
    [undoStack, redoStack]
  );

  const items = useMemo<DisplayHistoryItem[]>(() => {
    const mapped = entries.map((entry, index) => ({
      entry,
      index,
      key: getHistoryEntryKey(entry, index),
      label: formatHistoryEntryLabel(entry),
      isCurrent: index === currentIndex,
      isFuture: index > currentIndex,
    }));
    return mapped.reverse();
  }, [entries, currentIndex]);

  const handleJump = useCallback(
    async (targetIndex: number): Promise<void> => {
      if (jumpingRef.current) return;
      if (targetIndex === currentIndex) return;

      const jumpTo = (window as HistoryPanelWindow).__canvasHistoryJumpTo;
      if (typeof jumpTo !== 'function') return;

      jumpingRef.current = true;
      setPendingIndex(targetIndex);
      try {
        await jumpTo(targetIndex);
      } finally {
        jumpingRef.current = false;
        setPendingIndex(null);
      }
    },
    [currentIndex]
  );

  if (entries.length === 0) {
    return <div className="history-panel__empty">No history yet.</div>;
  }

  return (
    <div className="history-panel">
      <ul className="history-panel__list">
        {items.map((item) => (
          <li
            key={item.key}
            data-testid={`history-item-${item.index}`}
            className={`history-panel__item${item.isCurrent ? ' history-panel__item--current' : ''}${item.isFuture ? ' history-panel__item--future' : ''}${pendingIndex === item.index ? ' history-panel__item--pending' : ''}`}
          >
            <button
              type="button"
              className="history-panel__button"
              disabled={pendingIndex !== null}
              onClick={() => void handleJump(item.index)}
            >
              <span className="history-panel__label">{item.label}</span>
              {item.isCurrent && <span className="history-panel__status">Current</span>}
              {!item.isCurrent && item.isFuture && (
                <span className="history-panel__status">Future</span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
