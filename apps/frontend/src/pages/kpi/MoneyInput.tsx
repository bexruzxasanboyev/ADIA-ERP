import { forwardRef } from 'react';
import { Input } from '@/components/ui/input';
import { formatMoneyInput, parseMoneyInput } from '@/lib/format';

interface MoneyInputProps {
  /** Current numeric value, or null when empty. */
  value: number | null;
  /** Fired with the parsed number (null when cleared). */
  onValueChange: (value: number | null) => void;
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
}

/**
 * Thousand-separated so'm input ("1 000 000" format). The displayed
 * string is always re-grouped from the live digits so the boss sees a
 * readable amount while typing; the parent receives a plain number.
 *
 * `inputMode="numeric"` brings up the numeric keypad on mobile and the
 * grouping is purely cosmetic — only digits ever leave the field.
 */
export const MoneyInput = forwardRef<HTMLInputElement, MoneyInputProps>(
  function MoneyInput(
    { value, onValueChange, ...rest },
    ref,
  ) {
    const display = value === null ? '' : formatMoneyInput(String(value));
    return (
      <Input
        ref={ref}
        inputMode="numeric"
        autoComplete="off"
        value={display}
        onChange={(e) => onValueChange(parseMoneyInput(e.target.value))}
        {...rest}
      />
    );
  },
);
