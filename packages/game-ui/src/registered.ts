/**
 * A part the game hands a generic file once, from its composition root (cardtable's `./composition.tsx`).
 * Read before then, it throws rather than guess — unless the part has an honest default (`fallback`),
 * built on first read, which a game that registers nothing gets.
 */
export function registered<T>(name: string, fallback?: () => T): { set(value: T): void; get(): T } {
  let value: T | undefined;
  const missing = (): never => { throw new Error(`${name} was never registered: ./composition.tsx's composeGame() registers it`); };
  return {
    set: (v) => void (value = v),
    get: () => {
      if (value === undefined && fallback !== undefined) value = fallback();
      return value ?? missing();
    },
  };
}
