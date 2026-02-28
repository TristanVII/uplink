import { hashCwd, getTunnelInfo } from './tunnel.js';

export interface ResolvePortOptions {
  cwd: string;
  explicitPort?: number;
  tunnel: boolean;
  tunnelId?: string;
}

export interface ResolvePortResult {
  port: number;
  tunnelName?: string;
}

export function resolvePort(opts: ResolvePortOptions): ResolvePortResult {
  // --tunnel-id: raw primitive, no smart port
  if (opts.tunnelId) {
    return { port: opts.explicitPort ?? 0 };
  }

  // --tunnel without --tunnel-id: auto-persistent
  if (opts.tunnel) {
    const tunnelName = hashCwd(opts.cwd);

    if (opts.explicitPort != null) {
      return { port: opts.explicitPort, tunnelName };
    }

    // Try to reuse the port from the existing tunnel
    const info = getTunnelInfo(tunnelName);
    if (info.exists && info.port) {
      return { port: info.port, tunnelName };
    }

    return { port: 0, tunnelName };
  }

  // Local only
  return { port: opts.explicitPort ?? 0 };
}
