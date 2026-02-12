import {
  CSSProperties,
  ReactNode,
  UIEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

interface VirtualizedTipGridProps<T> {
  items: readonly T[];
  getItemKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => ReactNode;
  maxHeight: number;
  minItemWidth?: number;
  itemHeight?: number;
  gap?: number;
  overscanRows?: number;
  className?: string;
  style?: CSSProperties;
}

interface GridMetrics {
  viewportHeight: number;
  viewportWidth: number;
}

interface VisibleWindow {
  startIndex: number;
  endIndex: number;
  offsetY: number;
}

function isSameGridMetrics(left: GridMetrics, right: GridMetrics): boolean {
  return left.viewportHeight === right.viewportHeight && left.viewportWidth === right.viewportWidth;
}

function computeColumnCount(viewportWidth: number, minItemWidth: number, gap: number): number {
  return Math.max(1, Math.floor((viewportWidth + gap) / (minItemWidth + gap)));
}

function computeVisibleWindow(
  itemCount: number,
  scrollTop: number,
  viewportHeight: number,
  rowStride: number,
  columns: number,
  totalRows: number,
  overscanRows: number
): VisibleWindow {
  if (itemCount === 0) {
    return { startIndex: 0, endIndex: 0, offsetY: 0 };
  }

  const startRow = Math.max(0, Math.floor(scrollTop / rowStride) - overscanRows);
  const endRow = Math.min(
    totalRows,
    Math.ceil((scrollTop + viewportHeight) / rowStride) + overscanRows
  );
  const startIndex = startRow * columns;
  const endIndex = Math.min(itemCount, endRow * columns);
  return {
    startIndex,
    endIndex,
    offsetY: startRow * rowStride,
  };
}

export function VirtualizedTipGrid<T>({
  items,
  getItemKey,
  renderItem,
  maxHeight,
  minItemWidth = 64,
  itemHeight = 58,
  gap = 6,
  overscanRows = 2,
  className = '',
  style,
}: VirtualizedTipGridProps<T>): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [metrics, setMetrics] = useState<GridMetrics>({
    viewportHeight: maxHeight,
    viewportWidth: 0,
  });

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const syncMetrics = () => {
      const next: GridMetrics = {
        viewportHeight: container.clientHeight || maxHeight,
        viewportWidth: container.clientWidth,
      };

      setMetrics((prev) => {
        if (isSameGridMetrics(prev, next)) {
          return prev;
        }
        return next;
      });
    };

    syncMetrics();

    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(() => {
      syncMetrics();
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
    };
  }, [maxHeight]);

  const rowStride = itemHeight + gap;
  const columns = computeColumnCount(metrics.viewportWidth, minItemWidth, gap);
  const totalRows = Math.ceil(items.length / columns);
  const totalHeight = Math.max(0, totalRows * rowStride - gap);

  const visibleWindow = useMemo(
    () =>
      computeVisibleWindow(
        items.length,
        scrollTop,
        metrics.viewportHeight,
        rowStride,
        columns,
        totalRows,
        overscanRows
      ),
    [columns, items.length, metrics.viewportHeight, overscanRows, rowStride, scrollTop, totalRows]
  );

  const visibleItems = items.slice(visibleWindow.startIndex, visibleWindow.endIndex);

  function handleScroll(event: UIEvent<HTMLDivElement>): void {
    setScrollTop(event.currentTarget.scrollTop);
  }

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      style={{
        maxHeight,
        overflowY: 'auto',
        marginTop: 8,
        border: '1px solid #333',
        padding: 4,
        ...style,
      }}
    >
      <div style={{ height: totalHeight, position: 'relative' }}>
        <div
          className={className}
          style={{
            marginTop: 0,
            position: 'absolute',
            top: visibleWindow.offsetY,
            left: 0,
            right: 0,
            display: 'grid',
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            gap,
          }}
        >
          {visibleItems.map((item, index) => {
            const absoluteIndex = visibleWindow.startIndex + index;
            return (
              <div key={getItemKey(item, absoluteIndex)} style={{ minHeight: itemHeight }}>
                {renderItem(item, absoluteIndex)}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
