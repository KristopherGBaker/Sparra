/**
 * `conductors/http/auth.ts` — Bearer-token authentication for the HTTP bridge.
 *
 * Fail-closed by design: the service refuses to start without a token (see {@link requireBridgeToken}),
 * and every route except `GET /health` is gated on {@link checkBearer}.
 */

import { timingSafeEqual } from "node:crypto";

const BEARER_PREFIX = "Bearer ";

/**
 * Constant-time string equality that also GUARDS unequal lengths.
 *
 * `crypto.timingSafeEqual` throws when its inputs differ in length, so a naive call would leak length
 * via an exception. We compare lengths first and return false on mismatch — but we do NOT hand-roll a
 * byte loop with an early return on the first differing byte (that leaks WHERE the mismatch is via
 * timing). For equal-length inputs the comparison runs `timingSafeEqual` over the whole buffers, so a
 * wrong token of the correct length still takes the same time regardless of which byte differs.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Parse an `Authorization: Bearer <t>` header and compare `<t>` with `token` in constant time.
 *
 * Returns false for a missing/oddly-shaped header and for a wrong token (including a wrong token of
 * EQUAL length). Returns false when `token` is empty — never an allow-all path.
 */
export function checkBearer(header: string | undefined | null, token: string): boolean {
  // An empty configured token must never authenticate anything (fail-closed).
  if (!token || token.length === 0) return false;
  if (typeof header !== "string" || !header.startsWith(BEARER_PREFIX)) return false;
  const provided = header.slice(BEARER_PREFIX.length);
  if (provided.length === 0) return false;
  return constantTimeEqual(provided, token);
}

/**
 * Read + validate `$SPARRA_BRIDGE_TOKEN`. THROWS when unset or empty so the server can never come up
 * in an allow-all state.
 */
export function requireBridgeToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = env.SPARRA_BRIDGE_TOKEN;
  if (!token || token.length === 0) {
    throw new Error(
      "SPARRA_BRIDGE_TOKEN is unset or empty — refusing to start the Sparra bridge (fail-closed auth)",
    );
  }
  return token;
}
