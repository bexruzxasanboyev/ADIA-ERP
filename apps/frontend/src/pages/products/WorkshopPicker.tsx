/**
 * Inline sex (production workshop) picker shown on a product card.
 *
 * Owner requirement (M2 EPIC): a `pm` / `production_manager` can assign — or
 * change — the production workshop (sex) that makes a product, directly from
 * the catalogue card. When a product has NO workshop the card shows a compact
 * «Sex biriktirish» button; when it already has one, a small pencil affordance
 * next to the WorkshopLine reuses the same picker to change it.
 *
 * The picker is a small searchable Popover (there are ~35 production
 * workshops, so a flat menu needs the search box). Selecting an option
 * PATCHes `/api/products/:id/workshop` with `{ workshop_location_id }` and,
 * on success, calls `onAssigned` so the page can refetch and re-render the
 * WorkshopLine. Translit-aware search (Latin ↔ Cyrillic) matches the rest of
 * the page so a manager can type «tort» and hit «Tort sexi».
 */
import { useMemo, useState } from 'react';
import { Check, Factory, Pencil, Plus, Search } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { apiRequest, ApiError } from '@/lib/api-client';
import { matchesSearch } from '@/lib/translit';
import { cn } from '@/lib/utils';

/** Minimal workshop option — `{ id, name }` from GET /api/locations?type=production. */
export interface WorkshopOption {
  id: number;
  name: string;
}

interface WorkshopPickerProps {
  /** The product being (re)assigned. */
  productId: number;
  /** The currently-assigned workshop id (null when unassigned). */
  currentWorkshopId: number | null;
  /** All production workshops to choose from. */
  workshops: WorkshopOption[];
  /**
   * `compact` (default) renders the small pencil affordance used next to an
   * already-assigned WorkshopLine; `button` renders the full
   * «Sex biriktirish» call-to-action used when the product has no sex.
   */
  variant?: 'compact' | 'button';
  /** Called after a successful PATCH so the parent can refetch the list. */
  onAssigned: () => void;
}

export function WorkshopPicker({
  productId,
  currentWorkshopId,
  workshops,
  variant = 'button',
  onAssigned,
}: WorkshopPickerProps) {
  const { notify } = useToast();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [savingId, setSavingId] = useState<number | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim();
    if (q === '') return workshops;
    return workshops.filter((w) => matchesSearch(w.name, q));
  }, [workshops, search]);

  async function assign(workshopLocationId: number) {
    if (workshopLocationId === currentWorkshopId) {
      setOpen(false);
      return;
    }
    setSavingId(workshopLocationId);
    try {
      await apiRequest(`/api/products/${productId}/workshop`, {
        method: 'PATCH',
        body: { workshop_location_id: workshopLocationId },
      });
      notify('success', 'Sex biriktirildi.');
      setOpen(false);
      setSearch('');
      onAssigned();
    } catch (err) {
      notify(
        'error',
        err instanceof ApiError ? err.message : 'Sexni biriktirib bo‘lmadi.',
      );
    } finally {
      setSavingId(null);
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch('');
      }}
    >
      <PopoverTrigger asChild>
        {variant === 'button' ? (
          <button
            type="button"
            aria-label="Sex biriktirish"
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border border-dashed border-border/70 px-2 py-1 text-xs font-medium text-muted-foreground transition-colors',
              'hover:border-primary/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            )}
          >
            <Plus className="size-3.5" aria-hidden="true" />
            Sex biriktirish
          </button>
        ) : (
          <button
            type="button"
            aria-label="Sexni o‘zgartirish"
            className="rounded p-0.5 text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Pencil className="size-3" aria-hidden="true" />
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <div className="border-b border-border p-2">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Sex qidirish…"
              aria-label="Sex qidirish"
              className="h-9 pl-8"
              autoFocus
            />
          </div>
        </div>
        <ul
          className="max-h-60 space-y-0.5 overflow-y-auto p-1"
          role="listbox"
          aria-label="Ishlab chiqarish sexlari"
        >
          {filtered.length === 0 && (
            <li className="px-2 py-3 text-center text-xs text-muted-foreground">
              Sex topilmadi.
            </li>
          )}
          {filtered.map((w) => {
            const selected = w.id === currentWorkshopId;
            const saving = savingId === w.id;
            return (
              <li key={w.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  disabled={savingId !== null}
                  onClick={() => assign(w.id)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                    'hover:bg-accent focus-visible:outline-none focus-visible:bg-accent',
                    'disabled:cursor-not-allowed disabled:opacity-60',
                    selected && 'bg-accent/60',
                  )}
                >
                  <Factory
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span className="truncate">{w.name}</span>
                  {selected && !saving && (
                    <Check className="ml-auto size-3.5 shrink-0 text-primary" />
                  )}
                  {saving && (
                    <span className="ml-auto text-xs text-muted-foreground">
                      …
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
