export interface TileResidencyEntry {
  key: string;
  bytes: number;
  lastUsed: number;
  onEvict: () => void;
}

export class TileResidencyManager {
  private maxBytes: number;
  private usedBytes: number = 0;
  private entries: Map<string, TileResidencyEntry> = new Map();
  private evictionCount: number = 0;

  constructor(maxBytes: number = Number.POSITIVE_INFINITY) {
    this.maxBytes = maxBytes;
  }

  setBudgetBytes(maxBytes: number): void {
    this.maxBytes = Math.max(0, maxBytes);
    this.evictIfNeeded();
  }

  getBudgetBytes(): number {
    return this.maxBytes;
  }

  getUsedBytes(): number {
    return this.usedBytes;
  }

  registerTile(key: string, bytes: number, onEvict: () => void): void {
    const existing = this.entries.get(key);
    if (existing) {
      existing.lastUsed = performance.now();
      return;
    }

    const entry: TileResidencyEntry = {
      key,
      bytes,
      lastUsed: performance.now(),
      onEvict,
    };

    this.entries.set(key, entry);
    this.usedBytes += bytes;
    this.evictIfNeeded();
  }

  touch(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.lastUsed = performance.now();
  }

  release(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.usedBytes = Math.max(0, this.usedBytes - entry.bytes);
  }

  clear(): void {
    this.entries.clear();
    this.usedBytes = 0;
    this.evictionCount = 0;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  getEntryCount(): number {
    return this.entries.size;
  }

  getEvictionCount(): number {
    return this.evictionCount;
  }

  resetEvictionCount(): void {
    this.evictionCount = 0;
  }

  private evictIfNeeded(): void {
    if (this.usedBytes <= this.maxBytes) return;

    const entries = Array.from(this.entries.values()).sort((a, b) => a.lastUsed - b.lastUsed);
    for (const entry of entries) {
      if (this.usedBytes <= this.maxBytes) break;
      this.entries.delete(entry.key);
      this.usedBytes = Math.max(0, this.usedBytes - entry.bytes);
      this.evictionCount += 1;
      entry.onEvict();
    }
  }
}
