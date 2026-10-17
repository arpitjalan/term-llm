export const homeTaglines = [
  ['What can I take', 'off your plate?'],
  ['What would you like', 'a hand with?'],
  ['What can we make', 'easier today?'],
  ['What’s on your mind?', 'Let’s work on it.'],
  ['What’s waiting', 'to get done?'],
  ['What’s next on', 'your to-do list?'],
  ['What can I help you', 'move forward?'],
  ['Have something', 'you’d like to hand off?'],
  ['What would free up', 'your headspace?'],
  ['What shall we', 'tackle together?'],
] as const;

export function nextHomeTagline(): (typeof homeTaglines)[number] {
  let index = 0;
  try {
    const key = 'term-llm:personal-bot:home-tagline';
    const stored = sessionStorage.getItem(key);
    const previous = Number(stored);
    if (
      stored !== null &&
      Number.isInteger(previous) &&
      previous >= 0 &&
      previous < homeTaglines.length
    )
      index = (previous + 1) % homeTaglines.length;
    sessionStorage.setItem(key, String(index));
  } catch {
    // Keep the homepage usable when browser storage is unavailable.
  }
  return homeTaglines[index];
}
