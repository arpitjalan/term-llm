import type { ComponentChildren, Ref } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { AppStore } from '../stores/app-store';
import { Composer } from '../components/Composer';
import { Transcript } from '../components/Transcript';
import { Header } from '../components/Header';
import { DelegationContext } from '../components/DelegationContext';
import { DiffSidebar, PlanSurface } from '../components/Panels';
import { Icon } from '../components/Icon';
import { activityKinds } from '../api/personal-bot-attention';
import {
  Activity,
  ActivityNotice,
  activityLabels,
  useActivity,
  type ActivityState,
} from './Activity';
import { Routines } from './Routines';
import { Conversations } from './Conversations';
import { compareSessionsByActivity } from '../stores/store-utils';
import { personalBotView, type BotView as View } from './navigation';
import { initializePersonalBotTheme } from '../theme/personal-bot-theme';
import './personal-bot.css';
import '../theme/personal-bot-theme.css';

function NavIcon({ name }: { name: 'home' | 'activity' | 'routines' }) {
  const paths = {
    home: 'M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z',
    activity: 'M3 12h4l3-8 4 16 3-8h4',
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

const starters = [
  {
    title: 'Make a plan',
    description: 'Turn a busy week into clear next steps.',
    prompt: 'Help me plan my week. Start by asking about my priorities and deadlines.',
  },
  {
    title: 'Do the research',
    description: 'Explore a question and bring back the useful bits.',
    prompt:
      'I would like help researching a topic. Ask what I am investigating and what decisions the research needs to support.',
  },
  {
    title: 'Move work forward',
    description: 'Work through a task, one step at a time.',
    prompt:
      'Help me move a task forward. Ask what I need done, what context you need, and what the finished result should look like.',
  },
];

function Home({
  activity,
  start,
  navigate,
}: {
  activity: ActivityState;
  start: (prompt?: string) => void;
  navigate: (view: View) => void;
}) {
  return (
    <section class="pb-page pb-home">
      <div class="pb-home-topline">
        <span class="pb-eyebrow">A little more headspace</span>
        <span class="pb-demo-label">Team workspace</span>
      </div>
      <div class="pb-hero">
        <div class="pb-orb" aria-hidden="true">
          <span />
        </div>
        <p class="pb-eyebrow">Your personal assistant</p>
        <h1>
          What can I take
          <br class="pb-desktop-break" /> off your plate?
        </h1>
        <p>
          Bring a question, a project, or a task.
          <br />
          We’ll take it from here, together.
        </p>
        <button class="pb-start" onClick={() => start()}>
          <span>Tell me what you have in mind…</span>
          <span class="pb-start-arrow" aria-hidden="true">
            ↗
          </span>
        </button>
      </div>
      <div class="pb-starters">
        {starters.map((starter, index) => (
          <button key={starter.title} class="pb-starter" onClick={() => start(starter.prompt)}>
            <span class={`pb-starter-icon pb-starter-icon-${index}`} aria-hidden="true">
              {['✦', '⌕', '↗'][index]}
            </span>
            <strong>{starter.title}</strong>
            <span>{starter.description}</span>
          </button>
        ))}
      </div>
      <section class="pb-home-status" aria-label="Work overview">
        <div class="pb-section-heading">
          <h2>While you’re here</h2>
          <button class="pb-text-button" onClick={() => navigate('activity')}>
            View activity <span aria-hidden="true">↗</span>
          </button>
        </div>
        <ActivityNotice activity={activity} />
        <div class="pb-status-grid">
          {activityKinds.map((kind) => (
            <button class="pb-status-card" key={kind} onClick={() => navigate('activity')}>
              <span>
                <span class={`pb-status-dot pb-status-${kind}`} aria-hidden="true" />
                {activityLabels[kind]}
              </span>
              <strong>
                {activity.feed
                  ? `${activity.feed[kind].items.length}${activity.feed[kind].has_more ? '+' : ''}`
                  : '—'}
              </strong>
            </button>
          ))}
        </div>
      </section>
      <button class="pb-routine-teaser" onClick={() => navigate('routines')}>
        <span class="pb-teaser-icon">
          <NavIcon name="routines" />
        </span>
        <span>
          <strong>Some things deserve a routine.</strong>
          <small>Set up work that happens on your schedule.</small>
        </span>
        <span aria-hidden="true">↗</span>
      </button>
    </section>
  );
}

export function PersonalBot({
  store,
  notice,
  shellRef,
}: {
  store: AppStore;
  notice: ComponentChildren;
  shellRef?: Ref<HTMLDivElement>;
}) {
  useLayoutEffect(initializePersonalBotTheme, []);
  const [view, setView] = useState<View>(() => personalBotView(store.config.prefix));
  const [error, setError] = useState('');
  const [opening, setOpening] = useState(false);
  const generation = useRef(0);
  const activity = useActivity(store, view === 'home' || view === 'activity');
  const ready = store.startupDone.value && !store.authRequired.value;
  const sessions = store.sessions.value
    .filter((session) => !session.archived && !session.id.startsWith('draft_'))
    .sort(compareSessionsByActivity)
    .slice(0, 8);
  const navigate = (next: View) => {
    generation.current++;
    setOpening(false);
    setError('');
    setView(next);
    const url = new URL(location.href);
    url.searchParams.set('bot_view', next);
    history.pushState(null, '', url);
  };
  useEffect(() => {
    const pop = () => {
      generation.current++;
      setOpening(false);
      setView(personalBotView(store.config.prefix));
      setError('');
    };
    addEventListener('popstate', pop);
    return () => {
      generation.current = -1;
      removeEventListener('popstate', pop);
    };
  }, [store.config.prefix]);
  const openConversation = async (id?: string, prompt?: string) => {
    if (!ready || opening) return;
    const current = ++generation.current;
    setOpening(true);
    setError('');
    try {
      if (id) {
        const session = await store.resolveAndSelectSession(id, false, {
          newChatOnMiss: false,
          propagateError: true,
          isCurrent: () => generation.current === current,
        });
        if (!session) throw new Error('This conversation is no longer available.');
      } else {
        await store.newChat();
        if (prompt) store.prompt.value = prompt;
      }
      if (generation.current !== current) return;
      setView('conversation');
      const url = new URL(location.href);
      url.searchParams.set('bot_view', 'conversation');
      history.replaceState(null, '', url);
    } catch (reason) {
      if (generation.current === current)
        setError(reason instanceof Error ? reason.message : 'Could not open conversation.');
    } finally {
      if (generation.current === current) setOpening(false);
    }
  };
  const fullscreen =
    store.shellStore.visible.value && store.shellStore.layout.value === 'fullscreen';
  return (
    <div
      class={`app personal-bot ${view === 'conversation' ? 'pb-in-conversation' : ''} ${view === 'conversation' && store.diff.value.open ? 'diff-open' : ''} ${view === 'conversation' && store.diff.value.maximized ? 'diff-maximized' : ''} ${view === 'conversation' && store.planVisible.value ? 'plan-open' : ''} ${store.shellStore.visible.value ? `shell-docked-${store.shellStore.layout.value}` : ''}`}
      id="appShell"
      ref={shellRef}
      style={{
        '--diff-sidebar-user-width': `${store.diff.value.width}px`,
        '--shell-dock-bottom-size': `${store.shellStore.dockBottomSize.value}px`,
        '--shell-dock-right-size': `${store.shellStore.dockRightSize.value}px`,
      }}
      inert={fullscreen || undefined}
      aria-hidden={fullscreen || undefined}
    >
      <aside class="pb-sidebar" aria-label="Assistant navigation">
        <button class="pb-brand" onClick={() => navigate('home')} aria-label="Personal Bot home">
          <span class="pb-brand-mark" aria-hidden="true">
            ✦
          </span>
          <span>
            Personal Bot<span class="pb-brand-caption">A little help, always here.</span>
          </span>
        </button>
        <button
          class="pb-button pb-new-chat"
          disabled={!ready || opening}
          onClick={() => void openConversation()}
        >
          <Icon name="add" />
          New conversation
        </button>
        <nav class="pb-nav" aria-label="Main navigation">
          {(['home', 'activity', 'routines'] as const).map((item) => (
            <button
              key={item}
              aria-current={view === item ? 'page' : undefined}
              onClick={() => navigate(item)}
            >
              <NavIcon name={item} />
              <span>{item[0].toUpperCase() + item.slice(1)}</span>
            </button>
          ))}
        </nav>
        <div class="pb-mobile-tools">
          <select
            aria-label="Recent conversations"
            value={view === 'conversation' ? store.activeSessionId.value : ''}
            disabled={!ready || opening}
            onChange={(event) => void openConversation(event.currentTarget.value)}
          >
            <option value="" disabled>
              Recent conversations
            </option>
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.title || session.name || 'Conversation'}
              </option>
            ))}
          </select>
          <button class="pb-text-button" onClick={() => navigate('conversations')}>
            All conversations
          </button>
          {store.config.hub?.url && (
            <a class="pb-settings" href={store.config.hub.url} aria-label="All assistants">
              <Icon name="arrow-left" />
            </a>
          )}
          <button
            class="pb-settings"
            onClick={() => (store.modal.value = 'settings')}
            aria-label="Settings"
          >
            <Icon name="settings" />
          </button>
        </div>
        <div class="pb-recents">
          <div class="pb-recents-heading">
            <p class="pb-eyebrow">Recent conversations</p>
            <button class="pb-text-button" onClick={() => navigate('conversations')}>
              All conversations <span aria-hidden="true">↗</span>
            </button>
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
                onClick={() => void openConversation(session.id)}
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
              All assistants
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
          <button class="pb-settings" onClick={() => (store.modal.value = 'settings')}>
            <Icon name="settings" />
            Settings<span class="pb-powered">term-llm</span>
          </button>
        </div>
      </aside>
      <main class={`main pb-main ${view === 'conversation' ? 'pb-conversation' : ''}`} id="appMain">
        {notice}
        {error && (
          <div class="pb-error" role="alert">
            {error}
            <button class="pb-text-button" onClick={() => setError('')}>
              Dismiss
            </button>
          </div>
        )}
        {opening && (
          <div class="pb-opening" role="status">
            Opening conversation…
          </div>
        )}
        {view === 'home' && (
          <div class="pb-page-scroll">
            <Home
              activity={activity}
              start={(prompt) => void openConversation(undefined, prompt)}
              navigate={navigate}
            />
          </div>
        )}
        {view === 'activity' && (
          <div class="pb-page-scroll">
            <Activity activity={activity} open={(id) => void openConversation(id)} />
          </div>
        )}
        {view === 'routines' && (
          <div class="pb-page-scroll">
            <Routines store={store} onOpenSession={(id) => void openConversation(id)} />
          </div>
        )}
        {view === 'conversations' && (
          <div class="pb-page-scroll">
            <Conversations store={store} open={(id) => void openConversation(id)} />
          </div>
        )}
        {view === 'conversation' && (
          <>
            <Header />
            <DelegationContext />
            <Transcript />
            <Composer />
          </>
        )}
      </main>
      {view === 'conversation' && (
        <>
          <DiffSidebar />
          <PlanSurface />
        </>
      )}
    </div>
  );
}
