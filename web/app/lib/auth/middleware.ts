import { redirect } from "react-router";
import { getSessionUser } from "./session.server";
import { db } from "~/lib/db/connection";
import { settings } from "~/lib/db/schema";
import { eq } from "drizzle-orm";

function getClientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "127.0.0.1"
  );
}

function isIpAllowed(ip: string, whitelist: string[]): boolean {
  if (whitelist.length === 0) return true;
  return whitelist.some((entry) => {
    entry = entry.trim();
    if (entry.includes("/")) {
      return isIpInCidr(ip, entry);
    }
    return ip === entry;
  });
}

function isIpInCidr(ip: string, cidr: string): boolean {
  const [range, bits] = cidr.split("/");
  const mask = ~(2 ** (32 - parseInt(bits)) - 1) >>> 0;
  const ipNum = ipToNum(ip);
  const rangeNum = ipToNum(range);
  return (ipNum & mask) === (rangeNum & mask);
}

function ipToNum(ip: string): number {
  return ip.split(".").reduce((acc, oct) => (acc << 8) + parseInt(oct), 0) >>> 0;
}

async function checkIpWhitelist(request: Request) {
  const row = db
    .select()
    .from(settings)
    .where(eq(settings.key, "ip_whitelist"))
    .get();
  const whitelist =
    row?.value
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? [];
  if (whitelist.length === 0) return; // No whitelist = allow all

  const clientIp = getClientIp(request);
  if (!isIpAllowed(clientIp, whitelist)) {
    throw new Response("Forbidden: IP not in whitelist", { status: 403 });
  }
}

export { getClientIp };

export async function requireAuth(request: Request) {
  await checkIpWhitelist(request);
  const user = await getSessionUser(request);
  if (!user) {
    throw redirect("/login");
  }
  return user;
}

export async function requireAdmin(request: Request) {
  const user = await requireAuth(request);
  if (user.role !== "admin") {
    throw new Response("Forbidden", { status: 403 });
  }
  return user;
}

export async function requireEditor(request: Request) {
  const user = await requireAuth(request);
  if (user.role === "viewer") {
    throw new Response("Forbidden", { status: 403 });
  }
  return user;
}
