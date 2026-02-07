import { useEffect, useState, useRef, useCallback, lazy, Suspense } from 'react';
import { Canvas } from './components/Canvas';
import { Toolbar } from './components/Toolbar';
import { SettingsPanel } from './components/SettingsPanel';
import { PatternLibraryPanel } from './components/PatternLibrary';
import { CanvasSizePanel } from './components/CanvasSizePanel';
import { NewFilePanel, type BackgroundPreset } from './components/NewFilePanel';
import { ConfirmUnsavedChangesDialog } from './components/ConfirmUnsavedChangesDialog';
import { useDocumentStore, type ResizeCanvasOptions } from './stores/document';
import { useSelectionStore } from './stores/selection';
import { useTabletStore } from './stores/tablet';
import { useToolStore } from './stores/tool';
import { useSettingsStore, initializeSettings } from './stores/settings';
import { useFileStore } from './stores/file';
import { LeftToolbar, RightPanel } from './components/SidePanel';
import { PanelLayer } from './components/UI/PanelLayer';
import { ToastLayer } from './components/UI/ToastLayer';
import { usePanelStore } from './stores/panel';
import { useHistoryStore } from './stores/history';
import { useViewportStore } from './stores/viewport';

// Lazy load DebugPanel (only used in dev mode)
const DebugPanel = lazy(() => import('./components/DebugPanel'));

// Extend Window interface for global functions
declare global {
  interface Window {
    __openPatternLibrary?: () => void;
    __openCanvasSizePanel?: () => void;
    __requestNewFile?: () => void;
    __canvasFillLayer?: (color: string) => void;
    __canvasClearSelection?: () => void;
    __canvasRemoveLayer?: (id: string) => void;
    __canvasResize?: (options: ResizeCanvasOptions) => void;
  }
}

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

function resolveBackgroundFillColor(
  preset: BackgroundPreset,
  currentToolBackground: string
): string | undefined {
  switch (preset) {
    case 'white':
      return '#ffffff';
    case 'black':
      return '#000000';
    case 'current-bg':
      return currentToolBackground;
    case 'transparent':
      return undefined;
  }
}

function App() {
  const [isReady, setIsReady] = useState(false);
  const [showDebugPanel, setShowDebugPanel] = useState(false);
  const [showPatternLibrary, setShowPatternLibrary] = useState(false);
  const [showCanvasSizePanel, setShowCanvasSizePanel] = useState(false);
  const [showNewFilePanel, setShowNewFilePanel] = useState(false);
  const [showUnsavedChangesDialog, setShowUnsavedChangesDialog] = useState(false);
  const settingsLoaded = useSettingsStore((s) => s.isLoaded);
  const autosaveIntervalMinutes = useSettingsStore((s) => s.general.autosaveIntervalMinutes);
  const setNewFileLastUsed = useSettingsStore((s) => s.setNewFileLastUsed);
  const initDocument = useDocumentStore((s) => s.initDocument);
  const docDefaults = useDocumentStore((s) => ({
    width: s.width,
    height: s.height,
  }));
  const tabletInitializedRef = useRef(false);
  const startupRestoreTriggeredRef = useRef(false);

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

  // Drawing shortcuts: D (reset colors), X (swap colors), I (eyedropper), Alt+Backspace (fill), F5 (brush panel), Ctrl+Alt+Shift+U (settings)
  // File shortcuts: Ctrl+S (save), Ctrl+Shift+S (save as), Ctrl+O (open)
  const togglePanel = usePanelStore((s) => s.togglePanel);
  const isSettingsOpen = useSettingsStore((s) => s.isOpen);
  const openSettings = useSettingsStore((s) => s.openSettings);
  const closeSettings = useSettingsStore((s) => s.closeSettings);
  const fileSave = useFileStore((s) => s.save);
  const fileOpen = useFileStore((s) => s.open);
  const runAutoSaveTick = useFileStore((s) => s.runAutoSaveTick);
  const restoreOnStartup = useFileStore((s) => s.restoreOnStartup);
  const handleDrawingShortcuts = useCallback(
    (e: KeyboardEvent) => {
      // Ctrl+N: New
      if (e.ctrlKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        window.__requestNewFile?.();
        return;
      }

      // Ctrl+S: Save / Ctrl+Shift+S: Save As
      if (e.ctrlKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        fileSave(e.shiftKey); // shiftKey = saveAs
        return;
      }

      // Ctrl+O: Open
      if (e.ctrlKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        fileOpen();
        return;
      }

      // Ctrl+Alt+Shift+U: Toggle settings panel
      if (e.ctrlKey && e.altKey && e.shiftKey && e.key.toLowerCase() === 'u') {
        e.preventDefault();
        if (isSettingsOpen) {
          closeSettings();
        } else {
          openSettings();
        }
        return;
      }

      // F5: Toggle brush panel (allow even in input fields)
      if (e.key === 'F5') {
        e.preventDefault();
        togglePanel('brush-panel');
        return;
      }

      // F6: Toggle pattern library panel
      if (e.key === 'F6') {
        e.preventDefault();
        setShowPatternLibrary((prev) => !prev);
        return;
      }

      // Skip other shortcuts if focus is on input elements
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

      // I: Switch to eyedropper tool
      if (key === 'i' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        useToolStore.getState().setTool('eyedropper');
        return;
      }

      // Alt+Backspace: Fill active layer with foreground color
      if (e.key === 'Backspace' && e.altKey && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        const brushColor = useToolStore.getState().brushColor;
        window.__canvasFillLayer?.(brushColor);
        return;
      }

      // Delete: clear selection or remove active layer
      if (e.key === 'Delete' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();

        const { hasSelection } = useSelectionStore.getState();
        if (hasSelection) {
          window.__canvasClearSelection?.();
          return;
        }

        const { activeLayerId, layers } = useDocumentStore.getState();
        if (!activeLayerId) return;

        const activeLayer = layers.find((l) => l.id === activeLayerId);

        // Prevent deleting background layer
        if (activeLayer && !activeLayer.isBackground) {
          window.__canvasRemoveLayer?.(activeLayerId);
        }
        return;
      }
    },
    [
      togglePanel,
      isSettingsOpen,
      openSettings,
      closeSettings,
      fileSave,
      fileOpen,
      setShowPatternLibrary,
    ]
  );

  // Expose global function to open Pattern Library
  useEffect(() => {
    window.__openPatternLibrary = () => setShowPatternLibrary(true);
    return () => {
      delete window.__openPatternLibrary;
    };
  }, [setShowPatternLibrary]);

  useEffect(() => {
    window.__openCanvasSizePanel = () => setShowCanvasSizePanel(true);
    return () => {
      delete window.__openCanvasSizePanel;
    };
  }, [setShowCanvasSizePanel]);

  useEffect(() => {
    window.__requestNewFile = () => {
      const { isDirty } = useDocumentStore.getState();
      if (isDirty) {
        setShowUnsavedChangesDialog(true);
        setShowNewFilePanel(false);
      } else {
        setShowNewFilePanel(true);
        setShowUnsavedChangesDialog(false);
      }
    };
    return () => {
      delete window.__requestNewFile;
    };
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
    const initialize = async () => {
      // Initialize settings first (load from file, apply CSS variables)
      await initializeSettings();

      // Use ref to prevent double initialization in StrictMode
      if (tabletInitializedRef.current) return;
      tabletInitializedRef.current = true;

      // Wait for Tauri to be ready
      const tauriReady = await waitForTauri();
      if (!tauriReady) {
        console.warn('[App] Tauri not available, tablet features disabled');
        return;
      }

      // Use settings from store (now loaded from file)
      const tabletSettings = useSettingsStore.getState().tablet;
      await initTablet({
        backend: tabletSettings.backend,
        pollingRate: tabletSettings.pollingRate,
        pressureCurve: tabletSettings.pressureCurve,
      });

      if (tabletSettings.autoStart) {
        await startTablet();
      }
    };

    initialize();

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

  useEffect(() => {
    if (!isReady || !settingsLoaded || startupRestoreTriggeredRef.current) return;
    startupRestoreTriggeredRef.current = true;

    const restore = async () => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      );
      await restoreOnStartup();
    };

    void restore();
  }, [isReady, settingsLoaded, restoreOnStartup]);

  useEffect(() => {
    if (!isReady || !settingsLoaded) return;
    const intervalMs = Math.max(1, autosaveIntervalMinutes) * 60 * 1000;
    const timer = window.setInterval(() => {
      void runAutoSaveTick();
    }, intervalMs);

    return () => {
      window.clearInterval(timer);
    };
  }, [isReady, settingsLoaded, autosaveIntervalMinutes, runAutoSaveTick]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      void runAutoSaveTick();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [runAutoSaveTick]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    let closeRequestedHandled = false;

    const registerCloseGuard = async () => {
      if (!isTauri()) return;
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const appWindow = getCurrentWindow();
        unlisten = await appWindow.onCloseRequested(async (event) => {
          if (closeRequestedHandled) return;

          event.preventDefault();
          closeRequestedHandled = true;

          try {
            await runAutoSaveTick();
          } catch (error) {
            console.warn('[App] Autosave on close failed', error);
          }

          if (disposed) return;
          await appWindow.close();
        });
      } catch (error) {
        console.warn('[App] Failed to register close guard', error);
      }
    };

    void registerCloseGuard();
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, [runAutoSaveTick]);

  // Register floating panels (only Brush panel now uses FloatingPanel)
  const registerPanel = usePanelStore((s) => s.registerPanel);
  const closePanel = usePanelStore((s) => s.closePanel);

  useEffect(() => {
    // Only Brush Panel uses FloatingPanel now
    registerPanel({
      id: 'brush-panel',
      title: 'Brush Settings',
      defaultGeometry: { x: window.innerWidth - 300, y: 420, width: 280, height: 440 },
      defaultAlignment: { horizontal: 'right', vertical: 'top', offsetX: 320, offsetY: 80 },
      minWidth: 240,
      minHeight: 350,
    });

    // Ensure brush panel is closed by default
    closePanel('brush-panel');
  }, [registerPanel, closePanel]);

  if (!isReady) {
    return (
      <div className="loading">
        <span>Loading PaintBoard...</span>
      </div>
    );
  }

  function handleCreateNewDocument(v: {
    width: number;
    height: number;
    backgroundPreset: BackgroundPreset;
    presetId: string | null;
    orientation: 'portrait' | 'landscape';
  }): void {
    const currentToolBackground = useToolStore.getState().backgroundColor;
    const fillColor = resolveBackgroundFillColor(v.backgroundPreset, currentToolBackground);

    useHistoryStore.getState().clear();
    useSelectionStore.getState().deselectAll();
    useDocumentStore.getState().reset();
    useViewportStore.getState().resetZoom();

    useDocumentStore.getState().initDocument({
      width: v.width,
      height: v.height,
      dpi: 72,
      background: { preset: v.backgroundPreset, fillColor },
    });

    setNewFileLastUsed({
      width: v.width,
      height: v.height,
      backgroundPreset: v.backgroundPreset,
      presetId: v.presetId,
      orientation: v.orientation,
    });

    setShowNewFilePanel(false);
  }

  return (
    <div className="app">
      <Toolbar />
      <main className="workspace">
        <Canvas />
      </main>
      {/* Fixed side panels */}
      <LeftToolbar />
      <RightPanel />
      {/* Floating panels (only Brush panel now) */}
      <PanelLayer />
      {/* Toast notifications */}
      <ToastLayer />
      {/* Settings Panel */}
      <SettingsPanel />
      {/* Pattern Library Panel */}
      <PatternLibraryPanel
        isOpen={showPatternLibrary}
        onClose={() => setShowPatternLibrary(false)}
      />
      {/* Canvas Size Panel */}
      <CanvasSizePanel
        isOpen={showCanvasSizePanel}
        onClose={() => setShowCanvasSizePanel(false)}
        onApply={(options) => {
          useDocumentStore.getState().resizeCanvas(options);
          setShowCanvasSizePanel(false);
        }}
      />
      <ConfirmUnsavedChangesDialog
        isOpen={showUnsavedChangesDialog}
        onCancel={() => setShowUnsavedChangesDialog(false)}
        onDontSave={() => {
          setShowUnsavedChangesDialog(false);
          setShowNewFilePanel(true);
        }}
        onSave={async () => {
          const ok = await useFileStore.getState().save(false);
          if (!ok) return;
          setShowUnsavedChangesDialog(false);
          setShowNewFilePanel(true);
        }}
      />
      <NewFilePanel
        isOpen={showNewFilePanel}
        onClose={() => setShowNewFilePanel(false)}
        defaultValues={docDefaults}
        onCreate={handleCreateNewDocument}
      />
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
