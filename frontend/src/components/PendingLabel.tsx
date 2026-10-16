import './pending-label.css';

/** Both labels size the button, while only the current state is visible and announced. */
export function PendingLabel({
  pending,
  label,
  pendingLabel,
}: {
  pending: boolean;
  label: string;
  pendingLabel: string;
}) {
  return (
    <span class="pending-label">
      <span aria-hidden={pending}>{label}</span>
      <span aria-hidden={!pending}>{pendingLabel}</span>
    </span>
  );
}
