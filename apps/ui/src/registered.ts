/** A part the game hands a generic file once, from `./composition.tsx`; read before then, it throws rather than guess. */
export function registered<T>(name: string): { set(value: T): void; get(): T } {
  let value: T | undefined;
  const missing = (): never => { throw new Error(`${name} was never registered: ./composition.tsx's composeGame() registers it`); };
  return { set: (v) => void (value = v), get: () => value ?? missing() };
}
