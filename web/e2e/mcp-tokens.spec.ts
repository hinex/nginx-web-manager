import { test, expect } from "@playwright/test";

// Runs AFTER happy-path.spec.ts (alphabetical, workers: 1), which changes
// the admin credentials to test@test.com / testpassword123.
test.describe("API tokens + MCP endpoint", () => {
  test("create scoped token, call MCP, revoke, get rejected", async ({ page, request }) => {
    // ── Login ──
    await page.goto("/login");
    await page.getByLabel("Email").fill("test@test.com");
    await page.getByLabel("Password").fill("testpassword123");
    await page.getByRole("button", { name: "Sign In" }).click();
    await expect(page).toHaveURL(/\/admin/);

    // ── Create a read-only token ──
    await page.goto("/admin/security", { waitUntil: "networkidle" });
    await page.getByLabel("Token name").fill("e2e-token");
    await page.getByRole("checkbox", { name: "configs:read" }).click();
    await expect(page.getByRole("button", { name: "Create Token" })).toBeEnabled();
    await page.getByRole("button", { name: "Create Token" }).click();

    const token = (await page.getByTestId("created-token").textContent())?.trim();
    expect(token).toMatch(/^ngm_/);

    // ── MCP tools/list with the token (request fixture has no session cookies) ──
    const listRes = await request.post("/api/mcp", {
      headers: { Authorization: `Bearer ${token}` },
      data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(listRes.ok()).toBeTruthy();
    const listBody = await listRes.json();
    const names = listBody.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("read_config");
    expect(names).toContain("list_configs");
    expect(names).not.toContain("write_config");
    expect(names).not.toContain("reload_nginx");

    // ── Without a token → 401 ──
    const anonRes = await request.post("/api/mcp", {
      data: { jsonrpc: "2.0", id: 2, method: "tools/list" },
    });
    expect(anonRes.status()).toBe(401);

    // ── Revoke and verify rejection ──
    await page.getByRole("button", { name: "Revoke e2e-token" }).click();
    await expect(page.getByText("revoked", { exact: true })).toBeVisible();

    const revokedRes = await request.post("/api/mcp", {
      headers: { Authorization: `Bearer ${token}` },
      data: { jsonrpc: "2.0", id: 3, method: "tools/list" },
    });
    expect(revokedRes.status()).toBe(401);
  });
});
