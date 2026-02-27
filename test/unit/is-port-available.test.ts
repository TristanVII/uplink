import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:net';
import { isPortAvailable } from '../../src/server/is-port-available.js';

describe('isPortAvailable', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it('returns true for a free port', async () => {
    expect(await isPortAvailable(0)).toBe(true);
  });

  it('returns false for an occupied port', async () => {
    // Bind a real port first
    server = createServer();
    const port = await new Promise<number>((resolve) => {
      server!.listen(0, () => {
        const addr = server!.address();
        resolve(typeof addr === 'object' ? addr!.port : 0);
      });
    });
    expect(await isPortAvailable(port)).toBe(false);
  });
});
