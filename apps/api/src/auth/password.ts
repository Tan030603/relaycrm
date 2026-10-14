import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

// Argon2id with the OWASP baseline (19 MiB, 2 passes, 1 lane), from Node's built-in crypto.
const PARAMS = { memory: 19456, passes: 2, parallelism: 1, tagLength: 32 };

function derive(password: string, nonce: Buffer, p = PARAMS): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    argon2('argon2id', { message: password, nonce, ...p }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

/** Format: argon2id$m=19456,t=2,p=1$<salt b64>$<hash b64> */
export async function hashPassword(password: string): Promise<string> {
  const nonce = randomBytes(16);
  const hash = await derive(password, nonce);
  const { memory: m, passes: t, parallelism: p } = PARAMS;
  return `argon2id$m=${m},t=${t},p=${p}$${nonce.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, params, salt, hash] = stored.split('$');
  if (alg !== 'argon2id' || !params || !salt || !hash) return false;
  const kv = Object.fromEntries(params.split(',').map((s) => s.split('=')));
  const expected = Buffer.from(hash, 'base64');
  const actual = await derive(password, Buffer.from(salt, 'base64'), {
    memory: Number(kv.m),
    passes: Number(kv.t),
    parallelism: Number(kv.p),
    tagLength: expected.length,
  });
  return timingSafeEqual(actual, expected);
}

// Verified against when the email is unknown, so a wrong email takes as long as a
// wrong password and response time does not reveal which emails have accounts.
export const DUMMY_HASH = hashPassword(randomBytes(16).toString('hex'));
