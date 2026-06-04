import {
  createContext,
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
 *
 * The state is split across TWO contexts on purpose:
 *   - a VALUE context (`center` / `actions`) that the AppLayout header reads;
 *   - an API context (`setCenter` / `setActions`) that pages write through.
 * The setters from `useState` are referentially stable, so a page that only
 * WRITES (via `useHeaderSlot` / `useHeaderActions`) does not re-subscribe to
 * the value and therefore does not re-render when the slot content changes.
 * Without this split, every `setActions(<jsx/>)` re-rendered the writer,
 * which produced a fresh element, which re-ran the effect — an infinite
 * "Maximum update depth exceeded" loop.
 */
interface HeaderSlotValue {
  center: ReactNode;
  actions: ReactNode;
}

interface HeaderSlotApi {
  setCenter: (next: ReactNode) => void;
  setActions: (next: ReactNode) => void;
}

const HeaderSlotValueContext = createContext<HeaderSlotValue | null>(null);
const HeaderSlotApiContext = createContext<HeaderSlotApi | null>(null);

export function HeaderSlotProvider({ children }: { children: ReactNode }) {
  const [center, setCenter] = useState<ReactNode>(null);
  const [actions, setActions] = useState<ReactNode>(null);
  const value = useMemo<HeaderSlotValue>(
    () => ({ center, actions }),
    [center, actions],
  );
  // `setCenter` / `setActions` are stable across renders, so this object
  // never changes identity — writers never re-render on a content change.
  const api = useMemo<HeaderSlotApi>(
    () => ({ setCenter, setActions }),
    [],
  );
  return (
    <HeaderSlotApiContext.Provider value={api}>
      <HeaderSlotValueContext.Provider value={value}>
        {children}
      </HeaderSlotValueContext.Provider>
    </HeaderSlotApiContext.Provider>
  );
}

/** Read the current center-slot content — used by the AppLayout header. */
export function useHeaderCenterContent(): ReactNode {
  return useContext(HeaderSlotValueContext)?.center ?? null;
}

/** Read the current actions-slot content — used by the AppLayout header. */
export function useHeaderActionsContent(): ReactNode {
  return useContext(HeaderSlotValueContext)?.actions ?? null;
}

/**
 * Mount-style hook: a page passes its centered header content (e.g. the
 * dashboard greeting + date + clock + range), which appears centered in
 * the global app header until the page unmounts (then it's cleared).
 */
export function useHeaderSlot(content: ReactNode): void {
  const set = useContext(HeaderSlotApiContext)?.setCenter;
  useEffect(() => {
    set?.(content);
    return () => set?.(null);
  }, [content, set]);
}

/**
 * Mount-style hook: a page passes its right-aligned action controls
 * (Filter, view toggle, create buttons). They render in the global app
 * header's actions slot until the page unmounts.
 */
export function useHeaderActions(content: ReactNode): void {
  const set = useContext(HeaderSlotApiContext)?.setActions;
  useEffect(() => {
    set?.(content);
    return () => set?.(null);
  }, [content, set]);
}
