import { defineConfig } from 'vite';

const BANGUMI_SEARCH_URL = 'https://api.bgm.tv/v0/search/subjects';
const BANGUMI_SUBJECTS_URL = 'https://api.bgm.tv/v0/subjects';
const BANGUMI_USER_AGENT = 'uerax/NaniAnime';
const MAX_BODY_SIZE = 16 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk;

      if (body.length > MAX_BODY_SIZE) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });

    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

async function forwardResponse(response, res) {
  const responseBody = await response.text();

  res.statusCode = response.status;
  res.setHeader('content-type', response.headers.get('content-type') || 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(responseBody);
}

async function handleSubjectsRequest(req, res, url) {
  if (req.method !== 'GET') {
    res.setHeader('allow', 'GET');
    sendJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  const response = await fetch(`${BANGUMI_SUBJECTS_URL}${url.search}`, {
    headers: {
      'user-agent': BANGUMI_USER_AGENT,
    },
  });

  await forwardResponse(response, res);
}

async function handleSearchRequest(req, res, url) {
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    sendJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  const body = await readBody(req);
  const response = await fetch(`${BANGUMI_SEARCH_URL}${url.search}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': BANGUMI_USER_AGENT,
    },
    body,
  });

  await forwardResponse(response, res);
}

function bangumiProxy() {
  return async (req, res, next) => {
    const url = new URL(req.url, 'http://localhost');

    try {
      if (url.pathname === '/api/bangumi/subjects') {
        await handleSubjectsRequest(req, res, url);
        return;
      }

      if (url.pathname === '/api/bangumi/search/subjects') {
        await handleSearchRequest(req, res, url);
        return;
      }

      next();
    } catch (_error) {
      sendJson(res, 502, { error: 'Bangumi API 请求失败' });
    }
  };
}

export default defineConfig({
  plugins: [
    {
      name: 'bangumi-api-proxy',
      configureServer(server) {
        server.middlewares.use(bangumiProxy());
      },
      configurePreviewServer(server) {
        server.middlewares.use(bangumiProxy());
      },
    },
  ],
});
