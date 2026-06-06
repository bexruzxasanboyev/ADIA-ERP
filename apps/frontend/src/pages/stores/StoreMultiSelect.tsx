import { useMemo, useState } from 'react';
import { Check, ChevronDown, Search, Store, X } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { matchesSearch } from '@/lib/translit';
import { cn } from '@/lib/utils';

interface StoreOption {
  id: number;
  name: string;
}

interface StoreMultiSelectProps {
  /** Selectable stores (already scoped by the parent). */
  stores: StoreOption[];
  /** Currently selected store ids. */
  selectedIds: number[];
  /** Replace the whole selection. */
  onChange: (ids: number[]) => void;
  disabled?: boolean;
}

/**
 * Do'kon ish joyi — a custom, translit-aware MULTI-select store picker
 * (owner feedback: the native store `<select>` should be a searchable,
 * multi-select dropdown). One trigger opens a searchable checkbox list;
 * search folds Latin ↔ Cyrillic via `matchesSearch` so "rabochiy" matches
 * "Рабочий". Selecting several stores lets the page show their combined
 * rows with a per-row "Do'kon" column.
 */
export function StoreMultiSelect({
  stores,
  selectedIds,
  onChange,
  disabled = false,
}: StoreMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const filtered = useMemo(() => {
    if (search.trim() === '') return stores;
    return stores.filter((s) => matchesSearch(s.name, search));
  }, [stores, search]);

  const toggle = (id: number) => {
    if (selectedSet.has(id)) {
      onChange(selectedIds.filter((x) => x !== id));
    } else {
      onChange([...selectedIds, id]);
    }
  };

  const triggerLabel = (() => {
    if (selectedIds.length === 0) return 'Do‘konlarni tanlang…';
    if (selectedIds.length === 1) {
      const only = stores.find((s) => s.id === selectedIds[0]);
      return only?.name ?? '1 ta do‘kon';
    }
    return `${selectedIds.length} ta do‘kon tanlandi`;
  })();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          className="w-full justify-between sm:w-80"
          aria-label="Do‘kon tanlash"
        >
          <span className="flex min-w-0 items-center gap-2">
            <Store
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <span className="truncate text-left">{triggerLabel}</span>
          </span>
          <ChevronDown
            className="size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[--radix-popover-trigger-width] p-0">
        <div className="space-y-2 p-2">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Qidirish (lotin yoki kirill)…"
              aria-label="Do‘kon qidirish"
              className="h-9 pl-8 pr-8"
            />
            {search !== '' && (
              <button
                type="button"
                onClick={() => setSearch('')}
                aria-label="Qidiruvni tozalash"
                className="absolute right-2 top-2 rounded-md p-1 text-muted-foreground hover:bg-accent"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
          {selectedIds.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="w-full rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              Tanlovni tozalash ({selectedIds.length})
            </button>
          )}
          <ul
            className="max-h-64 space-y-0.5 overflow-y-auto"
            role="group"
            aria-label="Do‘konlar ro‘yxati"
          >
            {filtered.length === 0 && (
              <li className="px-2 py-3 text-center text-xs text-muted-foreground">
                Do‘kon topilmadi.
              </li>
            )}
            {filtered.map((s) => {
              const checked = selectedSet.has(s.id);
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    onClick={() => toggle(s.id)}
                    className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                  >
                    <span
                      className={cn(
                        'flex size-4 shrink-0 items-center justify-center rounded border',
                        checked
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-input',
                      )}
                      aria-hidden="true"
                    >
                      {checked && <Check className="size-3" />}
                    </span>
                    <span className="truncate">{s.name}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </PopoverContent>
    </Popover>
  );
}
