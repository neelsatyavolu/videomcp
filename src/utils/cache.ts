import { CACHE_TTL_MS } from "../constants.js";

interface Entry<T> {
  value: T;
  expiresAt: number;
}

/** Simple in-memory TTL cache with LRU-ish eviction. */
export class TtlCache<T> {
  private map = new Map<string, Entry<T>>();

  constructor(
    private maxEntries = 64,
    private ttlMs = CACHE_TTL_MS,
  ) {}

  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    // refresh insertion order
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    while (this.map.size > this.maxEntries) {
      const first = this.map.keys().next().value as string | undefined;
      if (first === undefined) break;
      this.map.delete(first);
    }
  }

  clear(): void {
    this.map.clear();
  }
}

export const analysisCache = new TtlCache<unknown>(32);
export const infoCache = new TtlCache<unknown>(64);
