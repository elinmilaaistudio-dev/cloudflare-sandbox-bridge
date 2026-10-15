import { bridge } from '@cloudflare/sandbox/bridge';
const worker = bridge({});
export const app = {
  request(url: string, init?: RequestInit, env?: Record<string, unknown>) {
    return worker.fetch!(new Request(url, init), env ?? {}, {} as ExecutionContext);
  }
};
