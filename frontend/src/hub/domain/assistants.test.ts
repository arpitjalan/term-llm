import { describe, expect, it } from 'vitest';
import { assistantProxyURL, deviceVerificationURL } from './assistants';

describe('assistant links', () => {
  it('keeps assistant links on their authenticated mounted node proxy', () => {
    expect(assistantProxyURL('/team/node/atlas/?session=one', '/team', 'atlas')).toBe(
      '/team/node/atlas/?session=one',
    );
    expect(assistantProxyURL('/node/atlas/', '', 'atlas')).toBe('/node/atlas/');
    for (const raw of [
      'https://elsewhere.example/team/node/atlas/',
      '//elsewhere.example/team/node/atlas/',
      '/team/node/other/',
      '/team/node/atlas/../../auth/login',
      '/team/node/atlas/%2e%2e/other/',
      '/team/node/atlas/\\evil',
    ])
      expect(assistantProxyURL(raw, '/team', 'atlas')).toBe('');
  });

  it('only offers a secure provider-owned device sign-in destination', () => {
    expect(deviceVerificationURL('https://auth.openai.com/codex/device')).toBe(
      'https://auth.openai.com/codex/device',
    );
    for (const raw of [
      undefined,
      '',
      'javascript:alert(1)',
      'http://auth.openai.com/',
      'https://auth.openai.com.evil.test/',
      'https://evil.test/',
    ]) {
      expect(deviceVerificationURL(raw)).toBe('');
    }
  });
});
