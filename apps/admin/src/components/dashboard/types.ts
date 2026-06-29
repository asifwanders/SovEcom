/** Dashboard API types — mirror the exact JSON contract from 3.12a-spec */

export type Granularity = 'day' | 'week' | 'month';
export type TopBy = 'revenue' | 'quantity';

export interface DateRange {
  from: string; // ISO
  to: string; // ISO
}

export interface MetricValue {
  value: number;
  previous: number;
  deltaPct: number | null;
}

export interface SummaryResponse {
  range: DateRange;
  previous: DateRange;
  currency: string;
  metrics: {
    netRevenue: MetricValue;
    orders: MetricValue;
    averageOrderValue: MetricValue;
    newCustomers: MetricValue;
    returnRate: MetricValue;
    refunds: MetricValue;
    cartConversion: MetricValue;
  };
}

export interface TimeseriesPoint {
  bucket: string; // 'YYYY-MM-DD' or truncated ISO
  revenue: number; // integer minor units
  orders: number;
  newCustomers: number; // customers.created_at bucketed (separate CTE)
  refundAmount: number; // succeeded refunds bucketed, integer minor units
}

export interface TimeseriesResponse {
  granularity: Granularity;
  currency: string;
  points: TimeseriesPoint[];
}

export interface TopProductItem {
  productTitle: string;
  variantId: string | null;
  quantitySold: number;
  revenue: number; // integer minor units
}

export interface TopProductsResponse {
  by: TopBy;
  currency: string;
  items: TopProductItem[];
}

export interface StockItem {
  variantId: string;
  productId: string;
  title: string;
  sku: string;
  stockQuantity: number;
}

export interface AttentionResponse {
  lowStockThreshold: number;
  lowStock: { count: number; items: StockItem[] };
  outOfStock: { count: number; items: StockItem[] };
  pendingReturns: number;
  unfulfilledOrders: number;
  pendingPaymentOrders: number;
}

export interface CustomerBreakdownResponse {
  range: DateRange;
  newCustomers: number;
  returningCustomers: number;
  guestOrdersExcluded: true;
}

/** All 9 order statuses (zero-filled by the backend). */
export interface StatusCount {
  status: string;
  count: number;
}

export interface StatusBreakdownResponse {
  range: DateRange;
  statuses: StatusCount[];
}

/** Preset period identifiers */
export type PeriodPreset = 'today' | 'last7' | 'last30' | 'thisMonth' | 'custom';

export interface PeriodState {
  preset: PeriodPreset;
  from: string; // ISO date string YYYY-MM-DD
  to: string; // ISO date string YYYY-MM-DD
}
