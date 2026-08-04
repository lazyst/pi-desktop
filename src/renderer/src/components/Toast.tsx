import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from 'react';

interface ToastItem {
  id: number;
  text: string;
}

interface ToastContextValue {
  toast: (text: string) => void;
}

const ToastContext = createContext<ToastContextValue>({ toast: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const toast = useCallback((text: string) => {
    const id = nextId.current++;
    setItems((prev) => [...prev, { id, text }]);
    setTimeout(() => {
      setItems((prev) => prev.filter((t) => t.id !== id));
    }, 1500);
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="toast-container">
        {items.map((t) => (
          <div key={t.id} className="toast-item">
            <span className="toast-icon">✓</span>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}