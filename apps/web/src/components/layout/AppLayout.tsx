import { Outlet } from 'react-router-dom';
import { AppSidebar } from './AppSidebar';

/**
 * Authenticated layout shell: persistent sidebar + scrollable content area.
 * Module screens render into <Outlet />.
 */
export function AppLayout() {
  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      <AppSidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <main className="flex-1 overflow-y-auto p-6 lg:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
