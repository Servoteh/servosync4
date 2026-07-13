-- Talas D / D3 (#4): force-change gate na 2.0 `users` (paritet 1.0 user_roles.must_change_password).
-- Bezbedno/idempotentno: NOT NULL DEFAULT false → postojeći redovi dobijaju false, bez lockout-a.
-- NIJE primenjeno na prod ovim talasom (dizajn-prvo); ide kroz `prisma migrate deploy` na cutover-u.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "must_change_password" BOOLEAN NOT NULL DEFAULT false;
