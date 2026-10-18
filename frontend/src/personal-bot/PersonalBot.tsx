import type { ComponentChildren, Ref } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { AppStore } from '../stores/app-store';
import { Composer } from '../components/Composer';
import { Transcript } from '../components/Transcript';
import { Header } from '../components/Header';
import { DelegationContext } from '../components/DelegationContext';
import { DiffSidebar, PlanSurface } from '../components/Panels';
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
import { Widgets } from './Widgets';
import { NavIcon, PersonalBotSidebar } from './PersonalBotSidebar';
import { personalBotView, type BotView as View } from './navigation';
import { initializePersonalBotTheme } from '../theme/personal-bot-theme';
import { nextHomeTagline } from './home-taglines';
import './personal-bot.css';
import '../theme/personal-bot-theme.css';

function Home({
  tagline,
  activity,
  start,
  navigate,
}: {
  tagline: readonly [string, string];
  activity: ActivityState;
  start: () => void;
  navigate: (view: View) => void;
}) {
  return (
    <section class="pb-page pb-home">
      <div class="pb-hero">
        <div class="pb-orb" aria-hidden="true">
          <span />
        </div>
        <p class="pb-eyebrow">Your personal assistant</p>
        <h1>
          {tagline[0]}
          <br class="pb-desktop-break" /> {tagline[1]}
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
  const [tagline] = useState(nextHomeTagline);
  const [error, setError] = useState('');
  const [opening, setOpening] = useState(false);
  const generation = useRef(0);
  const activity = useActivity(store, view === 'home' || view === 'activity');
  const ready = store.startupDone.value && !store.authRequired.value;
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
  const openConversation = async (id?: string) => {
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
        store.newChat();
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
      <PersonalBotSidebar
        store={store}
        view={view}
        ready={ready}
        opening={opening}
        navigate={navigate}
        openConversation={openConversation}
      />
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
              tagline={tagline}
              activity={activity}
              start={() => void openConversation()}
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
        {view === 'widgets' && (
          <div class="pb-page-scroll">
            <Widgets store={store} />
          </div>
        )}
        {view === 'conversation' && (
          <>
            <Header />
            <DelegationContext />
            <Transcript />
            <Composer autoFocus />
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
