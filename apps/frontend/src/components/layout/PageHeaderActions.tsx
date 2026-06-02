import type { ReactNode } from 'react';
import { useHeaderActions } from './HeaderSlot';

/**
 * Declarative helper for a page to push its right-aligned action
 * controls into the global app header's actions slot (left of the
 * persistent `LocationSwitcher`).
 *
 * Usage — drop it anywhere in the page tree:
 *
 *   <PageHeaderActions>
 *     <FilterPopover … />
 *     <Button>Yangi hodim</Button>
 *   </PageHeaderActions>
 *
 * The children are wrapped in a flex row with the standard gap so every
 * page's header actions line up identically. Content is mount-scoped:
 * it clears automatically when the page unmounts.
 */
export function PageHeaderActions({ children }: { children: ReactNode }) {
  useHeaderActions(
    <div className="flex flex-wrap items-center justify-end gap-2">
      {children}
    </div>,
  );
  return null;
}
