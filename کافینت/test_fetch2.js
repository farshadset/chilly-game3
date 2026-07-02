async function fetchDirect(url, options = {}) {
    const saved = {};
    const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'];
    for (const key of keys) {
        if (process.env[key]) { saved[key] = process.env[key]; delete process.env[key]; }
    }
    try {
        const res = await fetch(url, options);
        return res;
    } finally {
        Object.assign(process.env, saved);
    }
}

(async () => {
    try {
        const res = await fetchDirect('https://api.rawg.io/api/games?key=test&page_size=1');
        console.log('status:', res.status);
        console.log('body:', await res.text());
    } catch (e) {
        console.log('error:', e.message);
    }
})();
