-- ca:compat additive (older versions ignore the column and simply do not block replays)

-- TOTP replay protection: the time step of the last accepted authenticator code.
ALTER TABLE "User" ADD COLUMN "mfaLastStep" INTEGER;
