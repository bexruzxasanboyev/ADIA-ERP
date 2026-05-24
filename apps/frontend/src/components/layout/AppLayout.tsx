import { Outlet } from 'react-router-dom';
import { AppSidebar } from './AppSidebar';
import { AssistantButton } from './AssistantButton';
import { LocationSwitcher } from './LocationSwitcher';

/**
 * Authenticated layout shell: persistent sidebar + scrollable content area.
 * Module screens render into <Outlet />. A floating `AssistantButton`
 * lives at the layout root so the AI chat drawer is reachable from any
 * authenticated screen (Faza-2 F2.2).
 *
 * F4.1 — a slim top header on the right hosts the `LocationSwitcher` so
 * multi-location users can change their active bo'g'in without leaving
 * the screen. Single-location users see nothing here (the switcher
 * renders `null`), preserving the original layout.
 */
export function AppLayout() {
  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      <AppSidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-14 shrink-0 items-center justify-end border-b border-border bg-background px-6 lg:px-8">
          <LocationSwitcher />
        </header>
        <main className="flex-1 overflow-y-auto p-6 lg:p-8">
          <Outlet />
        </main>
      </div>
      <AssistantButton />
    </div>
  );
}
