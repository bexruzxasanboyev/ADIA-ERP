import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/**
 * Two-region app-header slot mechanism.
 *
 * The global app header (see `AppLayout`) exposes two slots a route can
 * fill while it is mounted:
 *
 *   - `center`  — true-centered content. The dashboard fills this with
 *     its greeting + date + live clock + date-range filter. Tabbed
 *     groups (Modullar, Ma'lumotnoma, Kassa) instead render their
 *     centered `PageTabs` here automatically from the layout, so those
 *     pages do NOT fill `center`.
 *   - `actions` — right-aligned, sits left of the persistent
 *     `LocationSwitcher`. Pages push their Filter / view toggle / "Yangi
 *     …" controls here via `useHeaderActions` (or `<PageHeaderActions>`).
 *
 * Each slot is mount-scoped: a page registers content on mount and it is
 * cleared automatically on unmount, so stale controls never leak between
 * routes.
 */
interface HeaderSlotState {
  center: ReactNode;
  actions: ReactNode;
  setCenter: (next: ReactNode) => void;
  setActions: (next: ReactNode) => void;
}

const HeaderSlotContext = createContext<HeaderSlotState | null>(null);

export function HeaderSlotProvider({ children }: { children: ReactNode }) {
  const [center, setCenter] = useState<ReactNode>(null);
  const [actions, setActions] = useState<ReactNode>(null);
  const value = useMemo<HeaderSlotState>(
    () => ({ center, actions, setCenter, setActions }),
    [center, actions],
  );
  return (
    <HeaderSlotContext.Provider value={value}>
      {children}
    </HeaderSlotContext.Provider>
  );
}

/** Read the current center-slot content — used by the AppLayout header. */
export function useHeaderCenterContent(): ReactNode {
  const ctx = useContext(HeaderSlotContext);
  return ctx?.center ?? null;
}

/** Read the current actions-slot content — used by the AppLayout header. */
export function useHeaderActionsContent(): ReactNode {
  const ctx = useContext(HeaderSlotContext);
  return ctx?.actions ?? null;
}

/**
 * Mount-style hook: a page passes its centered header content (e.g. the
 * dashboard greeting + date + clock + range), which appears centered in
 * the global app header until the page unmounts (then it's cleared).
 */
export function useHeaderSlot(content: ReactNode): void {
  const ctx = useContext(HeaderSlotContext);
  const set = ctx?.setCenter;
  const setStable = useCallback(
    (next: ReactNode) => {
      set?.(next);
    },
    [set],
  );
  useEffect(() => {
    setStable(content);
    return () => setStable(null);
  }, [content, setStable]);
}

/**
 * Mount-style hook: a page passes its right-aligned action controls
 * (Filter, view toggle, create buttons). They render in the global app
 * header's actions slot until the page unmounts.
 */
export function useHeaderActions(content: ReactNode): void {
  const ctx = useContext(HeaderSlotContext);
  const set = ctx?.setActions;
  const setStable = useCallback(
    (next: ReactNode) => {
      set?.(next);
    },
    [set],
  );
  useEffect(() => {
    setStable(content);
    return () => setStable(null);
  }, [content, setStable]);
}
