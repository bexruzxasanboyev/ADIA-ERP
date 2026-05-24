import { useState } from 'react';
import { Calendar as CalendarIcon } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * Selected date range — used by the executive dashboard to scope every
 * KPI / chart endpoint. Backend contract:
 *   ?range=today|week|month|custom&from=YYYY-MM-DD&to=YYYY-MM-DD
 */
export type DateRangePreset = 'today' | 'week' | 'month' | 'custom';

export interface DateRangeValue {
  range: DateRangePreset;
  /** Required when `range === 'custom'`. ISO `YYYY-MM-DD`. */
  from?: string;
  /** Required when `range === 'custom'`. ISO `YYYY-MM-DD`. */
  to?: string;
}

/** Serialise a `DateRangeValue` into the `?range=…&from=…&to=…` query string. */
export function dateRangeToQuery(value: DateRangeValue): string {
  if (value.range === 'custom' && value.from && value.to) {
    return `range=custom&from=${value.from}&to=${value.to}`;
  }
  return `range=${value.range}`;
}

interface Props {
  value: DateRangeValue;
  onChange: (next: DateRangeValue) => void;
}

const PRESETS: { id: DateRangePreset; label: string }[] = [
  { id: 'today', label: 'Bugun' },
  { id: 'week', label: 'Hafta' },
  { id: 'month', label: 'Bu oy' },
];

/**
 * F4.10 — premium dark segment-control + custom calendar dialog.
 *
 * Three preset toggles ("Bugun" / "Hafta" / "Bu oy") plus a "Sana oralig'i"
 * trigger that opens a date-range picker. The active preset is the one in
 * `value.range`; switching to `custom` requires picking both endpoints.
 */
export function DateRangeFilter({ value, onChange }: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState(value.from ?? '');
  const [draftTo, setDraftTo] = useState(value.to ?? '');
  const [pickerError, setPickerError] = useState<string | null>(null);

  function selectPreset(preset: DateRangePreset) {
    onChange({ range: preset });
  }

  function openCustom() {
    setDraftFrom(value.from ?? todayIso());
    setDraftTo(value.to ?? todayIso());
    setPickerError(null);
    setPickerOpen(true);
  }

  function applyCustom() {
    if (!draftFrom || !draftTo) {
      setPickerError("Boshlanish va tugash sanasini kiriting.");
      return;
    }
    if (draftFrom > draftTo) {
      setPickerError("Boshlanish sanasi tugash sanasidan keyin bo'lmasin.");
      return;
    }
    onChange({ range: 'custom', from: draftFrom, to: draftTo });
    setPickerOpen(false);
  }

  const customLabel =
    value.range === 'custom' && value.from && value.to
      ? `${value.from} — ${value.to}`
      : "Sana oralig'i";

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid="date-range-filter"
    >
      <div
        role="tablist"
        aria-label="Sana oralig'i tanlash"
        className="inline-flex items-center rounded-md border border-border/60 bg-card/60 p-0.5 shadow-sm backdrop-blur"
      >
        {PRESETS.map((preset) => {
          const active = value.range === preset.id;
          return (
            <button
              key={preset.id}
              type="button"
              role="tab"
              aria-selected={active}
              data-state={active ? 'active' : 'inactive'}
              onClick={() => selectPreset(preset.id)}
              className={cn(
                'h-8 rounded-sm px-3 text-xs font-medium transition-colors',
                active
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
              )}
            >
              {preset.label}
            </button>
          );
        })}
      </div>
      <Button
        type="button"
        variant={value.range === 'custom' ? 'default' : 'outline'}
        size="sm"
        onClick={openCustom}
        data-state={value.range === 'custom' ? 'active' : 'inactive'}
      >
        <CalendarIcon className="size-4" aria-hidden="true" />
        {customLabel}
      </Button>

      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Sana oralig'i</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="range-from">Boshlanish</Label>
              <Input
                id="range-from"
                type="date"
                value={draftFrom}
                onChange={(e) => setDraftFrom(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="range-to">Tugash</Label>
              <Input
                id="range-to"
                type="date"
                value={draftTo}
                onChange={(e) => setDraftTo(e.target.value)}
              />
            </div>
          </div>
          {pickerError && (
            <p className="text-sm text-destructive" role="alert">
              {pickerError}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setPickerOpen(false)}
            >
              Bekor qilish
            </Button>
            <Button type="button" onClick={applyCustom}>
              Qo'llash
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
