import { useState } from 'preact/hooks';
import { useStore } from '../app/context';
import type { Widget } from '../domain/types';
import { ToggleSwitch } from './ToggleSwitch';

/** On/off switches for this server's widgets; one turned off is stopped and left out of the launcher. */
export function WidgetSettings() {
  const store = useStore();
  const [pending, setPending] = useState('');
  const widgets = [...store.widgets.value].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }),
  );
  const toggle = async (widget: Widget, on: boolean) => {
    if (!widget.mount) return;
    setPending(widget.id);
    try {
      await store.widgetStore.setDisabled(widget.mount, !on);
    } catch (error) {
      store.toast(error, 'error');
    } finally {
      setPending('');
    }
  };
  return (
    <div class="settings-panel-body">
      {widgets.map((widget) => (
        <div class="settings-field" key={widget.id}>
          <label class="settings-toggle">
            <span>
              <span class="settings-label settings-label-inline">{widget.name}</span>{' '}
              <span class="settings-help">
                {widget.description || (widget.mount ? `/${widget.mount}` : 'Local widget')}
              </span>
            </span>
            <ToggleSwitch
              checked={widget.state !== 'disabled'}
              disabled={Boolean(pending) || !widget.mount}
              onChange={(event) => void toggle(widget, event.currentTarget.checked)}
            />
          </label>
        </div>
      ))}
    </div>
  );
}
