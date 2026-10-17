import { sessionIDFromLocation } from '../platform/routing';

export type BotView =
  'home' | 'activity' | 'routines' | 'widgets' | 'conversation' | 'conversations';

export function personalBotView(prefix: string, href = location.href): BotView {
  const url = new URL(href);
  const view = url.searchParams.get('bot_view');
  if (
    view === 'home' ||
    view === 'activity' ||
    view === 'routines' ||
    view === 'widgets' ||
    view === 'conversations'
  )
    return view;
  return sessionIDFromLocation(prefix, url.pathname) || view === 'conversation'
    ? 'conversation'
    : 'home';
}
