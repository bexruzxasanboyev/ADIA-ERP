import * as React from 'react';
import { Input } from './input';

/**
 * Project-wide formatted number input (owner convention): every numeric
 * entry shows space-grouped thousands AS YOU TYPE — "1 000 000" — while the
 * parent receives a clean `number | null`. Use this instead of a raw
 * `<Input type="number">` for ANY amount / qty / price / level field.
 *
 *   <NumberInput value={qty} onValueChange={setQty} />            // integer
 *   <NumberInput value={kg} onValueChange={setKg} decimals />     // fractional
 *
 * The grouping uses a regular space (uz-UZ style, mirrors `formatPlainNumber`).
 * `decimals` allows a single `.` for fractional units (kg / l). The caret
 * sits at the end after reformatting — fine for these short amount fields.
 */
export interface NumberInputProps
  extends Omit<
    React.InputHTMLAttributes<HTMLInputElement>,
    'value' | 'onChange' | 'type'
  > {
  /** Current numeric value (`null` / empty when blank). */
  value: number | null | '';
  /** Called with the parsed number, or `null` when the field is cleared. */
  onValueChange: (value: number | null) => void;
  /** Allow a single decimal point for fractional units (kg, l). */
  decimals?: boolean;
}

/** Group an integer-digit string into space-separated thousands. */
function groupThousands(intDigits: string): string {
  return intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** Strip everything except digits (and one `.` when decimals are allowed). */
function sanitize(input: string, decimals: boolean): string {
  let s = input.replace(/\s/g, '');
  if (decimals) {
    s = s.replace(/[^0-9.]/g, '');
    const i = s.indexOf('.');
    if (i !== -1) {
      s = s.slice(0, i + 1) + s.slice(i + 1).replace(/\./g, '');
    }
  } else {
    s = s.replace(/[^0-9]/g, '');
  }
  return s;
}

/** Format a sanitized raw string ("1234.5") into grouped display ("1 234.5"). */
function formatGrouped(raw: string): string {
  if (raw === '' || raw === '.') return raw;
  const parts = raw.split('.');
  const intPart = parts[0] ?? '';
  const decPart = parts[1];
  const cleanedInt = intPart.replace(/^0+(?=\d)/, '');
  const grouped = groupThousands(cleanedInt === '' ? '0' : cleanedInt);
  return decPart !== undefined ? `${grouped}.${decPart}` : grouped;
}

/** Parse a sanitized raw string to a number, or `null` when blank. */
function parse(raw: string): number | null {
  if (raw === '' || raw === '.') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export const NumberInput = React.forwardRef<HTMLInputElement, NumberInputProps>(
  ({ value, onValueChange, decimals = false, inputMode, ...props }, ref) => {
    const [text, setText] = React.useState<string>(() =>
      value === '' || value == null ? '' : formatGrouped(String(value)),
    );

    // Re-sync the display when the parent pushes a value that differs from
    // what's currently typed (e.g. a dialog opening / a reset). Comparing the
    // numeric values avoids clobbering an in-progress entry like "1." → 1.
    React.useEffect(() => {
      const currentNum = parse(sanitize(text, decimals));
      const next = value === '' ? null : value;
      if (next !== currentNum) {
        setText(next == null ? '' : formatGrouped(String(next)));
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value, decimals]);

    function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
      const cleaned = sanitize(e.target.value, decimals);
      setText(formatGrouped(cleaned));
      onValueChange(parse(cleaned));
    }

    return (
      <Input
        ref={ref}
        type="text"
        inputMode={inputMode ?? (decimals ? 'decimal' : 'numeric')}
        value={text}
        onChange={handleChange}
        {...props}
      />
    );
  },
);
NumberInput.displayName = 'NumberInput';
