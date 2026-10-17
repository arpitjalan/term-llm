import type { ComponentChildren } from 'preact';
import { useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useMediaQuery } from '../../components/useMediaQuery';
import '../styles/dashboard-layout.css';

/** A persistent desktop rail with a native modal navigation drawer on phones. */
export function DashboardLayout({
  title,
  brand,
  navigation,
  children,
  className,
}: {
  title: string;
  brand: ComponentChildren;
  navigation: (close: () => void) => ComponentChildren;
  children: ComponentChildren;
  className: string;
}) {
  const wide = useMediaQuery('(min-width: 800px)');
  const [open, setOpen] = useState(false);
  const drawer = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const close = () => setOpen(false);

  useLayoutEffect(() => {
    if (wide) {
      setOpen(false);
      return;
    }
    if (!open || !drawer.current) return;
    const dialog = drawer.current;
    const opener = trigger.current;
    const overflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    // The browser owns focus trapping, background inertness, and Escape.
    dialog.showModal();
    return () => {
      dialog.close();
      document.documentElement.style.overflow = overflow;
      if (!window.matchMedia('(min-width: 800px)').matches) opener?.focus({ preventScroll: true });
    };
  }, [wide, open]);

  const sidebar = (
    <>
      <div class="dashboard-sidebar-heading">
        {brand}
        {!wide && (
          <button
            class="hub-btn ghost dashboard-menu-button"
            type="button"
            aria-label="Close navigation"
            onClick={close}
          >
            <span aria-hidden="true">×</span>
          </button>
        )}
      </div>
      <nav class="dashboard-sidebar-controls" aria-label={`${title} controls`}>
        {navigation(close)}
      </nav>
    </>
  );
  return (
    <div class={`dashboard-layout ${className}`}>
      <header class="dashboard-header hub-header">
        <button
          ref={trigger}
          class="hub-btn ghost dashboard-menu-button"
          type="button"
          aria-label="Open navigation"
          aria-haspopup="dialog"
          aria-expanded={open && !wide}
          aria-controls={id}
          onClick={() => setOpen(true)}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M4 6h16M4 12h16M4 18h16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
            />
          </svg>
        </button>
        <span>{title}</span>
      </header>
      <div class="dashboard-content">{children}</div>
      {wide ? (
        <aside id={id} class="dashboard-sidebar" aria-label={`${title} navigation`}>
          {sidebar}
        </aside>
      ) : (
        <dialog
          ref={drawer}
          id={id}
          class="dashboard-sidebar"
          aria-label={`${title} navigation`}
          onCancel={(event) => {
            event.preventDefault();
            close();
          }}
          onClick={(event) => {
            if (event.target !== event.currentTarget) return;
            const bounds = event.currentTarget.getBoundingClientRect();
            if (
              event.clientX < bounds.left ||
              event.clientX > bounds.right ||
              event.clientY < bounds.top ||
              event.clientY > bounds.bottom
            )
              close();
          }}
        >
          {sidebar}
        </dialog>
      )}
    </div>
  );
}
