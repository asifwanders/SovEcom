import React from 'react';
import { cn } from '@/lib/utils';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: 'default' | 'primary' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning';
}

export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant = 'default', ...props }, ref) => {
    const variants = {
      default: 'bg-primary text-primary-foreground hover:bg-primary-hover',
      primary: 'bg-primary text-primary-foreground hover:bg-primary-hover',
      secondary: 'bg-secondary text-secondary-foreground hover:bg-muted',
      destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
      outline: 'border border-input bg-transparent text-foreground hover:bg-muted',
      success: 'bg-success text-success-foreground hover:bg-success/90',
      warning: 'bg-warning text-warning-foreground hover:bg-warning/90',
    };
    return (
      <span
        ref={ref}
        className={cn(
          'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors',
          variants[variant],
          className,
        )}
        {...props}
      />
    );
  },
);
Badge.displayName = 'Badge';
