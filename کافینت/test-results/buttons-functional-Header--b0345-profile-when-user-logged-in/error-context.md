# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: buttons-functional.spec.js >> Header Buttons - Functional Browser Tests >> Profile button redirects to profile when user logged in
- Location: tests/buttons-functional.spec.js:59:7

# Error details

```
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3004/index.html
Call log:
  - navigating to "http://localhost:3004/index.html", waiting until "networkidle"

```

# Test source

```ts
  1  | import { test, expect } from '@playwright/test';
  2  | import { readFileSync } from 'fs';
  3  | 
  4  | test.describe('Header Buttons - Functional Browser Tests', () => {
  5  |   const baseUrl = 'http://localhost:3004';
  6  | 
  7  |   test.beforeEach(async ({ page }) => {
> 8  |     await page.goto(`${baseUrl}/index.html`, { waitUntil: 'networkidle' });
     |                ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3004/index.html
  9  |   });
  10 | 
  11 |   test('Support button click opens modal', async ({ page }) => {
  12 |     // Click support button
  13 |     await page.click('#supportBtn');
  14 |     
  15 |     // Wait for modal to appear
  16 |     const modal = page.locator('#supportModal');
  17 |     await page.waitForTimeout(500);
  18 |     
  19 |     // Check modal has active class
  20 |     const hasActive = await page.evaluate(() => {
  21 |       const m = document.getElementById('supportModal');
  22 |       return m && m.classList.contains('active');
  23 |     });
  24 |     expect(hasActive).toBeTruthy();
  25 |   });
  26 | 
  27 |   test('Support modal close button works', async ({ page }) => {
  28 |     await page.click('#supportBtn');
  29 |     await page.waitForTimeout(300);
  30 |     
  31 |     // Click close
  32 |     await page.evaluate(() => {
  33 |       const c = document.getElementById('closeModal');
  34 |       if (c) c.click();
  35 |     });
  36 |     
  37 |     await page.waitForTimeout(300);
  38 |     
  39 |     const hasActive = await page.evaluate(() => {
  40 |       const m = document.getElementById('supportModal');
  41 |       return m && m.classList.contains('active');
  42 |     });
  43 |     expect(hasActive).toBeFalsy();
  44 |   });
  45 | 
  46 |   test('Profile button redirects to login when not authenticated', async ({ page }) => {
  47 |     await page.evaluate(() => {
  48 |       localStorage.removeItem('userData');
  49 |       localStorage.removeItem('adminData');
  50 |     });
  51 |     
  52 |     await page.click('#profileBtn');
  53 |     await page.waitForTimeout(500);
  54 |     
  55 |     const url = page.url();
  56 |     expect(url).toContain('login.html');
  57 |   });
  58 | 
  59 |   test('Profile button redirects to profile when user logged in', async ({ page }) => {
  60 |     await page.evaluate(() => {
  61 |       localStorage.setItem('userData', JSON.stringify({ username: 'testuser' }));
  62 |     });
  63 |     await page.reload();
  64 |     
  65 |     await page.click('#profileBtn');
  66 |     await page.waitForTimeout(500);
  67 |     
  68 |     const url = page.url();
  69 |     expect(url).toContain('profile.html');
  70 |   });
  71 | });
```