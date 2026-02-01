import { useToastStore } from '@/stores/toast';
import './ToastLayer.css';

export function ToastLayer() {
  const toasts = useToastStore((s) => s.toasts);

  if (toasts.length === 0) {
    return null;
  }

  return (
    <div className="toast-layer" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.variant}`}>
          <span className="toast__message">{toast.message}</span>
        </div>
      ))}
    </div>
  );
}
