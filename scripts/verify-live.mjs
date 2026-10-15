// Read-only by default. --exercise creates disposable sandboxes and removes them in finally.
import assert from 'node:assert/strict';
const base = process.env.SANDBOX_BASE_URL;
const key = process.env.SANDBOX_API_KEY;
if (!base || !key?.trim()) throw new Error('Set SANDBOX_BASE_URL and SANDBOX_API_KEY; credentials are never printed.');
const origin = new URL(base);
if (origin.protocol !== 'https:' && origin.hostname !== 'localhost') throw new Error('HTTPS is required.');
const exercise = process.argv.includes('--exercise');
const created = [];
async function request(path, options = {}, auth = key) {
  return fetch(new URL(path, origin), { ...options, redirect: 'error', signal: AbortSignal.timeout(120000), headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...options.headers } });
}
async function expectStatus(path, status, options, auth) {
  const res = await request(path, options, auth);
  assert.equal(res.status, status, `${path}: expected ${status}, received ${res.status}`);
  return res;
}
async function create() {
  const res = await expectStatus('/v1/sandbox', 200, { method: 'POST' });
  const { id } = await res.json();
  assert.match(id, /^[a-z2-7]{1,63}$/);
  created.push(id);
  return `/v1/sandbox/${id}`;
}
try {
  assert.deepEqual(await (await expectStatus('/health', 200, {}, '')).json(), { ok: true });
  for (const path of ['/v1/openapi.json', '/v1/openapi.html', '/v1/pool/stats', '/v1/sandbox']) {
    await expectStatus(path, 401, {}, '');
    await expectStatus(path, 401, {}, 'invalid-verification-key');
  }
  const schema = await (await expectStatus('/v1/openapi.json', 200)).json();
  assert.ok(schema.paths['/v1/sandbox']);
  await expectStatus('/unknown-verification-route', 404);
  console.log('PASS: health, authentication, API schema, unknown route');
  if (exercise) {
    const sandbox = await create();
    const response = await expectStatus(`${sandbox}/exec`, 200, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ argv: ['whoami'], timeout_ms: 10000, cwd: '/workspace' })
    });
    const stream = await response.text();
    let stdout = ''; let exit;
    for (const frame of stream.split(/\r?\n\r?\n/)) {
      const event = frame.match(/^event: (.+)$/m)?.[1];
      const data = [...frame.matchAll(/^data: (.*)$/gm)].map(m => m[1]).join('\n');
      if (event === 'stdout') stdout += Buffer.from(data, 'base64').toString();
      if (event === 'exit') exit = JSON.parse(data).exit_code;
    }
    assert.equal(exit, 0, 'whoami must finish successfully');
    assert.equal(stdout.trim(), 'sandbox', 'commands must run as sandbox');
    const content = `bridge-verification-${crypto.randomUUID()}`;
    await expectStatus(`${sandbox}/file/workspace/verification.txt`, 200, { method: 'PUT', body: content });
    assert.equal(await (await expectStatus(`${sandbox}/file/workspace/verification.txt`, 200)).text(), content);
    await expectStatus(`${sandbox}/file/etc/passwd`, 403);
    const archive = await (await expectStatus(`${sandbox}/persist`, 200, { method: 'POST' })).arrayBuffer();
    const restored = await create();
    await expectStatus(`${restored}/hydrate`, 200, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: archive });
    assert.equal(await (await expectStatus(`${restored}/file/workspace/verification.txt`, 200)).text(), content);
    console.log('PASS: container user, command completion, file round trip, path restriction, snapshot restore');
  }
} finally {
  let cleanupFailed = false;
  for (const id of created.reverse()) {
    try { await expectStatus(`/v1/sandbox/${id}`, 204, { method: 'DELETE' }); }
    catch { console.error(`FAIL: cleanup required for verification sandbox ${id}`); cleanupFailed = true; }
  }
  if (cleanupFailed) process.exitCode = 1;
}
