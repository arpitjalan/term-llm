import { useId } from 'preact/hooks';
import { SelectControl } from '../components/SelectControl';
import {
  personalBotTheme,
  personalBotThemeOptions,
  setPersonalBotTheme,
} from './personal-bot-theme';
import './theme-picker.css';

export function ThemePicker({ compact = false }: { compact?: boolean }) {
  const id = useId();
  return (
    <div class={`pb-theme-picker${compact ? ' pb-theme-picker--compact' : ' settings-field'}`}>
      <label for={id}>Theme</label>
      <SelectControl
        id={id}
        title="Theme"
        value={personalBotTheme.value}
        onChange={(event) => setPersonalBotTheme(event.currentTarget.value)}
      >
        {personalBotThemeOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </SelectControl>
      {!compact && (
        <p>
          Applies only to this agent in this browser. System switches between Sage Light and Sage
          Dark to match your device’s appearance.
        </p>
      )}
    </div>
  );
}
