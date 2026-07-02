# RAWG Games Integration Plan

## Goal
Integrate RAWG Video Games API to build complete game pages and link them into the existing mega menu, while keeping the site fast and able to handle many concurrent users.

## Architecture Decisions

### 1. Server-Side Proxy (mandatory)
- All RAWG API calls go through Express routes (`/api/games/*`, `/api/rawg/*`)
- API key stored server-side only (`process.env.RAWG_API_KEY` or `.env`)
- Client never sees the key

### 2. Caching Strategy (Critical for speed & quota)
- In-memory LRU cache with TTL 1 hour for list/search responses
- Stale-while-revalidate pattern: serve cached data immediately, refresh in background
- Cache keys: endpoint + query params hash
- Max cache size: 500 entries (fits comfortably in memory)
- Expected quota usage: ~10-20 saved requests per 20,000 monthly limit with 1h TTL

### 3. Rate Limiting & Fallback
- Simple per-IP rate limit: 30 req/min on game API routes
- If RAWG is down: show "data temporarily unavailable" instead of crashing
- Timeout: 10s max per RAWG request

## New Backend Routes (`server.js` additions)

### Data Fetching Helpers
```
function fetchFromRawg(path, params = {}) — adds key, handles errors, caches result
function getCacheKey(path, params) — deterministic cache key
```

### Routes
- `GET /api/games/search?q=&page=&page_size=&genre=&platform=&ordering=` → proxy RAWG `/games`
- `GET /api/games/:slug` → proxy RAWG `/games/:slug` (detail)
- `GET /api/games/:slug/screenshots` → proxy RAWG `/games/:slug/screenshots`
- `GET /api/games/:slug/movies` → proxy RAWG `/games/:slug/movies`
- `GET /api/games/:slug/stores` → proxy RAWG `/games/:slug/stores` (buy links)
- `GET /api/games/:slug/achievements` → proxy RAWG `/games/:slug/achievements`
- `GET /api/ratings` → proxy RAWG `/ratings` (ESRB/PEGI for filter)
- `GET /api/genres` → proxy RAWG `/genres` (cached, rarely changes)

## New Client Pages

### `public/games.html` (Enhanced)
- Search bar with autocomplete (suggestive-search.js pattern)
- Filters: genre, platform, rating sort, price range (free/paid)
- Responsive grid of game cards
- Infinite scroll OR pagination (pagination chosen for mobile performance)
- Each card: cover image, title, genres, rating, release date, platforms
- Click → `game-detail.html?id=<slug>`

### `public/game-detail.html`
Dynamic template driven by client-side JS:
- Hero cover + screenshots carousel
- Game info: title, summary, genres, platforms, release date, developer, publisher, rating, playtime
- Buy/store links (Steam, Epic, GOG, etc.) as prominent buttons
- Similar games carousel (lazy load)
- Achievements section (if available)
- All images lazy-loaded with `loading="lazy"`
- Structured data (JSON-LD) for SEO

### `public/game-card.html` Partial (conceptual)
- Reusable card markup generated client-side for lists

## Mega Menu Updates (`public/app.js`)

Update `MEGA_MENU_DATA.games`:
```js
games: [
  {
    title: '🎮 بازی‌ها (Games)',
    icon: 'fa-gamepad',
    link: 'games.html',
    subItems: [
      { title: 'همه بازی‌ها', link: 'games.html' },
      { title: 'محبوب‌ترین‌ها', link: 'games.html?sort=-added' },
      { title: 'بالاترین امتیاز', link: 'games.html?sort=-rating' },
      { title: 'جدیدترین‌ها', link: 'games.html?ordering=-released' },
      { title: 'بر اساس ژانر', link: 'games.html' },
      { title: 'رایگان (Free to Play)', link: 'games.html?free=true' }
    ]
  },
  // keep existing console/platform sub-items, link to games.html with platform filter
]
```

## CSS Additions (`public/style.css`)

Add to bottom of stylesheet:
- `.game-detail` layout: hero section, info grid, screenshots grid, stores grid
- `.game-detail-hero`: cover image, title overlay, platforms badges
- `.screenshot-grid`: responsive grid with lightbox
- `.store-links`: buttons for each store (Steam green, Epic blue, GOG dark, etc.)
- `.similar-games`: horizontal scroll on mobile, grid on desktop
- `.rating-badge`: ESRB/PEGI badge styles
- Media queries for mobile: stack layouts, smaller fonts
- Skeleton loading states (CSS-only shimmer) for perceived speed

## Performance Optimizations

### Frontend
- `loading="lazy"` on all images below the fold
- IntersectionObserver for infinite scroll / lazy carousels
- CSS containment (`contain: layout paint`) on game cards
- Preconnect to `api.rawg.io` in `<head>`
- Font subsetting (already using Vazirmatn)

### Backend
- Compression: enable `compression` middleware in Express
- Cache-Control headers on API responses: `max-age=3600, stale-while-revalidate=60`
- Static asset caching already in place (staticOptions in server.js)
- Keep-alive connections to RAWG via `node-fetch` keepAlive (default in Node 18+)

### Database (if needed later)
- Optionally pre-warm cache on server start with top 20 games
- No DB schema changes required — RAWG is source of truth

## Migration Steps

1. Add RAWG API key to `.env` (not committed)
2. Add caching module to `server.js`
3. Add proxy routes to `server.js`
4. Install `compression` and `node-fetch` (or check Node 18+ global fetch) — Node 18+ has built-in fetch
5. Create `public/games.html` enhanced listing page
6. Create `public/game-detail.html` detail template
7. Update `public/app.js` `MEGA_MENU_DATA.games` links
8. Add CSS for new layouts
9. Update `public/games-data.js` → keep as fallback, deprecate gracefully or delete after verification
10. Test: load games, detail pages, filters, mobile responsive, mega menu links
11. Verify cache hit rates in server logs

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| RAWG quota exceeded | 1h cache + stale-while-revalidate reduces calls by ~90% |
| RAWG API downtime | Timeout + fallback message; local data fallback |
| Slow images | Lazy load + `srcset` if available; show skeleton |
| Too many concurrent users | Static pages + cached API = cheap to serve; horizontal scale on Vercel |

## Validation

- Load test: simulate 50 concurrent users on `/games` and `/games/:slug`
- Verify cache hit rate >80% after warmup
- Lighthouse score: >90 Performance, >90 Best Practices
- QA: mega menu links open correct pages, filters work, mobile hamburger works
