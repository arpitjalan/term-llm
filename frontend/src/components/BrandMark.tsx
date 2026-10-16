export function BrandMark({ class: className }: { class: string }) {
  return (
    <svg
      class={className}
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      stroke-width="5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m16 20 12 12-12 12m20 0h13" />
    </svg>
  );
}
