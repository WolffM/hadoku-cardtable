/*
 * A table's way on (`tableDoor.ts`'s `doorGo`), drawn: a link wearing its caller's look, with the
 * door it is on `data-door`. A plain press takes the way's own action (a game opened the way every
 * new game is); a new tab still gets the address.
 */
import type { TableCardGo } from './TableCard.tsx';

export function GoLink({ go, className }: { go: TableCardGo; className: string }) {
  return (
    <a
      className={className}
      data-testid={go.testId}
      data-door={go.door}
      href={go.href}
      onClick={(event) => {
        if (go.onPress === undefined || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        go.onPress();
      }}
    >
      {go.label}
    </a>
  );
}
