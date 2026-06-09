import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset transition-colors',
  {
    variants: {
      variant: {
        default: 'bg-secondary text-secondary-foreground ring-border/60',
        secondary: 'bg-secondary text-secondary-foreground ring-border/60',
        outline: 'text-foreground ring-border',
        success: 'bg-success/10 text-success ring-success/30',
        warning: 'bg-warning/10 text-warning ring-warning/30',
        danger: 'bg-destructive/10 text-destructive ring-destructive/30',
        info: 'bg-info/10 text-info ring-info/30',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
