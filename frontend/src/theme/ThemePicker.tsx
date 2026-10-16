import { useId } from 'preact/hooks';
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
      <select
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
      </select>
      {!compact && (
        <p>
          Applies to Personal Bot and your assistants in this browser. System follows your device’s
          appearance.
        </p>
      )}
    </div>
  );
}
