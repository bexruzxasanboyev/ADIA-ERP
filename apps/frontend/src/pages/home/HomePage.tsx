import { Link } from 'react-router-dom';
import { CakeSlice, CircleUser } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { ThemeToggle } from '@/components/layout/ThemeToggle';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';
import { HOME_TILES, type HomeTile } from '@/lib/navigation';

/**
 * Home launcher (IA redesign) — the PRIMARY navigation hub.
 *
 * Renders the 11 PRIMARY modules (`HOME_TILES`) as TWO rows so nothing
 * spills onto a lonely third row:
 *   - top row    — the 5 most important modules, rendered LARGER;
 *   - bottom row — the remaining 6, slightly smaller.
 * No per-section headings; secondary screens are reached from the header
 * sub-tabs (PageTabs) within their group, not from here.
 *
 * Tiles are RBAC-filtered by the current user's role with the same
 * `roles.includes(user.role)` rule the nav uses. When there is no
 * authenticated user yet, show everything (the route guard still gates
 * actual access).
 *
 * Top bar: ThemeToggle (left) + Profil link (right).
 */

/**
 * Tile card. `size="lg"` is used for the 5 PRIMARY modules in the top
 * row (taller, larger icon); `size="md"` for the 6 secondary tiles below.
 */
function TileCard({ tile, size }: { tile: HomeTile; size: 'lg' | 'md' }) {
  const Icon = tile.icon;
  const lg = size === 'lg';
  return (
    <Link
      to={tile.path}
      className="group block w-full rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Card
        className={cn(
          'flex h-full flex-col items-center justify-center gap-3 p-4 text-center transition-all hover:border-primary/50 hover:bg-accent/40 hover:shadow-lg group-focus-visible:border-primary/50',
          lg ? 'min-h-[8.5rem]' : 'min-h-[7rem]',
        )}
      >
        <span
          className={cn(
            'flex items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary/15',
            lg ? 'size-14' : 'size-11',
          )}
        >
          <Icon className={lg ? 'size-7' : 'size-5'} aria-hidden="true" />
        </span>
        <span
          className={cn('font-medium leading-tight', lg ? 'text-base' : 'text-sm')}
        >
          {tile.label}
        </span>
      </Card>
    </Link>
  );
}

export function HomePage() {
  const { user } = useAuth();

  const visible = (tile: HomeTile) => !user || tile.roles.includes(user.role);
  const tiles = HOME_TILES.filter(visible);

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-4 sm:px-6 lg:px-8">
        <ThemeToggle compact />
        <Link
          to="/profile"
          className="inline-flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <CircleUser className="size-5" aria-hidden="true" />
          <span className="hidden sm:inline">Profil</span>
        </Link>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 py-10 sm:px-6 sm:py-14 lg:px-8">
        <div className="mb-8 flex flex-col items-center gap-2 text-center sm:mb-12">
          <CakeSlice className="size-10 text-primary" aria-hidden="true" />
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            ADIA ERPga xush kelibsiz
          </h1>
          {user && (
            <p className="text-sm text-muted-foreground">
              {user.name}, sahifani tanlang.
            </p>
          )}
        </div>

        {/* A single centered grid for ALL visible modules. A fixed responsive
            column count (not a centered flex-wrap) keeps the tiles aligned in
            tidy columns; an incomplete last row left-aligns under the grid
            instead of leaving a lone tile floating in the centre. The grid is
            width-capped + mx-auto so the whole block stays centred on the
            page regardless of how many tiles a role sees. */}
        <nav aria-label="Asosiy modullar">
          <div className="mx-auto grid max-w-3xl grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
            {tiles.map((tile) => (
              <TileCard key={tile.path} tile={tile} size="md" />
            ))}
          </div>
        </nav>
      </main>
    </div>
  );
}
