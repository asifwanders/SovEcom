import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api';
import { useAuthStore } from '@/lib/auth';
import { can } from '@/lib/permissions';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Alert } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Breadcrumbs } from '@/components/layout/breadcrumbs';
import { Building2 } from 'lucide-react';

/**
 * Business identity — the SELLER details printed on INVOICES (legal mentions, SIREN/SIRET,
 * EU-VAT registration). Edits GET/PUT /admin/v1/business-identity. Money/legal-sensitive,
 * so the server validates strictly; this form surfaces validation errors + a save success.
 * `settings:write` gates the form (read-only otherwise).
 */
interface BusinessAddress {
  name: string | null;
  company: string | null;
  line1: string;
  line2: string | null;
  city: string;
  postalCode: string | null;
  country: string;
}
interface BusinessIdentityView {
  identity: {
    name: string | null;
    siren: string | null;
    address: BusinessAddress | null;
  };
  euVatRegistration: {
    originCountry: string | null;
    vatNumber: string | null;
  };
}

export default function BusinessIdentityPage() {
  const queryClient = useQueryClient();
  const role = useAuthStore((s) => s.user?.role);
  const canWrite = can(role, 'settings:write');

  const q = useQuery<BusinessIdentityView>({
    queryKey: ['business-identity'],
    queryFn: () => apiFetch('/admin/v1/business-identity'),
  });

  const [name, setName] = React.useState('');
  const [siren, setSiren] = React.useState('');
  const [line1, setLine1] = React.useState('');
  const [line2, setLine2] = React.useState('');
  const [city, setCity] = React.useState('');
  const [postalCode, setPostalCode] = React.useState('');
  const [country, setCountry] = React.useState('');
  const [vatNumber, setVatNumber] = React.useState('');
  const [originCountry, setOriginCountry] = React.useState('');
  const [err, setErr] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  // Hydrate the form once the settings load.
  React.useEffect(() => {
    if (!q.data) return;
    const { identity, euVatRegistration } = q.data;
    setName(identity.name ?? '');
    setSiren(identity.siren ?? '');
    setLine1(identity.address?.line1 ?? '');
    setLine2(identity.address?.line2 ?? '');
    setCity(identity.address?.city ?? '');
    setPostalCode(identity.address?.postalCode ?? '');
    setCountry(identity.address?.country ?? '');
    setVatNumber(euVatRegistration.vatNumber ?? '');
    setOriginCountry(euVatRegistration.originCountry ?? '');
  }, [q.data]);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch('/admin/v1/business-identity', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => {
      setErr(null);
      setSaved(true);
      void queryClient.invalidateQueries({ queryKey: ['business-identity'] });
    },
    onError: (e: unknown) =>
      setErr(e instanceof ApiError ? e.message : 'Could not save the business identity.'),
  });

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSaved(false);
    setErr(null);

    // An address is only sent when its required parts (line1/city/country) are all present;
    // otherwise the address is cleared (null) so the server's strict validation never trips.
    const hasAddress = Boolean(line1.trim() && city.trim() && country.trim());
    const body: Record<string, unknown> = {
      name: name.trim() || null,
      siren: siren.trim() || null,
      address: hasAddress
        ? {
            line1: line1.trim(),
            line2: line2.trim() || null,
            city: city.trim(),
            postalCode: postalCode.trim() || null,
            country: country.trim().toUpperCase(),
          }
        : null,
      originCountry: originCountry.trim() ? originCountry.trim().toUpperCase() : null,
      vatNumber: vatNumber.trim() || null,
    };
    save.mutate(body);
  };

  return (
    <div className="p-6 space-y-6">
      <Breadcrumbs items={[{ label: 'Business identity' }]} />
      <div className="flex items-center gap-3">
        <Building2 className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
        <div>
          <h1 className="text-2xl font-semibold">Business identity</h1>
          <p className="text-sm text-muted-foreground">
            Seller details printed on invoices — legal name, address, SIREN/SIRET and EU-VAT
            registration. These appear on binding documents, so they are validated strictly.
          </p>
        </div>
      </div>

      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <Alert variant="destructive">Could not load the business identity.</Alert>}

      {q.data && (
        <form onSubmit={onSubmit} className="max-w-2xl space-y-6">
          <Card className="p-5 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Legal / trading name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Acme SARL"
                disabled={!canWrite}
              />
              <p className="text-xs text-muted-foreground">
                Printed as the seller name. Falls back to the store name when empty.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="siren">SIREN / SIRET</Label>
              <Input
                id="siren"
                value={siren}
                onChange={(e) => setSiren(e.target.value)}
                placeholder="123 456 789"
                disabled={!canWrite}
                className="font-mono"
              />
            </div>
          </Card>

          <Card className="p-5 space-y-4">
            <h2 className="text-sm font-medium">Registered address</h2>
            <div className="space-y-2">
              <Label htmlFor="line1">Address line 1</Label>
              <Input
                id="line1"
                value={line1}
                onChange={(e) => setLine1(e.target.value)}
                placeholder="1 rue de Paris"
                disabled={!canWrite}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="line2">Address line 2</Label>
              <Input
                id="line2"
                value={line2}
                onChange={(e) => setLine2(e.target.value)}
                disabled={!canWrite}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="postalCode">Postal code</Label>
                <Input
                  id="postalCode"
                  value={postalCode}
                  onChange={(e) => setPostalCode(e.target.value)}
                  placeholder="75001"
                  disabled={!canWrite}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="city">City</Label>
                <Input
                  id="city"
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  placeholder="Paris"
                  disabled={!canWrite}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="country">Country (2-letter code)</Label>
              <Input
                id="country"
                value={country}
                onChange={(e) => setCountry(e.target.value)}
                placeholder="FR"
                maxLength={2}
                disabled={!canWrite}
                className="font-mono uppercase w-24"
              />
              <p className="text-xs text-muted-foreground">
                ISO 3166-1 alpha-2. Line 1, city and country are required together for the address
                to be saved.
              </p>
            </div>
          </Card>

          <Card className="p-5 space-y-4">
            <h2 className="text-sm font-medium">EU-VAT registration</h2>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="originCountry">Country of establishment</Label>
                <Input
                  id="originCountry"
                  value={originCountry}
                  onChange={(e) => setOriginCountry(e.target.value)}
                  placeholder="FR"
                  maxLength={2}
                  disabled={!canWrite}
                  className="font-mono uppercase w-24"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="vatNumber">VAT number</Label>
                <Input
                  id="vatNumber"
                  value={vatNumber}
                  onChange={(e) => setVatNumber(e.target.value)}
                  placeholder="FR12345678901"
                  disabled={!canWrite}
                  className="font-mono"
                />
              </div>
            </div>
          </Card>

          {err && <Alert variant="destructive">{err}</Alert>}
          {saved && <Alert variant="success">Business identity saved.</Alert>}

          {canWrite && (
            <Button type="submit" disabled={save.isPending}>
              Save
            </Button>
          )}
        </form>
      )}
    </div>
  );
}
