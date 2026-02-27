import { createServer } from 'node:net';

/** Probe whether a port is available without creating the full server stack */
export async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, () => {
      probe.close(() => resolve(true));
    });
  });
}
