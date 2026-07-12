import { test, expect } from "@playwright/test";

test.describe("Happy path: setup → login → create host", () => {
  test("complete first-user flow", async ({ page }) => {
    // ── Step 1: Navigate to app — should redirect to login ──
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByText("Nginx Manager")).toBeVisible();

    // ── Step 2: Login with default credentials ──
    await page.getByLabel("Email").fill("admin@example.com");
    await page.getByLabel("Password").fill("changeme");
    await page.getByRole("button", { name: "Sign In" }).click();

    // ── Step 3: Should redirect to setup (mustChangePassword) ──
    await expect(page).toHaveURL(/\/admin\/setup/);
    await expect(page.getByText("Initial Setup")).toBeVisible();

    // ── Step 4: Complete setup — change email and password ──
    await page.getByLabel("Email").fill("test@test.com");
    await page.getByLabel("New Password").fill("testpassword123");
    await page.getByLabel("Confirm Password").fill("testpassword123");
    await page.getByRole("button", { name: "Complete Setup" }).click();

    // ── Step 5: Should redirect to admin dashboard ──
    await expect(page).toHaveURL(/\/admin/);

    // ── Step 6: Navigate to create host ──
    await page.goto("/admin/hosts/new");
    await expect(page.getByText("Add Host")).toBeVisible();

    // ── Step 7: Fill the host form — General tab ──
    // Add a domain — use pressSequentially so React onChange fires per character
    const domainInput = page.getByPlaceholder("example.com");
    await domainInput.click();
    await domainInput.pressSequentially("test.example.com");
    await domainInput.press("Enter");
    await page.screenshot({ path: "debug-domain.png" });
    // Verify domain badge appeared
    await expect(page.getByText("test.example.com")).toBeVisible();

    // ── Step 8: Switch to Locations tab and add upstream ──
    await page.getByRole("tab", { name: "Locations" }).click();
    // Default location "/" should already be expanded (only 1 location)
    // Add upstream
    await page.getByRole("button", { name: "Add Upstream" }).click();
    // Fill upstream server and port — use pressSequentially so React onChange fires per character
    const serverInput = page.getByPlaceholder("Server");
    await serverInput.click();
    await serverInput.pressSequentially("127.0.0.1");
    // Port field has default value 80, need to clear first
    const portInput = page.getByPlaceholder("Port").first();
    await portInput.click();
    await portInput.selectText();
    await portInput.pressSequentially("3000");

    // ── Step 9: Publish the host ──
    await page.getByRole("button", { name: "Publish" }).click();

    // ── Step 10: Should redirect to hosts list with the new host ──
    await expect(page).toHaveURL(/\/admin\/hosts/, { timeout: 10000 });
    // Scope to the visible desktop table (the mobile card has md:hidden and is not visible at 1280px)
    await expect(page.locator("table").getByText("test.example.com")).toBeVisible();
  });
});
