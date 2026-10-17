import { describe, expect, it } from 'vitest';
import { personalBotView } from './navigation';

describe('personal assistant navigation', () => {
  it('uses the actual UI mount when distinguishing home from a conversation', () => {
    expect(personalBotView('/chat/nodes/demo', 'https://example.test/chat/nodes/demo/')).toBe(
      'home',
    );
    expect(
      personalBotView('/chat/nodes/demo', 'https://example.test/chat/nodes/demo/chat/12'),
    ).toBe('conversation');
    expect(personalBotView('/assistant', 'https://example.test/assistant/chat/12')).toBe(
      'conversation',
    );
  });

  it('restores a dashboard view without discarding the selected conversation route', () => {
    expect(personalBotView('/ui', 'https://example.test/ui/chat/12?bot_view=activity')).toBe(
      'activity',
    );
    expect(personalBotView('/ui', 'https://example.test/ui/?bot_view=conversation')).toBe(
      'conversation',
    );
    expect(personalBotView('/ui', 'https://example.test/ui/?bot_view=unknown')).toBe('home');
  });

  it('restores the widgets tab at direct and Hub-proxied mounts', () => {
    for (const prefix of ['/ui', '/hub/node/assistant']) {
      expect(personalBotView(prefix, `https://example.test${prefix}/?bot_view=widgets`)).toBe(
        'widgets',
      );
      expect(
        personalBotView(prefix, `https://example.test${prefix}/chat/12?bot_view=widgets`),
      ).toBe('widgets');
    }
  });
});
