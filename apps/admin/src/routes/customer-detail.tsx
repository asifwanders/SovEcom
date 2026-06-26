import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { t } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Breadcrumbs } from '@/components/layout/breadcrumbs';
import { ArrowLeft, User, Building2, CheckCircle, XCircle } from 'lucide-react';

interface Customer {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
  isB2b: boolean;
  vatNumber: string | null;
  vatValidated: boolean;
  vatValidatedAt: string | null;
  taxExempt: boolean;
  acceptsMarketing: boolean;
  createdAt: string;
  updatedAt: string;
  anonymizedAt: string | null;
}

interface Address {
  id: string;
  label: string | null;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  address1: string;
  address2: string | null;
  city: string;
  postalCode: string;
  country: string;
  phone: string | null;
}

export default function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { data: customer, isLoading } = useQuery<Customer>({
    queryKey: ['customer', id],
    queryFn: () => apiFetch(`/admin/v1/customers/${id}`),
    enabled: !!id,
  });

  const { data: addresses } = useQuery<Address[]>({
    queryKey: ['customer-addresses', id],
    queryFn: () => apiFetch(`/admin/v1/customers/${id}/addresses`),
    enabled: !!id,
  });

  if (isLoading) {
    return <div className="p-6 text-muted-foreground">{t('common', 'loading')}</div>;
  }

  if (!customer) {
    return (
      <div className="p-6">
        <Alert variant="destructive">Customer not found.</Alert>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <Breadcrumbs
        items={[
          { label: t('layout', 'dashboard'), to: '/dashboard' },
          { label: t('layout', 'customers'), to: '/customers' },
          { label: customer.email },
        ]}
      />
      <Button variant="ghost" onClick={() => navigate('/customers')} className="-ml-2">
        <ArrowLeft className="h-4 w-4 mr-2" /> Back to customers
      </Button>

      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold">{customer.name ?? customer.email}</h1>
        {customer.anonymizedAt && <Badge variant="destructive">Anonymized</Badge>}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <User className="h-5 w-5" /> Profile
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-muted-foreground">Email</p>
              <p className="font-medium">{customer.email}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Phone</p>
              <p className="font-medium">{customer.phone ?? '—'}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Created</p>
              <p className="font-medium">{new Date(customer.createdAt).toLocaleDateString()}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Updated</p>
              <p className="font-medium">{new Date(customer.updatedAt).toLocaleDateString()}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Building2 className="h-5 w-5" /> Business
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-muted-foreground">Type</p>
              <Badge variant={customer.isB2b ? 'primary' : 'secondary'}>
                {customer.isB2b ? 'B2B' : 'B2C'}
              </Badge>
            </div>
            <div>
              <p className="text-muted-foreground">Tax exempt</p>
              <p className="font-medium">{customer.taxExempt ? 'Yes' : 'No'}</p>
            </div>
            <div>
              <p className="text-muted-foreground">VAT number</p>
              <p className="font-medium flex items-center gap-1">
                {customer.vatNumber ?? '—'}
                {customer.vatNumber &&
                  (customer.vatValidated ? (
                    <CheckCircle className="h-4 w-4 text-success" />
                  ) : (
                    <XCircle className="h-4 w-4 text-warning" />
                  ))}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">Marketing</p>
              <p className="font-medium">{customer.acceptsMarketing ? 'Opted in' : 'Opted out'}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Addresses</CardTitle>
        </CardHeader>
        <CardContent>
          {addresses && addresses.length > 0 ? (
            <div className="space-y-3">
              {addresses.map((addr) => (
                <div key={addr.id} className="p-3 rounded-md border border-border text-sm">
                  <p className="font-medium">{addr.label ?? 'Address'}</p>
                  <p>
                    {addr.firstName} {addr.lastName}
                  </p>
                  {addr.company && <p className="text-muted-foreground">{addr.company}</p>}
                  <p>
                    {addr.address1}
                    {addr.address2 ? `, ${addr.address2}` : ''}
                  </p>
                  <p>
                    {addr.postalCode} {addr.city}, {addr.country}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground">No addresses on file.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
