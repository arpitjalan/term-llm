import { computed, signal } from '@preact/signals';
import type { Widget } from '../domain/types';
import { array } from './store-utils';
import type { AppStoreServices } from './app-store-services';

/** Owns optional widget discovery state. */
export class WidgetStore {
  readonly widgets = signal<Widget[]>([]);
  /** The widgets the launcher offers: all but those turned off in Settings. */
  readonly enabled = computed(() =>
    this.widgets.value.filter((widget) => widget.state !== 'disabled'),
  );

  constructor(private readonly services: AppStoreServices) {}

  apply(value: unknown): void {
    const source =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>).widgets
        : value;
    this.widgets.value = array(source)
      .map((entry) => {
        const mount = String(entry.mount || entry.id || '').replace(/^\/+|\/+$/g, '');
        return {
          id: String(entry.id || mount),
          name: String(entry.title || entry.name || mount || 'Widget'),
          mount,
          description: String(entry.description || ''),
          state: String(entry.state || 'stopped'),
          error: String(entry.error || ''),
          url: mount
            ? `${this.services.config.prefix}/widgets/${encodeURIComponent(mount)}/`
            : String(entry.url || ''),
        };
      })
      .filter((entry) => entry.url);
  }

  async load(): Promise<void> {
    try {
      this.apply(await this.services.endpoints.widgetStatus());
    } catch {
      /* Widgets are optional. */
    }
  }

  async stop(mount: string): Promise<void> {
    await this.services.endpoints.stopWidget(mount);
    this.markState(mount, 'stopped');
  }

  /** Turns a widget off (the server stops it and won't start it) or back on. */
  async setDisabled(mount: string, disabled: boolean): Promise<void> {
    await this.services.endpoints.setWidgetDisabled(mount, disabled);
    this.markState(mount, disabled ? 'disabled' : 'stopped');
  }

  private markState(mount: string, state: string): void {
    this.widgets.value = this.widgets.value.map((widget) =>
      widget.mount === mount ? { ...widget, state, error: '' } : widget,
    );
  }
}
