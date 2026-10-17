import { useEffect, useState } from 'preact/hooks';
import type { AppStore } from '../stores/app-store';
import { BrandMark } from '../components/BrandMark';
import { Drawer } from '../components/Drawer';
import { Icon } from '../components/Icon';
import { useMediaQuery } from '../components/useMediaQuery';
import { compareSessionsByActivity } from '../stores/store-utils';
import type { BotView } from './navigation';

export function NavIcon({
  name,
}: {
  name: 'home' | 'activity' | 'conversations' | 'routines' | 'widgets';
}) {
  if (name === 'widgets') return <Icon name="widgets" />;
  const paths = {
    home: 'M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z',
    activity: 'M3 12h4l3-8 4 16 3-8h4',
    conversations: 'M21 11.5a8.5 8.5 0 0 1-8.5 8.5H3l2.5-5A8.5 8.5 0 1 1 21 11.5Z',
    routines: 'M12 8v4l3 2M21 12a9 9 0 1 1-2.6-6.4M21 3v5h-5',
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}

export function PersonalBotSidebar({
  store,
  view,
  ready,
  opening,
  navigate,
  openConversation,
}: {
  store: AppStore;
  view: BotView;
  ready: boolean;
  opening: boolean;
  navigate: (view: BotView) => void;
  openConversation: (id?: string) => Promise<void>;
}) {
  const mobile = useMediaQuery('(max-width: 767px)');
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [mobile, view]);
  const close = () => setOpen(false);
  const selectView = (next: BotView) => {
    close();
    navigate(next);
  };
  const selectConversation = (id?: string) => {
    close();
    void openConversation(id);
  };
  const sessions = store.sessions.value
    .filter((session) => !session.archived && !session.id.startsWith('draft_'))
    .sort(compareSessionsByActivity)
    .slice(0, 8);
  const content = (
    <>
      <div class="pb-sidebar-heading">
        <button
          class="pb-brand"
          onClick={() => selectView('home')}
          aria-label={`${store.config.title} home`}
        >
          <BrandMark class="pb-brand-mark" />
          <span class="pb-brand-name" title={store.config.title}>
            {store.config.title}
          </span>
        </button>
        {mobile && (
          <button class="pb-menu-button" onClick={close} aria-label="Close sidebar">
            <Icon name="close" />
          </button>
        )}
      </div>
      <button
        class="pb-button pb-new-chat"
        disabled={!ready || opening}
        onClick={() => selectConversation()}
      >
        <Icon name="add" />
        New conversation
      </button>
      <nav class="pb-nav" aria-label="Main navigation">
        {(['home', 'activity', 'conversations', 'routines', 'widgets'] as const).map((item) => (
          <button
            key={item}
            aria-current={view === item ? 'page' : undefined}
            onClick={() => selectView(item)}
          >
            <NavIcon name={item} />
            <span>{item[0].toUpperCase() + item.slice(1)}</span>
          </button>
        ))}
      </nav>
      <div class="pb-recents">
        <div class="pb-recents-heading">
          <p class="pb-eyebrow">Recent conversations</p>
        </div>
        {sessions.length ? (
          sessions.map((session) => (
            <button
              key={session.id}
              disabled={!ready || opening}
              aria-current={
                view === 'conversation' && store.activeSessionId.value === session.id
                  ? 'page'
                  : undefined
              }
              onClick={() => selectConversation(session.id)}
            >
              <span>{session.title || session.name || 'Conversation'}</span>
              {(session.activeRun || session.attentionUnseen) && (
                <span
                  class="pb-recent-indicator"
                  aria-label={session.activeRun ? 'In progress' : 'Unread'}
                />
              )}
            </button>
          ))
        ) : (
          <p class="pb-muted pb-recents-empty">
            A place for your ideas
            <br />
            and everything they become.
          </p>
        )}
      </div>
      <div class="pb-sidebar-footer">
        {store.config.hub?.url && (
          <a class="pb-settings" href={store.config.hub.url}>
            <Icon name="arrow-left" />
            Your agents
          </a>
        )}
        <span class="pb-connection">
          <span
            class={`pb-status-dot ${store.networkState.value === 'online' ? 'pb-status-running' : 'pb-status-input_required'}`}
            aria-hidden="true"
          />
          {store.networkState.value === 'online'
            ? 'Connected to your workspace'
            : 'Connecting to your workspace'}
        </span>
        <button
          class="pb-settings"
          onClick={() => {
            close();
            store.modal.value = 'settings';
          }}
        >
          <Icon name="settings" />
          Settings<span class="pb-powered">term-llm</span>
        </button>
      </div>
    </>
  );
  if (!mobile)
    return (
      <aside class="pb-sidebar" id="personalBotSidebar" aria-label="Agent navigation">
        {content}
      </aside>
    );
  return (
    <>
      <header class="pb-mobile-header">
        <button
          class="pb-menu-button"
          aria-label="Open sidebar"
          aria-controls="personalBotSidebar"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          <Icon name="menu" />
        </button>
        <div class="pb-brand">
          <BrandMark class="pb-brand-mark" />
          <span class="pb-brand-name" title={store.config.title}>
            {store.config.title}
          </span>
        </div>
      </header>
      <Drawer
        id="personalBotSidebar"
        title="Agent navigation"
        side="left"
        className="pb-sidebar pb-sidebar-drawer"
        open={open}
        onClose={close}
      >
        {content}
      </Drawer>
    </>
  );
}
