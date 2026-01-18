import { useEffect, useState, useRef, useCallback, lazy, Suspense } from 'react';
import { Canvas } from './components/Canvas';
import { Toolbar } from './components/Toolbar';
import { TabletPanel } from './components/TabletPanel';
import { useDocumentStore } from './stores/document';
import { useTabletStore } from './stores/tablet';
import { useToolStore } from './stores/tool';
import { PanelLayer } from './components/UI/PanelLayer';
import { usePanelStore } from './stores/panel';

// Lazy load DebugPanel (only used in dev mode)
const DebugPanel = lazy(() => import('./components/DebugPanel'));

// Check if running in Tauri environment
const isTauri = () => {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
};

// Wait for Tauri IPC to be ready
const waitForTauri = async (maxRetries = 50, interval = 100): Promise<boolean> => {
  for (let i = 0; i < maxRetries; i++) {
    if (isTauri()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return false;
};

function App() {
  const [isReady, setIsReady] = useState(false);
  const [showDebugPanel, setShowDebugPanel] = useState(false);
  const initDocument = useDocumentStore((s) => s.initDocument);
  const tabletInitializedRef = useRef(false);

  // Get tablet store actions (stable references)
  const initTablet = useTabletStore((s) => s.init);
  const startTablet = useTabletStore((s) => s.start);
  const cleanupTablet = useTabletStore((s) => s.cleanup);

  // Toggle debug panel with Shift+Ctrl+D
  const handleDebugShortcut = useCallback((e: KeyboardEvent) => {
    if (e.shiftKey && e.ctrlKey && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      setShowDebugPanel((prev) => !prev);
    }
  }, []);

  // Drawing shortcuts: D (reset colors), X (swap colors), Alt+Backspace (fill)
  const handleDrawingShortcuts = useCallback((e: KeyboardEvent) => {
    // Skip if focus is on input elements
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
      return;
    }

    const key = e.key.toLowerCase();

    // D: Reset colors to default (black foreground, white background)
    if (key === 'd' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      useToolStore.getState().resetColors();
      return;
    }

    // X: Swap foreground and background colors
    if (key === 'x' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      useToolStore.getState().swapColors();
      return;
    }

    // Alt+Backspace: Fill active layer with foreground color
    if (e.key === 'Backspace' && e.altKey && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      const brushColor = useToolStore.getState().brushColor;
      window.__canvasFillLayer?.(brushColor);
      return;
    }
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', handleDebugShortcut);
    window.addEventListener('keydown', handleDrawingShortcuts);
    return () => {
      window.removeEventListener('keydown', handleDebugShortcut);
      window.removeEventListener('keydown', handleDrawingShortcuts);
    };
  }, [handleDebugShortcut, handleDrawingShortcuts]);

  // Get canvas ref for debug panel
  const getCanvasElement = useCallback((): HTMLCanvasElement | null => {
    return document.querySelector('canvas[data-testid="main-canvas"]');
  }, []);

  // Initialize tablet at App level (runs once)
  useEffect(() => {
    const setupTablet = async () => {
      // Use ref to prevent double initialization in StrictMode
      if (tabletInitializedRef.current) return;
      tabletInitializedRef.current = true;

      // Wait for Tauri to be ready
      const tauriReady = await waitForTauri();
      if (!tauriReady) {
        console.warn('[App] Tauri not available, tablet features disabled');
        return;
      }

      await initTablet({ backend: 'auto' });
      await startTablet();
    };

    setupTablet();

    // Cleanup only on actual unmount (App never unmounts in normal use)
    return () => {
      if (tabletInitializedRef.current) {
        cleanupTablet();
        tabletInitializedRef.current = false;
      }
    };
  }, [initTablet, startTablet, cleanupTablet]); // Run once on mount (deps are stable)

  useEffect(() => {
    // 初始化默认文档
    initDocument({
      width: 1920,
      height: 1080,
      dpi: 72,
    });
    setIsReady(true);
  }, [initDocument]);

  // Register default panels
  const registerPanel = usePanelStore((s) => s.registerPanel);
  const openPanel = usePanelStore((s) => s.openPanel);
  const closePanel = usePanelStore((s) => s.closePanel);

  useEffect(() => {
    // 1. Tools Panel (Top Left)
    registerPanel({
      id: 'tools-panel',
      title: 'Tools',
      defaultGeometry: { x: 20, y: 100, width: 100, height: 180 },
      defaultAlignment: { horizontal: 'left', vertical: 'top', offsetX: 20, offsetY: 100 },
      resizable: false,
      closable: false,
      minimizable: false,
      minWidth: 100,
      minHeight: 180,
    });

    // 2. Color Panel (Top Right, mimicking existing right panel top)
    registerPanel({
      id: 'color-panel',
      title: 'Color',
      defaultGeometry: { x: window.innerWidth - 300, y: 80, width: 280, height: 320 },
      defaultAlignment: { horizontal: 'right', vertical: 'top', offsetX: 20, offsetY: 80 },
      minWidth: 200,
      minHeight: 200,
    });

    // 3. Brush Panel (Below Color Panel)
    registerPanel({
      id: 'brush-panel',
      title: 'Brush',
      defaultGeometry: { x: window.innerWidth - 300, y: 420, width: 280, height: 440 },
      defaultAlignment: { horizontal: 'right', vertical: 'top', offsetX: 20, offsetY: 420 },
      minWidth: 240,
      minHeight: 350,
    });

    // 4. Layer Panel (Bottom Right)
    registerPanel({
      id: 'layer-panel',
      title: 'Layers',
      defaultGeometry: { x: window.innerWidth - 300, y: 420, width: 280, height: 400 },
      defaultAlignment: { horizontal: 'right', vertical: 'bottom', offsetX: 20, offsetY: 260 },
      minWidth: 240,
      maxWidth: 400,
      minHeight: 200,
    });

    // Auto open defaults
    openPanel('tools-panel');
    openPanel('color-panel');
    openPanel('brush-panel');
    openPanel('layer-panel');

    // Ensure debug panel is closed (if persisted)
    closePanel('debug-panel');
  }, [registerPanel, openPanel, closePanel]);

  if (!isReady) {
    return (
      <div className="loading">
        <span>Loading PaintBoard...</span>
      </div>
    );
  }

  return (
    <div className="app">
      <Toolbar />
      <main className="workspace">
        <Canvas />
      </main>
      <PanelLayer />
      <TabletPanel />
      {/* Debug Panel - dev mode only */}
      {showDebugPanel && (
        <Suspense fallback={null}>
          <DebugPanel canvas={getCanvasElement()} onClose={() => setShowDebugPanel(false)} />
        </Suspense>
      )}
    </div>
  );
}

export default App;
