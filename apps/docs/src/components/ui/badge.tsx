import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';
import type { HTMLAttributes } from 'react';

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full border text-xs font-medium w-fit whitespace-nowrap transition-colors [&_svg]:size-3',
  {
    variants: {
      variant: {
        neutral:
          'border-fd-border bg-fd-muted/60 text-fd-muted-foreground px-3 py-1',
        available:
          'border-emerald-500/30 bg-emerald-500/10 text-emerald-500 px-2.5 py-0.5',
        planned:
          'border-fd-border bg-fd-card text-fd-muted-foreground px-2.5 py-0.5',
        progress:
          'border-amber-500/30 bg-amber-500/10 text-amber-500 px-2.5 py-0.5',
      },
    },
    defaultVariants: {
      variant: 'neutral',
    },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { badgeVariants };
