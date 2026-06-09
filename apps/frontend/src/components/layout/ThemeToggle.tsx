import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme, type ThemeMode } from '@/hooks/useTheme';
import { cn } from '@/lib/utils';

interface ThemeToggleProps {
  /** Compact mode: render only icons (sidebar rail). */
  compact?: boolean;
}

const OPTIONS: { id: ThemeMode; label: string; Icon: typeof Sun }[] = [
  { id: 'light', label: 'Yorug‘', Icon: Sun },
  { id: 'dark', label: 'Qorong‘i', Icon: Moon },
  { id: 'system', label: 'Tizim', Icon: Monitor },
];

export function ThemeToggle({ compact = false }: ThemeToggleProps) {
  const { mode, setMode } = useTheme();

  if (compact) {
    // Rotating single icon — clicking cycles light → dark → system.
    const idx = OPTIONS.findIndex((o) => o.id === mode);
    const current = OPTIONS[idx] ?? OPTIONS[2]!;
    const next = OPTIONS[(idx + 1) % OPTIONS.length]!;
    return (
      <button
        type="button"
        onClick={() => setMode(next.id)}
        aria-label={`Mavzu: ${current.label}. Bosing — ${next.label} ga o‘tish.`}
        title={`Mavzu: ${current.label}`}
        className="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <current.Icon className="size-4" aria-hidden="true" />
      </button>
    );
  }

  // Full-width segmented control: the three segments share the row equally
  // (owner wants the toggle to fill the row), each an equal flex-1 cell.
  return (
    <div
      role="radiogroup"
      aria-label="Mavzu rejimi"
      className="flex w-full items-center gap-1 rounded-xl border border-border/70 bg-surface-1 p-1"
    >
      {OPTIONS.map((opt) => {
        const active = mode === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={opt.label}
            title={opt.label}
            onClick={() => setMode(opt.id)}
            className={cn(
              'inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active
                ? 'bg-primary/15 text-primary ring-1 ring-inset ring-primary/25'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
            )}
          >
            <opt.Icon className="size-4" aria-hidden="true" />
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
