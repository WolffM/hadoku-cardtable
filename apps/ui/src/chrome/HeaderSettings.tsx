/*
 * The hand-off between the header's settings popout and whatever screen has
 * app settings to put in it (wave 32 Q15).
 *
 * The operator: *"the settings live in the top settings menu, and the extra
 * button goes."* `AppHeader` forwards a `children` slot into the fleet's
 * `ConnectedSettings` popout (`@wolffm/task-ui-components` 4.8.4), but the
 * header is authored in `App.tsx`, above every screen, and the setting that
 * matters here — *Always stop at end step* — needs the LIVE MATCH, which only
 * `LiveBoard` holds. So the header cannot be handed the controls as a prop.
 *
 * **The design is a portal, not a store.** `AppChrome` slots one empty
 * `<HeaderSettingsHost>` into the header's `children`. The popout mounts it
 * only while it is open, and the host reports its DOM node through the context
 * below. A screen renders `<HeaderSettingsPortal>` around its controls, and
 * they are portalled into that node. Why not lift state into a context and
 * render a node the chrome owns: the controls close over the match, the prefs
 * client and their own handlers, and would have to be re-published to the
 * chrome on every change; a portal keeps them where they are authored, under
 * the providers they need, rendering live, with nothing to keep in sync.
 *
 * Outside a provider (a test that renders a screen alone, any embedder with
 * another chrome) the portal draws nothing: a screen can ask for a place in the
 * menu without requiring that one exists.
 */

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface HeaderSettingsSlot {
  /** The popout's mount node, or null while the popout is closed. */
  host: HTMLElement | null;
  setHost: (el: HTMLElement | null) => void;
}

const NO_SLOT: HeaderSettingsSlot = { host: null, setHost: () => undefined };
const SlotContext = createContext<HeaderSettingsSlot>(NO_SLOT);

export function HeaderSettingsProvider({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const slot = useMemo(() => ({ host, setHost }), [host]);
  return <SlotContext.Provider value={slot}>{children}</SlotContext.Provider>;
}

/** What `AppChrome` slots into the header: the node screens portal into. */
export function HeaderSettingsHost() {
  const { setHost } = useContext(SlotContext);
  return <div className="cardtable-chrome__app-settings" data-testid="header-app-settings" ref={setHost} />;
}

/** A screen's own settings, drawn inside the header's popout while it is open. */
export function HeaderSettingsPortal({ children }: { children: ReactNode }) {
  const { host } = useContext(SlotContext);
  return host === null ? null : createPortal(children, host);
}
