import { useStore } from '../app/context';
import { Overlay } from './Overlay';
import { WidgetLauncher } from './WidgetLauncher';

export function Widgets() {
  const store = useStore();
  return (
    <Overlay title="Widgets" className="widgets-modal">
      <WidgetLauncher store={store} />
    </Overlay>
  );
}
