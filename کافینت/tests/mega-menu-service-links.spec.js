import { test, expect } from '@playwright/test';

const dynamicServiceItems = [
    { menu: 'games', title: 'PC Games', url: 'games-pc.html' },
    { menu: 'games', title: 'Consoles', url: 'games-consoles.html' },
    { menu: 'games', title: 'Steam Keys', url: 'games-steam-keys.html' },
    { menu: 'accounts', title: 'اکانت Steam', url: 'accounts-steam.html' },
    { menu: 'accounts', title: 'اکانت نو (Fresh)', url: 'accounts-fresh.html' },
    { menu: 'giftcards', title: 'کارت STEAM', url: 'giftcard-steam.html' },
    { menu: 'software', title: 'Game Pass', url: 'subscription-gamepass.html' }
];

test.describe('Mega menu gaming links', () => {
    const baseUrl = 'http://localhost:3005';

    test.beforeEach(async ({ page }) => {
        await page.goto(`${baseUrl}/index.html`, { waitUntil: 'networkidle' });
    });

    for (const item of dynamicServiceItems) {
        test(`opens ${item.title} link`, async ({ page }) => {
            const menuItem = page.locator(`[data-menu="${item.menu}"]`);
            await menuItem.hover({ force: true });

            const link = menuItem.locator('ul a').filter({ hasText: item.title });
            await link.click();

            await expect(page).toHaveURL(new RegExp(item.url));
        });
    }
});