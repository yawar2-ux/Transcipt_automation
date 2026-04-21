const http = require('http');

async function testRequest(transcript) {
    const data = JSON.stringify({ transcript });
    const options = {
        hostname: 'localhost',
        port: 3000,
        path: '/process-thought',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': data.length
        }
    };

    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            let responseBody = '';
            res.on('data', (chunk) => { responseBody += chunk; });
            res.on('end', () => {
                console.log(`\n--- Test for: "${transcript}" ---`);
                console.log("Status:", res.statusCode);
                console.log("Response:", responseBody);
                resolve();
            });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

async function runTests() {
    try {
        await testRequest("Can you explain the current dashboard implementation?");
        await testRequest("Explain common load balancing algorithms for high-scale systems.");
        process.exit(0);
    } catch (err) {
        console.error("Test failed:", err);
        process.exit(1);
    }
}

runTests();
