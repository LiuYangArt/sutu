import { useEffect, useState, useRef } from 'react';
import { Canvas } from './components/Canvas';
import { Toolbar } from './components/Toolbar';
import { LayerPanel } from './components/LayerPanel';
import { TabletPanel } from './components/TabletPanel';
import { useDocumentStore } from './stores/document';
import { useTabletStore } from './stores/tablet';

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
  const initDocument = useDocumentStore((s) => s.initDocument);
  const tabletInitializedRef = useRef(false);

  // Get tablet store actions (stable references)
  const initTablet = useTabletStore((s) => s.init);
  const startTablet = useTabletStore((s) => s.start);
  const cleanupTablet = useTabletStore((s) => s.cleanup);

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

      console.log('[App] Initializing tablet backend...');
      await initTablet({ backend: 'auto' });
      await startTablet();
      console.log('[App] Tablet backend ready');
    };

    setupTablet();

    // Cleanup only on actual unmount (App never unmounts in normal use)
    return () => {
      if (tabletInitializedRef.current) {
        console.log('[App] Cleaning up tablet backend...');
        cleanupTablet();
        tabletInitializedRef.current = false;
      }
    };
  }, []); // Empty deps - run once on mount

  useEffect(() => {
    // 初始化默认文档
    initDocument({
      width: 1920,
      height: 1080,
      dpi: 72,
    });
    setIsReady(true);
  }, [initDocument]);

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
        <LayerPanel />
      </main>
      <TabletPanel />
    </div>
  );
}

export default App;
