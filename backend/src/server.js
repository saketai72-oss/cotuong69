const http = require('node:http');
const { createCot615Match } = require('./domain/entities/cot615Match');
const { createMatchesHandler } = require('./presentation/http/routes/matches.routes');

function createServer(options = {}) {
  let match = options.match || null;
  const handler = createMatchesHandler({
    getMatch: () => {
      if (!match) {
        match = createCot615Match(options.now ? options.now() : Date.now());
      }
      return match;
    },
    now: options.now || Date.now,
  });

  return http.createServer(handler);
}

if (require.main === module) {
  const port = Number(process.env.PORT || 5000);
  const server = createServer();

  server.listen(port, '127.0.0.1', () => {
    console.log(`Match API listening on http://localhost:${port}`);
    console.log('Read-only development match: GET /api/matches/COT-615');
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close((error) => {
        if (error) {
          console.error('Failed to close Match API server:', error);
          process.exitCode = 1;
        }
      });
    });
  }
}

module.exports = { createServer };
