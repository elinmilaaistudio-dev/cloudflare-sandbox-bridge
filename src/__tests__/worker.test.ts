import { createExecutionContext, waitOnExecutionContext, env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import worker from '../index';

async function request(path: string, key: string, authorization?: string) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://bridge.test${path}`, {
    headers: authorization ? { Authorization: authorization } : {}
  }), { ...env, SANDBOX_API_KEY: key }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe('Production worker entry point', () => {
  it('does not prime the pool without a configured key', async () => {
    const getByName = vi.fn();
    const ctx = createExecutionContext();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await worker.scheduled({} as ScheduledController, { SANDBOX_API_KEY: '', WarmPool: { getByName } }, ctx);
      await waitOnExecutionContext(ctx);
      expect(getByName).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(expect.stringContaining('SANDBOX_API_KEY'));
    } finally { error.mockRestore(); }
  });
  it('keeps health public without enabling API access', async () => {
    const res = await request('/health', '');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
  it.each(['/v1', '/v1/sandbox', '/v1/sandbox/test/running', '/v1/pool/stats', '/v1/openapi.json', '/v1/openapi.html', '/v1/openapi'])('fails closed without a key: %s', async (path) => {
    expect((await request(path, '')).status).toBe(503);
    expect((await request(path, '   ')).status).toBe(503);
  });
  it.each(['/v1/sandbox', '/v1/sandbox/test/running', '/v1/pool/stats', '/v1/openapi.json', '/v1/openapi.html'])('rejects missing/wrong credentials: %s', async (path) => {
    expect((await request(path, 'secret')).status).toBe(401);
    expect((await request(path, 'secret', 'Bearer wrong')).status).toBe(401);
    expect((await request(`${path}?token=secret`, 'secret')).status).toBe(401);
  });
  it('serves the real published schema with valid credentials', async () => {
    const res = await request('/v1/openapi.json', 'secret', 'Bearer secret');
    expect(res.status).toBe(200);
    const schema = await res.json() as { paths: Record<string, unknown> };
    expect(schema.paths['/v1/sandbox']).toBeDefined();
  });
  it.each(['A', 'a'.repeat(64), 'abc0189'])('rejects unsupported sandbox IDs before allocation: %s', async (id) => {
    expect((await request(`/v1/sandbox/${id}/running`, 'secret', 'Bearer secret')).status).toBe(400);
  });
  it('returns 404 for unknown and obsolete routes', async () => {
    expect((await request('/unknown', 'secret')).status).toBe(404);
    expect((await request('/sandbox/test/running', 'secret')).status).toBe(404);
  });
});
