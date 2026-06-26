-- Invoice immutability + single-invoice-per-order.
-- Hand-written: drizzle-kit generate cannot emit a trigger or a partial unique index.

-- 1. At most ONE non-credit-note invoice per order (idempotency backstop)
-- A re-emitted / retried `order.paid` must never double-issue. The app pre-checks,
-- but this partial unique index is the DB-level guarantee: a second concurrent
-- `type='invoice'` insert for the same order_id fails (unique_violation), so the
-- second issuance rolls back and consumes no gapless number. Credit notes
-- are excluded so a future credit_note can coexist with its original invoice.
CREATE UNIQUE INDEX "invoices_one_invoice_per_order_uq"
  ON "invoices" ("order_id")
  WHERE "type" = 'invoice';
--> statement-breakpoint

-- 2. Immutability trigger (belt-and-braces, fiscal retention)
-- Once issued, an invoice row is a legal fiscal document: it must never be deleted,
-- and its fiscal columns must never be updated. The ONLY permitted mutation is a
-- one-time attach of the rendered-PDF pointer: `storage_key` NULL -> value (so the
-- post-commit PDF render can record where it stored the file). Any other update, a
-- storage_key value->value/blank, or a delete is rejected at the DB layer regardless
-- of what the app does. Corrections happen via a separate credit note.
CREATE OR REPLACE FUNCTION "invoices_immutability_guard"()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    RAISE EXCEPTION 'invoices are immutable: DELETE is forbidden (id=%)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- UPDATE: the only legal change is attaching the PDF pointer exactly once
  -- (storage_key: NULL -> non-empty). Everything else must be byte-identical.
  IF (OLD.storage_key IS NULL AND NEW.storage_key IS NOT NULL) THEN
    -- Permit ONLY the storage_key transition; every other column must be unchanged.
    IF ROW(
         NEW.id, NEW.tenant_id, NEW.order_id, NEW.type, NEW.series, NEW.invoice_number,
         NEW.issued_at, NEW.seller_snapshot, NEW.buyer_snapshot, NEW.currency,
         NEW.subtotal_amount, NEW.tax_breakdown, NEW.tax_amount, NEW.total_amount,
         NEW.reverse_charge, NEW.vies_consultation_ref, NEW.corrects_invoice_id, NEW.created_at
       ) IS DISTINCT FROM ROW(
         OLD.id, OLD.tenant_id, OLD.order_id, OLD.type, OLD.series, OLD.invoice_number,
         OLD.issued_at, OLD.seller_snapshot, OLD.buyer_snapshot, OLD.currency,
         OLD.subtotal_amount, OLD.tax_breakdown, OLD.tax_amount, OLD.total_amount,
         OLD.reverse_charge, OLD.vies_consultation_ref, OLD.corrects_invoice_id, OLD.created_at
       ) THEN
      RAISE EXCEPTION 'invoices are immutable: only storage_key (NULL->value) may be set (id=%)', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'invoices are immutable: UPDATE is forbidden once issued (id=%)', OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "invoices_immutability_trg"
  BEFORE UPDATE OR DELETE ON "invoices"
  FOR EACH ROW
  EXECUTE FUNCTION "invoices_immutability_guard"();
