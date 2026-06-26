import React from 'react';
import { cn } from '@/lib/utils';
import { AlertCircle, AlertTriangle, Info, CheckCircle } from 'lucide-react';

export interface AlertProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'destructive' | 'warning' | 'success';
}

export const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  ({ className, variant = 'default', children, ...props }, ref) => {
    const variants = {
      default: 'bg-info/10 text-info border-info/20',
      destructive: 'bg-destructive/10 text-destructive border-destructive/20',
      warning: 'bg-warning/10 text-warning border-warning/20',
      success: 'bg-success/10 text-success border-success/20',
    };
    const icons = {
      default: Info,
      destructive: AlertCircle,
      warning: AlertTriangle,
      success: CheckCircle,
    };
    const Icon = icons[variant];
    return (
      <div
        ref={ref}
        role="alert"
        className={cn('relative w-full rounded-lg border p-4', variants[variant], className)}
        {...props}
      >
        <div className="flex items-start gap-3">
          <Icon className="h-5 w-5 shrink-0 mt-0.5" aria-hidden="true" />
          <div className="text-sm">{children}</div>
        </div>
      </div>
    );
  },
);
Alert.displayName = 'Alert';
