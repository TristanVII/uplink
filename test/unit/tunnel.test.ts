import { describe, it, expect, vi, afterEach } from 'vitest';
import { getDevTunnelNotFoundMessage } from '../../src/server/tunnel.js';

describe('getDevTunnelNotFoundMessage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('suggests brew on macOS', () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' });
    expect(getDevTunnelNotFoundMessage()).toBe(
      'devtunnel CLI not found. Install: brew install --cask devtunnel',
    );
  });

  it('suggests curl on Linux', () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' });
    expect(getDevTunnelNotFoundMessage()).toBe(
      'devtunnel CLI not found. Install: curl -sL https://aka.ms/DevTunnelCliInstall | bash',
    );
  });

  it('suggests winget on Windows', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    expect(getDevTunnelNotFoundMessage()).toBe(
      'devtunnel CLI not found. Install: winget install Microsoft.devtunnel',
    );
  });

  it('returns fallback URL for unknown platforms', () => {
    vi.stubGlobal('process', { ...process, platform: 'freebsd' });
    expect(getDevTunnelNotFoundMessage()).toBe(
      'devtunnel CLI not found. See https://aka.ms/DevTunnelCliInstall',
    );
  });
});
