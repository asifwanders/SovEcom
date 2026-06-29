import React from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Package, RotateCcw, ShoppingCart, CreditCard } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useT } from '@/lib/i18n-context';
import type { AttentionResponse } from './types';

interface AttentionRowProps {
  data: AttentionResponse | undefined;
  isLoading: boolean;
}

interface AttentionTileProps {
  label: string;
  count: number;
  to: string;
  icon: React.ReactNode;
  urgent?: boolean;
}

function AttentionTile({ label, count, to, icon, urgent = false }: AttentionTileProps) {
  return (
    <Link
      to={to}
      className="block group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg"
      aria-label={`${label}: ${count}`}
    >
      <Card className="transition-colors group-hover:border-primary/50 group-focus-visible:border-primary">
        <CardContent className="flex items-center gap-4 p-4">
          <div
            className={`rounded-full p-2 ${
              urgent && count > 0
                ? 'bg-destructive/10 text-destructive'
                : 'bg-muted text-muted-foreground'
            }`}
            aria-hidden="true"
          >
            {icon}
          </div>
          <div>
            <div
              className={`text-2xl font-bold tabular-nums ${
                urgent && count > 0 ? 'text-destructive' : 'text-foreground'
              }`}
            >
              {count.toLocaleString()}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

export function AttentionRow({ data, isLoading }: AttentionRowProps) {
  const { t } = useT();

  if (isLoading) {
    return (
      <div
        className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5"
        aria-label="Loading attention tiles"
      >
        {Array.from({ length: 5 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="p-4">
              <Skeleton className="h-10 w-10 rounded-full mb-3" />
              <Skeleton className="h-7 w-12 mb-1" />
              <Skeleton className="h-3 w-20" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  const tiles: AttentionTileProps[] = [
    {
      label: t('dashboard', 'attentionLowStock'),
      count: data?.lowStock.count ?? 0,
      to: '/products?inStock=low',
      icon: <Package className="h-5 w-5" />,
      urgent: false,
    },
    {
      label: t('dashboard', 'attentionOutOfStock'),
      count: data?.outOfStock.count ?? 0,
      to: '/products?inStock=false',
      icon: <Package className="h-5 w-5" />,
      urgent: true,
    },
    {
      label: t('dashboard', 'attentionPendingReturns'),
      count: data?.pendingReturns ?? 0,
      to: '/returns',
      icon: <RotateCcw className="h-5 w-5" />,
      urgent: true,
    },
    {
      label: t('dashboard', 'attentionUnfulfilled'),
      count: data?.unfulfilledOrders ?? 0,
      to: '/orders?status=paid',
      icon: <ShoppingCart className="h-5 w-5" />,
      urgent: false,
    },
    {
      label: t('dashboard', 'attentionPendingPayment'),
      count: data?.pendingPaymentOrders ?? 0,
      to: '/orders?status=pending_payment',
      icon: <CreditCard className="h-5 w-5" />,
      urgent: false,
    },
  ];

  return (
    <section aria-labelledby="attention-heading">
      <div className="flex items-center gap-2 mb-3">
        <AlertTriangle className="h-4 w-4 text-warning" aria-hidden="true" />
        <h2
          id="attention-heading"
          className="text-sm font-semibold uppercase tracking-wide text-muted-foreground"
        >
          {t('dashboard', 'attentionTitle')}
        </h2>
      </div>
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
        {tiles.map((tile) => (
          <AttentionTile key={tile.to} {...tile} />
        ))}
      </div>
    </section>
  );
}
