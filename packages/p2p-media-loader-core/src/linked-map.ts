type LinkedObject<V extends object> = {
  value: V;
  prev?: LinkedObject<V>;
  next?: LinkedObject<V>;
};

export class LinkedMap<K, V extends object> {
  private readonly map = new Map<K, LinkedObject<V>>();
  private _first?: LinkedObject<V>;
  private _last?: LinkedObject<V>;

  get first() {
    return this._first?.value;
  }

  get last() {
    return this._last?.value;
  }

  get size() {
    return this.map.size;
  }

  get(key: K): V | undefined {
    return this.map.get(key)?.value;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  addToEnd(key: K, value: V) {
    const item: LinkedObject<V> = { value };
    if (this._last) item.prev = this._last;
    this._last = item;
    this.map.set(key, item);
  }

  addToStart(key: K, value: V) {
    const item: LinkedObject<V> = { value };
    if (this._first) item.next = this._first;
    this._first = item;
    this.map.set(key, item);
  }

  delete(key: K) {
    if (!this.map.size) return;
    const item = this.map.get(key);
    if (!item) return;

    const { next, prev } = item;
    if (this._first?.value === item.value) this._first = next;
    if (this._last?.value === item.value) this._last = prev;
    if (prev) prev.next = next;
    if (next) next.prev = prev;
    this.map.delete(key);
  }

  clear() {
    this._first = undefined;
    this._last = undefined;
    this.map.clear();
  }

  *values(): Generator<V> {
    let item = this._first;
    while (item !== undefined) {
      yield item.value;
      item = item.next;
    }
  }

  *valuesBackwardsFrom(key: K): Generator<V> {
    let value = this.map.get(key);
    if (value === undefined) return;
    while (value?.value !== undefined) {
      yield value.value;
      value = value.prev;
    }
  }

  *valuesFrom(key: K): Generator<V> {
    let value = this.map.get(key);
    if (value === undefined) return;
    while (value?.value !== undefined) {
      yield value.value;
      value = value.next;
    }
  }

  getNextTo(key: K): V | undefined {
    return this.map.get(key)?.next?.value;
  }
}
