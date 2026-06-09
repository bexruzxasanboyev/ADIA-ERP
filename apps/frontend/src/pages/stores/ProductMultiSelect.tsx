import { useMemo, useState } from 'react';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { matchesSearch } from '@/lib/translit';
import { UNIT_LABELS } from '@/lib/labels';
import { cn } from '@/lib/utils';
import type { Product } from '@/lib/types';

interface ProductMultiSelectProps {
  /** Selectable products (already scoped by the parent). */
  products: Product[];
  /** Currently selected product ids. */
  selectedIds: number[];
  /** Toggle a single product id in/out of the selection. */
  onToggle: (productId: number) => void;
  /** Disabled while the dialog is submitting. */
  disabled?: boolean;
}

/**
 * Do'kon ish joyi — translit-aware multi-select for products, mirroring the
 * products-filter UX (a single trigger opens a searchable checkbox list).
 *
 * Search folds Latin ↔ Cyrillic via the shared `matchesSearch` helper so a
 * cashier can type "shokolad" and match "шоколад". Selection is lifted to
 * the parent via `onToggle`; the trigger shows the running count.
 */
export function ProductMultiSelect({
  products,
  selectedIds,
  onToggle,
  disabled = false,
}: ProductMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const filtered = useMemo(() => {
    if (search.trim() === '') return products;
    return products.filter((p) => matchesSearch(p.name, search));
  }, [products, search]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          className="w-full justify-between"
          aria-label="Mahsulot tanlash"
        >
          <span className="truncate text-left">
            {selectedIds.length === 0
              ? 'Mahsulotlarni tanlang…'
              : `${selectedIds.length} ta mahsulot tanlandi`}
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
              aria-label="Mahsulot qidirish"
              className="h-9 pl-8 pr-8"
            />
            {search !== '' && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setSearch('')}
                aria-label="Qidiruvni tozalash"
                className="absolute right-1.5 top-1.5 size-6 text-muted-foreground"
              >
                <X className="size-4" />
              </Button>
            )}
          </div>
          <ul
            className="max-h-64 space-y-0.5 overflow-y-auto"
            role="group"
            aria-label="Mahsulotlar ro‘yxati"
          >
            {filtered.length === 0 && (
              <li className="px-2 py-3 text-center text-xs text-muted-foreground">
                Mahsulot topilmadi.
              </li>
            )}
            {filtered.map((p) => {
              const checked = selectedSet.has(p.id);
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    onClick={() => onToggle(p.id)}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm hover:bg-accent',
                      checked && 'bg-primary/15 text-primary',
                    )}
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
                    <span className="truncate">{p.name}</span>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      {UNIT_LABELS[p.unit]}
                    </span>
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
