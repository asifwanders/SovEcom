import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '@/lib/query-client';
import { LocaleProvider } from '@/lib/i18n-context';
import { AuthGuard } from '@/components/auth/auth-guard';
import { useAuthStore } from '@/lib/auth';
import AuthenticatedLayout from '@/routes/_layout';
import LoginPage from '@/routes/login';
import TwoFactorPage from '@/routes/two-factor';
import TwoFactorSetupPage from '@/routes/two-factor-setup';
import ForgotPasswordPage from '@/routes/forgot-password';
import ResetPasswordPage from '@/routes/reset-password';
import DashboardPage from '@/routes/dashboard';
import ProductsPage from '@/routes/products';
import ProductFormPage from '@/routes/product-form';
import CategoriesPage from '@/routes/categories';
import TagsPage from '@/routes/tags';
import CustomersPage from '@/routes/customers';
import CustomerDetailPage from '@/routes/customer-detail';
import AuditLogPage from '@/routes/audit-log';
import OrdersPage from '@/routes/orders';
import OrderDetailPage from '@/routes/order-detail';
import ReturnsPage from '@/routes/returns';
import EmailLogPage from '@/routes/email-log';
import DisputesPage from '@/routes/disputes';
import DiscountsPage from '@/routes/discounts';
import ShippingPage from '@/routes/shipping';
import TaxesPage from '@/routes/taxes';
import WebhooksPage from '@/routes/webhooks';
import ThemesPage from '@/routes/themes';
import SlotsPage from '@/routes/slots';
import ModulesPage from '@/routes/modules';
import AnalyticsPage from '@/routes/analytics';
import PagesPage from '@/routes/pages';
import PageFormPage from '@/routes/page-form';
import BusinessIdentityPage from '@/routes/business-identity';

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '/api';

function App() {
  const setAccessToken = useAuthStore((s) => s.setAccessToken);
  const setUser = useAuthStore((s) => s.setUser);
  const setIsLoading = useAuthStore((s) => s.setIsLoading);
  const logout = useAuthStore((s) => s.logout);

  // On hard reload, attempt a silent refresh using the httpOnly cookie before
  // AuthGuard renders — so a logged-in user never sees a false redirect to /login.
  React.useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/admin/v1/auth/refresh`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
        });
        if (cancelled) return;
        if (res.ok) {
          const data = (await res.json()) as { accessToken: string };
          setAccessToken(data.accessToken);
          // Fetch current user profile
          try {
            const meRes = await fetch(`${API_BASE}/admin/v1/auth/me`, {
              credentials: 'include',
              headers: { Authorization: `Bearer ${data.accessToken}` },
            });
            if (!cancelled && meRes.ok) {
              const user = await meRes.json();
              setUser(user);
            }
          } catch {
            // non-fatal — access token is still valid
          }
        } else {
          // No valid session — clear state so AuthGuard can redirect to login
          if (!cancelled) logout();
        }
      } catch {
        if (!cancelled) logout();
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []); // intentionally empty — runs once on app mount to bootstrap the session

  return (
    <LocaleProvider>
      <QueryClientProvider client={queryClient}>
        {/* basename = the build-time base ('/' for root/subdomain hosting, '/admin/' when
            served under a sub-path) so the SPA routes resolve under whatever path Caddy mounts it at. */}
        <BrowserRouter basename={import.meta.env.BASE_URL}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/2fa" element={<TwoFactorPage />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="/reset-password" element={<ResetPasswordPage />} />
            <Route
              element={
                <AuthGuard>
                  <AuthenticatedLayout />
                </AuthGuard>
              }
            >
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              <Route path="/products" element={<ProductsPage />} />
              <Route path="/products/new" element={<ProductFormPage />} />
              <Route path="/products/:id" element={<ProductFormPage />} />
              <Route path="/categories" element={<CategoriesPage />} />
              <Route path="/tags" element={<TagsPage />} />
              <Route path="/pages" element={<PagesPage />} />
              <Route path="/pages/new" element={<PageFormPage />} />
              <Route path="/pages/:id" element={<PageFormPage />} />
              <Route path="/customers" element={<CustomersPage />} />
              <Route path="/customers/:id" element={<CustomerDetailPage />} />
              <Route path="/orders" element={<OrdersPage />} />
              <Route path="/orders/:id" element={<OrderDetailPage />} />
              <Route path="/returns" element={<ReturnsPage />} />
              <Route path="/email-log" element={<EmailLogPage />} />
              <Route path="/disputes" element={<DisputesPage />} />
              <Route path="/discounts" element={<DiscountsPage />} />
              <Route path="/shipping" element={<ShippingPage />} />
              <Route path="/taxes" element={<TaxesPage />} />
              <Route path="/webhooks" element={<WebhooksPage />} />
              <Route path="/themes" element={<ThemesPage />} />
              <Route path="/slots" element={<SlotsPage />} />
              <Route path="/modules" element={<ModulesPage />} />
              <Route path="/analytics" element={<AnalyticsPage />} />
              <Route path="/audit-log" element={<AuditLogPage />} />
              <Route path="/business-identity" element={<BusinessIdentityPage />} />
              <Route path="/settings" element={<TwoFactorSetupPage />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </LocaleProvider>
  );
}

export default App;
