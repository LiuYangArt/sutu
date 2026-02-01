import { create } from 'zustand';

export type ToastVariant = 'info' | 'error' | 'success';

export interface Toast {
  id: string;
  message: string;
  variant: ToastVariant;
  durationMs: number;
}

interface ToastState {
  toasts: Toast[];
  pushToast: (message: string, options?: { variant?: ToastVariant; durationMs?: number }) => string;
  removeToast: (id: string) => void;
}

const DEFAULT_DURATION_MS = 2600;

const createToastId = () =>
  `toast_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  pushToast: (message, options) => {
    const toast: Toast = {
      id: createToastId(),
      message,
      variant: options?.variant ?? 'info',
      durationMs: options?.durationMs ?? DEFAULT_DURATION_MS,
    };

    set((state) => ({ toasts: [...state.toasts, toast] }));

    window.setTimeout(() => {
      get().removeToast(toast.id);
    }, toast.durationMs);

    return toast.id;
  },
  removeToast: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((toast) => toast.id !== id),
    })),
}));
