-- ca:compat additive (nullable columns; older versions ignore them and report with the regular method)

-- GST/HST Quick Method election and remittance rates per sales tax code.
ALTER TABLE "TaxRegistration" ADD COLUMN "quickMethodFrom" DATE;
ALTER TABLE "TaxRegistration" ADD COLUMN "quickMethodRates" JSONB;
