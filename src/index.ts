/**
 * cloudflare-sandbox-bridge — Cloudflare Sandbox Worker
 *
 * Public HTTP API keeps bearer authentication.
 * DeveloperEntrypoint is a named Service Binding RPC entrypoint used only by
 * GREEN LIGHT's production Worker; it never exposes SANDBOX_API_KEY to callers.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { bridge, type BridgeEnv } from '@cloudflare/sandbox/bridge';

export { Sandbox } from '@cloudflare/sandbox';
export { WarmPool } from '@cloudflare/sandbox/bridge';

const sandboxBridge = bridge({
  async fetch(_request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    return new Response('Not Found', { status: 404 });
  },
  async scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {}
});

async function authenticatedBridgeFetch(
  request: Request,
  env: BridgeEnv,
  ctx: ExecutionContext
): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === '/v1' || path.startsWith('/v1/')) {
    const token = env.SANDBOX_API_KEY;
    if (!token || !token.trim()) {
      return Response.json(
        { error: 'Sandbox API key is not configured', code: 'service_unavailable' },
        { status: 503 }
      );
    }
    const authorization = request.headers.get('Authorization') ?? '';
    if (!authorization.toLowerCase().startsWith('bearer ') || authorization.slice(7) !== token) {
      return Response.json({ error: 'Unauthorized', code: 'unauthorized' }, { status: 401 });
    }
  }

  const sandboxId = path.match(/^\/v1\/sandbox\/([^/]+)/)?.[1];
  if (sandboxId && !/^[a-z2-7]{1,63}$/.test(sandboxId)) {
    return Response.json({ error: 'Invalid sandbox ID format', code: 'invalid_request' }, { status: 400 });
  }

  return sandboxBridge.fetch!(
    request as Parameters<NonNullable<typeof sandboxBridge.fetch>>[0],
    env,
    ctx
  );
}

export class DeveloperEntrypoint extends WorkerEntrypoint<BridgeEnv> {
  async health() {
    return { ok: true, service: 'cloudflare-sandbox-bridge', mode: 'developer-rpc' };
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const token = this.env.SANDBOX_API_KEY;
    if (!token || !token.trim()) throw new Error('SANDBOX_API_KEY is not configured');
    const headers = new Headers(init.headers);
    headers.set('Authorization', 'Bearer ' + token);
    const request = new Request('https://sandbox-bridge.internal' + path, {
      ...init,
      headers
    });
    return authenticatedBridgeFetch(request, this.env, this.ctx);
  }

  async runJavaScriptSource(content: string, timeoutMs = 120000) {
    if (typeof content !== 'string' || content.length < 1) {
      throw new Error('QA source is empty');
    }
    if (content.length > 4_000_000) {
      throw new Error('QA source exceeds 4 MB RPC execution limit');
    }
    const safeTimeout = Math.max(1000, Math.min(Number(timeoutMs) || 120000, 300000));

    let sandboxId = '';
    try {
      const create = await this.request('/v1/sandbox', { method: 'POST' });
      if (!create.ok) throw new Error('Sandbox create failed: HTTP ' + create.status);
      const created = await create.json() as { id?: string };
      sandboxId = String(created.id || '');
      if (!/^[a-z2-7]{1,63}$/.test(sandboxId)) throw new Error('Sandbox returned invalid ID');

      const base = '/v1/sandbox/' + sandboxId;
      const put = await this.request(base + '/file/workspace/qa-runner.js', {
        method: 'PUT',
        body: content
      });
      if (!put.ok) throw new Error('QA source upload failed: HTTP ' + put.status);

      const exec = await this.request(base + '/exec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          argv: ['node', '/workspace/qa-runner.js'],
          timeout_ms: safeTimeout,
          cwd: '/workspace'
        })
      });
      if (!exec.ok) throw new Error('Sandbox QA exec failed: HTTP ' + exec.status);

      const stream = await exec.text();
      let stdout = '';
      let stderr = '';
      let exitCode: number | null = null;

      for (const frame of stream.split(/\r?\n\r?\n/)) {
        const event = frame.match(/^event: (.+)$/m)?.[1];
        const data = [...frame.matchAll(/^data: (.*)$/gm)].map(m => m[1]).join('\n');
        if (!data) continue;
        if (event === 'stdout') stdout += atob(data);
        if (event === 'stderr') stderr += atob(data);
        if (event === 'exit') {
          try {
            const parsed = JSON.parse(data) as { exit_code?: number };
            if (Number.isInteger(parsed.exit_code)) exitCode = Number(parsed.exit_code);
          } catch {}
        }
      }

      return {
        ok: exitCode === 0,
        test: 'node qa-runner.js',
        exit_code: exitCode,
        stdout: stdout.slice(0, 50000),
        stderr: stderr.slice(0, 50000),
        sandbox_created: true,
        sandbox_deleted: false
      };
    } finally {
      if (sandboxId) {
        try {
          await this.request('/v1/sandbox/' + sandboxId, { method: 'DELETE' });
        } catch (error) {
          console.error('DeveloperEntrypoint QA sandbox cleanup failed', sandboxId, String(error));
        }
      }
    }
  }

  async testJavaScriptSource(content: string) {
    if (typeof content !== 'string' || content.length < 1) {
      throw new Error('Candidate source is empty');
    }
    if (content.length > 4_000_000) {
      throw new Error('Candidate source exceeds 4 MB RPC test limit');
    }

    let sandboxId = '';
    try {
      const create = await this.request('/v1/sandbox', { method: 'POST' });
      if (!create.ok) throw new Error('Sandbox create failed: HTTP ' + create.status);
      const created = await create.json() as { id?: string };
      sandboxId = String(created.id || '');
      if (!/^[a-z2-7]{1,63}$/.test(sandboxId)) throw new Error('Sandbox returned invalid ID');

      const base = '/v1/sandbox/' + sandboxId;
      const put = await this.request(base + '/file/workspace/candidate.js', {
        method: 'PUT',
        body: content
      });
      if (!put.ok) throw new Error('Candidate upload failed: HTTP ' + put.status);

      const exec = await this.request(base + '/exec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          argv: ['node', '--check', '/workspace/candidate.js'],
          timeout_ms: 30000,
          cwd: '/workspace'
        })
      });
      if (!exec.ok) throw new Error('Sandbox exec failed: HTTP ' + exec.status);

      const stream = await exec.text();
      let stdout = '';
      let stderr = '';
      let exitCode: number | null = null;

      for (const frame of stream.split(/\r?\n\r?\n/)) {
        const event = frame.match(/^event: (.+)$/m)?.[1];
        const data = [...frame.matchAll(/^data: (.*)$/gm)].map(m => m[1]).join('\n');
        if (!data) continue;
        if (event === 'stdout') stdout += atob(data);
        if (event === 'stderr') stderr += atob(data);
        if (event === 'exit') {
          try {
            const parsed = JSON.parse(data) as { exit_code?: number };
            if (Number.isInteger(parsed.exit_code)) exitCode = Number(parsed.exit_code);
          } catch {}
        }
      }

      return {
        ok: exitCode === 0,
        test: 'node --check',
        exit_code: exitCode,
        stdout: stdout.slice(0, 4000),
        stderr: stderr.slice(0, 8000),
        sandbox_created: true,
        sandbox_deleted: false
      };
    } finally {
      if (sandboxId) {
        try {
          await this.request('/v1/sandbox/' + sandboxId, { method: 'DELETE' });
        } catch (error) {
          console.error('DeveloperEntrypoint sandbox cleanup failed', sandboxId, String(error));
        }
      }
    }
  }
}

export default {
  ...sandboxBridge,
  async fetch(request, env, ctx) {
    return authenticatedBridgeFetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    if (!env.SANDBOX_API_KEY?.trim()) {
      console.error('Sandbox pool priming skipped: SANDBOX_API_KEY is not configured');
      return;
    }
    await sandboxBridge.scheduled!(controller, env, ctx);
  }
} satisfies ExportedHandler<BridgeEnv>;
