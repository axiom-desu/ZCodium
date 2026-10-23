const MAX_TRACKED_LIFECYCLE_KEYS = 2_000;

export class BoundedKeySet {
  private readonly keys = new Set<string>();

  add(key: string): boolean {
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    if (this.keys.size > MAX_TRACKED_LIFECYCLE_KEYS) {
      const oldest = this.keys.values().next().value;
      if (typeof oldest === "string") this.keys.delete(oldest);
    }
    return true;
  }

  deletePrefix(prefix: string): void {
    for (const key of this.keys) {
      if (key.startsWith(prefix)) this.keys.delete(key);
    }
  }
}

export class BoundedValueMap<T> {
  private readonly values = new Map<string, T>();

  get(key: string): T | undefined {
    return this.values.get(key);
  }

  set(key: string, value: T): void {
    this.values.delete(key);
    this.values.set(key, value);
    if (this.values.size > MAX_TRACKED_LIFECYCLE_KEYS) {
      const oldest = this.values.keys().next().value;
      if (typeof oldest === "string") this.values.delete(oldest);
    }
  }

  delete(key: string): void {
    this.values.delete(key);
  }

  deletePrefix(prefix: string): void {
    for (const key of this.values.keys()) {
      if (key.startsWith(prefix)) this.values.delete(key);
    }
  }
}
