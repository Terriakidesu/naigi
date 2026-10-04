/**
 * Host-operator console page gating.
 *
 * The console's HTML pages are server-owned, but the data behind them is authorised per request.
 * These helpers decide which page a request may render: an unauthenticated caller always receives
 * the login page, and an operator lacking a capability is redirected rather than shown a shell it
 * cannot populate.
 */

import { authenticateAdmin } from "../admin-auth/session";
import { adminCan, type AdminCapability } from "../admin-auth/permissions";
import { publicFile } from "../http/static-files";

export async function adminPageResponse(
  cookie: string | undefined,
  page: string,
  requiredCapability?: AdminCapability,
) {
  const operator = await authenticateAdmin(cookie);
  if (!operator) return publicFile("instance-admin-login.html", "text/html; charset=utf-8");
  if (requiredCapability && !adminCan(operator.role, requiredCapability)) {
    return new Response(null, {
      status: 302,
      headers: { location: "/instance-admin", "cache-control": "no-store" },
    });
  }
  return publicFile(page, "text/html; charset=utf-8");
}
