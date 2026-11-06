import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';
import type { ButtonHTMLAttributes } from 'react';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-full text-sm font-medium transition-all outline-none select-none cursor-pointer focus-visible:ring-2 focus-visible:ring-fd-ring focus-visible:ring-offset-2 focus-visible:ring-offset-fd-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary:
          'bg-fd-primary text-fd-primary-foreground shadow-[0_0_0_1px_rgba(255,255,255,0.08)_inset,0_8px_30px_rgba(0,0,0,0.35)] hover:brightness-125 active:brightness-95 h-11 px-7',
        secondary:
          'border border-fd-border bg-fd-card/60 text-fd-foreground backdrop-blur hover:bg-fd-accent h-11 px-7',
        ghost: 'text-fd-muted-foreground hover:text-fd-foreground h-9 px-4',
      },
    },
    defaultVariants: {
      variant: 'primary',
    },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, ...props }: ButtonProps) {
  return (
    <button
      className={cn(buttonVariants({ variant }), className)}
      {...props}
    />
  );
}

export { buttonVariants };
