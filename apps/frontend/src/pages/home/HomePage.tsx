import { Link } from 'react-router-dom';
import { CakeSlice, CircleUser } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ThemeToggle } from '@/components/layout/ThemeToggle';
import { useAuth } from '@/hooks/useAuth';
import { getGreeting } from '@/lib/format';
import { cn } from '@/lib/utils';
import { HOME_TILE_GROUPS, type HomeTile } from '@/lib/navigation';

/**
 * Home launcher (IA redesign) — the PRIMARY navigation hub.
 *
 * Renders the PRIMARY modules as THREE titled sections in an explicit
 * owner-directed order (`HOME_TILE_GROUPS`):
 *   - Boshqaruv  — Dashboard, Mahsulotlar, Bo'g'inlar, Hodimlar;
 *   - Bo'limlar  — the five supply-chain links;
 *   - Qo'shimcha — Kassa, Bashorat.
 * Secondary screens are reached from the header sub-tabs (PageTabs)
 * within their group, not from here.
 *
 * Tiles are RBAC-filtered by the current user's role with the same
 * `roles.includes(user.role)` rule the nav uses; a group with no visible
 * tiles is dropped entirely (no orphan heading). When there is no
 * authenticated user yet, show everything (the route guard still gates
 * actual access).
 *
 * Top bar: ThemeToggle (left) + Profil link (right).
 */

/**
 * Per-group accent palette so each section is colour-coded for clarity:
 *   Boshqaruv → ko'k, Bo'limlar → yashil, Qo'shimcha → sarg'ish.
 * Class strings are full literals (not interpolated) so Tailwind keeps
 * them. Keyed by the exact group title from `HOME_TILE_GROUPS`.
 */
interface GroupAccent {
  heading: string;
  icon: string;
  card: string;
}
const GROUP_ACCENTS: Record<string, GroupAccent> = {
  Boshqaruv: {
    heading: 'text-primary/80',
    icon: 'bg-primary/10 text-primary group-hover:bg-primary/20',
    card: 'hover:border-primary/60 hover:bg-primary/5 group-focus-visible:border-primary/60',
  },
  'Bo‘limlar': {
    heading: 'text-success/80',
    icon: 'bg-success/10 text-success group-hover:bg-success/20',
    card: 'hover:border-success/60 hover:bg-success/5 group-focus-visible:border-success/60',
  },
  'Qo‘shimcha': {
    heading: 'text-warning/80',
    icon: 'bg-warning/10 text-warning group-hover:bg-warning/20',
    card: 'hover:border-warning/60 hover:bg-warning/5 group-focus-visible:border-warning/60',
  },
};
const DEFAULT_ACCENT: GroupAccent = {
  heading: 'text-muted-foreground',
  icon: 'bg-primary/10 text-primary group-hover:bg-primary/15',
  card: 'hover:border-primary/50 hover:bg-accent/40 group-focus-visible:border-primary/50',
};

/** Tile card — a single launcher module, tinted by its group accent. */
function TileCard({ tile, accent }: { tile: HomeTile; accent: GroupAccent }) {
  const Icon = tile.icon;
  return (
    <Link
      to={tile.path}
      className="group block w-full rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Card
        className={cn(
          'flex h-full min-h-[7rem] flex-col items-center justify-center gap-3 p-4 text-center transition-all hover:border-border-strong hover:shadow-card-hover',
          accent.card,
        )}
      >
        <span
          className={cn(
            'flex size-11 items-center justify-center rounded-lg transition-colors',
            accent.icon,
          )}
        >
          <Icon className="size-5" aria-hidden="true" />
        </span>
        <span className="text-sm font-medium leading-tight">{tile.label}</span>
      </Card>
    </Link>
  );
}

export function HomePage() {
  const { user } = useAuth();

  const visible = (tile: HomeTile) => !user || tile.roles.includes(user.role);
  const groups = HOME_TILE_GROUPS.map((group) => ({
    ...group,
    tiles: group.tiles.filter(visible),
  })).filter((group) => group.tiles.length > 0);

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-4 sm:px-6 lg:px-8">
        <ThemeToggle compact />
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground"
        >
          <Link to="/profile">
            <CircleUser className="size-5" aria-hidden="true" />
            <span className="hidden sm:inline">Profil</span>
          </Link>
        </Button>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 py-10 sm:px-6 sm:py-14 lg:px-8">
        <div className="mb-8 flex flex-col items-center gap-2 text-center sm:mb-12">
          <CakeSlice className="size-10 text-primary" aria-hidden="true" />
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            ADIA ERPga xush kelibsiz
          </h1>
          {user && (
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">
                {getGreeting()}, {user.name}
              </span>{' '}
              — sahifani tanlang.
            </p>
          )}
        </div>

        {/* THREE titled sections in owner-directed order. Each section is a
            width-capped + mx-auto grid with a fixed responsive column count,
            so an incomplete last row left-aligns under the heading instead of
            leaving a lone tile floating in the centre. */}
        <nav aria-label="Asosiy modullar" className="mx-auto w-full max-w-3xl space-y-8">
          {groups.map((group) => {
            const accent = GROUP_ACCENTS[group.title] ?? DEFAULT_ACCENT;
            return (
              <section key={group.title} aria-label={group.title}>
                {/* Section heading (DESIGN.md §9): kicker + secondary count. */}
                <div className="mb-3 flex items-center gap-2">
                  <h2
                    className={cn(
                      'text-xs font-semibold uppercase tracking-wider',
                      accent.heading,
                    )}
                  >
                    {group.title}
                  </h2>
                  <Badge variant="secondary" className="tabular-nums">
                    {group.tiles.length}
                  </Badge>
                </div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
                  {group.tiles.map((tile) => (
                    <TileCard key={tile.path} tile={tile} accent={accent} />
                  ))}
                </div>
              </section>
            );
          })}
        </nav>
      </main>
    </div>
  );
}
