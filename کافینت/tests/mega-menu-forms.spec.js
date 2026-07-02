import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'fs';

const BASE_URL = 'http://localhost:3005';

test.describe('Mega Menu Gaming Pages', () => {
    const gamingPages = [
        'games.html', 'accounts.html', 'giftcards.html', 'software.html', 'deals.html',
        'games-pc.html', 'games-consoles.html', 'games-mobile.html', 'games-genre.html',
        'games-steam-keys.html', 'games-epic.html', 'games-xbox.html', 'games-ps5.html', 'games-nintendo.html',
        'accounts-platform.html', 'accounts-type.html', 'accounts-features.html',
        'giftcards-popular.html', 'giftcards-console.html', 'giftcards-mobile.html',
        'giftcard-steam.html', 'giftcard-xbox.html', 'subscription-gamepass.html'
    ];

    for (const pageName of gamingPages) {
        test(`${pageName} exists`, async () => {
            expect(existsSync(`public/${pageName}`)).toBeTruthy();
        });
    }

    test('quick access links in header', async () => {
        const html = readFileSync('public/index.html', 'utf-8');
        expect(html).toContain('class="quick-access"');
        expect(html).toContain('Steam');
        expect(html).toContain('Xbox');
        expect(html).toContain('PlayStation');
        expect(html).toContain('Epic');
        expect(html).toContain('Nintendo');
    });

    test('MEGA_MENU_DATA has gaming categories', async () => {
        const js = readFileSync('public/app.js', 'utf-8');
        expect(js).toContain('games: [');
        expect(js).toContain('accounts: [');
        expect(js).toContain('giftcards: [');
        expect(js).toContain('software: [');
        expect(js).toContain('deals: [');
    });
});