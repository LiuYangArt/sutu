import type { NativeTabletEventV3 } from './contracts';

export type RoutedInputEventV3 = NativeTabletEventV3;

/**
 * Lock one stroke to one source, and reject mixed-source tails.
 */
export class InputRouterV3 {
  private readonly strokeSource = new Map<number, RoutedInputEventV3['source']>();

  route(event: NativeTabletEventV3): RoutedInputEventV3 | null {
    const existing = this.strokeSource.get(event.stroke_id);
    if (existing && existing !== event.source) {
      return null;
    }
    if (!existing) {
      this.strokeSource.set(event.stroke_id, event.source);
    }
    if (event.phase === 'up') {
      this.strokeSource.delete(event.stroke_id);
    }
    return event;
  }

  reset(): void {
    this.strokeSource.clear();
  }
}
