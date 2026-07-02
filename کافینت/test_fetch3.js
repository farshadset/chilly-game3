async function test() {
    for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) {
        console.log(key, '=', process.env[key] ? 'set' : 'not set');
    }
}

(async () => {
    await test();
    // Now delete and try fetch
    const saved = {};
    for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) {
        if (process.env[key]) { saved[key] = process.env[key]; delete process.env[key]; }
    }
    try {
        const res = await fetch('https://api.rawg.io/api/games?key=test&page_size=1');
        console.log('fetch ok:', res.status);
    } catch (e) {
        console.log('fetch error:', e.message);
    }
    // Restore
    Object.assign(process.env, saved);
    for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) {
        console.log(key, 'after restore =', process.env[key] ? 'set' : 'not set');
    }
})();
