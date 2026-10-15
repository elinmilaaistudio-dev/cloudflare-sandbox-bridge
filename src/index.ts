/**
 * cloudflare-sandbox-bridge — Cloudflare Sandbox Worker
 *
 * This is a thin wrapper around the bridge from @cloudflare/sandbox/bridge.
 * All API routes, pool management, and authentication are handled by the bridge.
 *
 * To upgrade: bump the @cloudflare/sandbox version in package.json.
 */

import { bridge, type BridgeEnv } from '@cloudflare/sandbox/bridge';

// Re-export Sandbox so Wrangler can wire up the Durable Object binding.
export { Sandbox } from '@cloudflare/sandbox';

// Re-export WarmPool so Wrangler can wire up its Durable Object binding.
export { WarmPool } from '@cloudflare/sandbox/bridge';

const sandboxBridge = bridge({
  async fetch(_request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    // Application-specific fetch handling (runs after bridge routes).
    // Return custom responses here, or remove this handler to let the
    // bridge return 404 for non-API routes.
    return new Response('Not Found', { status: 404 });
  },

  async scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {
    // Application-specific scheduled logic (runs after pool priming).
  }
});

// Reject API access before the SDK can fall back to unauthenticated development mode.
export default {
  ...sandboxBridge,
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === '/v1' || path.startsWith('/v1/')) {
      const token = env.SANDBOX_API_KEY;
      if (!token || !token.trim()) {
        return Response.json({ error: 'Sandbox API key is not configured', code: 'service_unavailable' }, { status: 503 });
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
    return sandboxBridge.fetch!(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    if (!env.SANDBOX_API_KEY?.trim()) {
      console.error('Sandbox pool priming skipped: SANDBOX_API_KEY is not configured');
      return;
    }
    await sandboxBridge.scheduled!(controller, env, ctx);
  }
} satisfies ExportedHandler<BridgeEnv>;
