const http = require('http');
const { Agent: UndiciAgent } = require('undici');

async function test() {
    const agent = new UndiciAgent({ connect: { timeout: 5000 } });
    try {
        const res = await fetch('https://api.rawg.io/api/games?key=test&page_size=1', { dispatcher: agent });
        console.log('fetch with agent status:', res.status);
        console.log('fetch with agent body:', await res.text());
    } catch (e) {
        console.log('fetch with agent error:', e.message);
    }
    
    try {
        const res2 = await fetch('https://api.rawg.io/api/games?key=test&page_size=1');
        console.log('fetch default status:', res2.status);
        console.log('fetch default body:', await res2.text());
    } catch (e) {
        console.log('fetch default error:', e.message);
    }

    http.get('https://api.rawg.io/api/games?key=test&page_size=1', (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => console.log('http.get status:', res.statusCode, 'body:', data.slice(0, 200)));
    }).on('error', (e) => console.log('http.get error:', e.message));
}

test();
