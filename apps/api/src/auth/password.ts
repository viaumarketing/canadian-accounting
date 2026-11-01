import { hash, verify, Algorithm } from '@node-rs/argon2';

// Argon2id, OWASP-recommended minimum (19 MiB, t=2, p=1).
const OPTS = { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (pw: string) => hash(pw, OPTS);

export async function verifyPassword(stored: string, pw: string): Promise<boolean> {
  try {
    return await verify(stored, pw);
  } catch {
    return false;
  }
}

let dummy: Promise<string> | undefined;
/** Burn equivalent CPU for unknown accounts so response time doesn't reveal which emails exist. */
export async function dummyVerify(pw: string): Promise<void> {
  dummy ??= hashPassword('dummy-password-for-timing');
  await verifyPassword(await dummy, pw);
}
