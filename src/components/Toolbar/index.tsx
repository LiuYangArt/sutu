import { useState, useRef, useEffect } from 'react';
import {
  Undo2,
  Redo2,
  ZoomIn,
  ZoomOut,
  Menu,
  Settings,
  LayoutGrid,
  Save,
  FolderOpen,
  FilePlus,
  LogOut,
  ChevronRight,
  Paintbrush,
  Grid3x3,
  ImageUpscale,
  Share,
} from 'lucide-react';
import { useToolStore } from '@/stores/tool';
import { useViewportStore } from '@/stores/viewport';
import { useHistoryStore } from '@/stores/history';
import { usePanelStore } from '@/stores/panel';
import { useSettingsStore } from '@/stores/settings';
import { useFileStore } from '@/stores/file';
import { useDocumentStore } from '@/stores/document';
import { GradientToolIcon } from '@/components/common/GradientToolIcon';
import { BrushToolbar } from './BrushToolbar';
import { GradientToolbar } from './GradientToolbar';
import { SelectionToolbar } from './SelectionToolbar';
import { ZoomToolOptions } from './ZoomToolOptions';
import './Toolbar.css';

/** Common icon props for toolbar icons */
const ICON_PROPS = { size: 18, strokeWidth: 1.5 } as const;
type AppMenuSubmenu = 'none' | 'openRecent' | 'panels';

function getFileNameFromPath(path: string): string {
  const fileName = path.split(/[\\/]/).pop()?.trim();
  return fileName && fileName.length > 0 ? fileName : path;
}

/** App Menu component */
function AppMenu(): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const [activeSubmenu, setActiveSubmenu] = useState<AppMenuSubmenu>('none');
  const menuRef = useRef<HTMLDivElement>(null);

  // Floating panels shown in menu.
  const brushPanel = usePanelStore((s) => s.panels['brush-panel']);
  const gradientPanel = usePanelStore((s) => s.panels['gradient-panel']);
  const openPanel = usePanelStore((s) => s.openPanel);
  const closePanel = usePanelStore((s) => s.closePanel);

  // Settings
  const openSettings = useSettingsStore((s) => s.openSettings);
  const recentFiles = useSettingsStore((s) => s.general.recentFiles);

  // File operations
  const fileSave = useFileStore((s) => s.save);
  const fileOpen = useFileStore((s) => s.open);
  const fileOpenPath = useFileStore((s) => s.openPath);
  const isSaving = useFileStore((s) => s.isSaving);
  const isLoading = useFileStore((s) => s.isLoading);
  const isDirty = useDocumentStore((s) => s.isDirty);
  const filePath = useDocumentStore((s) => s.filePath);
  const showUnsavedIndicator = isDirty || !filePath;

  // Close menu when clicking outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setActiveSubmenu('none');
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const handleToggleBrushPanel = () => {
    if (brushPanel?.isOpen) {
      closePanel('brush-panel');
    } else {
      openPanel('brush-panel');
    }
  };

  const handleToggleGradientPanel = () => {
    if (gradientPanel?.isOpen) {
      closePanel('gradient-panel');
    } else {
      openPanel('gradient-panel');
    }
  };

  const handleOpenSettings = () => {
    setIsOpen(false);
    openSettings();
  };

  const handleOpen = async () => {
    setIsOpen(false);
    await fileOpen();
  };

  const handleOpenRecentPath = async (path: string) => {
    setIsOpen(false);
    setActiveSubmenu('none');
    await fileOpenPath(path, {
      rememberAsLastSaved: true,
      clearUnsavedTemp: true,
    });
  };

  function handleNew(): void {
    setIsOpen(false);
    const win = window as Window & { __requestNewFile?: () => void };
    win.__requestNewFile?.();
  }

  const handleSave = async () => {
    setIsOpen(false);
    await fileSave(false);
  };

  const handleSaveAs = async () => {
    setIsOpen(false);
    await fileSave(true);
  };

  const handleOpenQuickExport = () => {
    setIsOpen(false);
    const win = window as Window & { __openQuickExportPanel?: () => void };
    win.__openQuickExportPanel?.();
  };

  const handleToggleMenu = () => {
    setActiveSubmenu('none');
    setIsOpen((prev) => !prev);
  };

  function handleExit(): void {
    setIsOpen(false);
    const win = window as Window & { __requestAppExit?: () => void };
    win.__requestAppExit?.();
  }

  return (
    <div className="app-menu" ref={menuRef}>
      <button className="menu-btn" onClick={handleToggleMenu} title="Menu">
        <Menu size={20} strokeWidth={1.5} />
      </button>

      {isOpen && (
        <div className="menu-dropdown">
          <button className="menu-item" onClick={handleNew}>
            <FilePlus size={16} />
            <span>New</span>
            <span className="shortcut">Ctrl+N</span>
          </button>

          <button className="menu-item" onClick={handleOpen} disabled={isLoading}>
            <FolderOpen size={16} />
            <span>Open</span>
            <span className="shortcut">Ctrl+O</span>
          </button>

          <div
            className="menu-item has-submenu"
            onMouseEnter={() => setActiveSubmenu('openRecent')}
            onMouseLeave={() => setActiveSubmenu('none')}
          >
            <FolderOpen size={16} />
            <span>Open Recent</span>
            <ChevronRight size={14} className="submenu-arrow" />

            {activeSubmenu === 'openRecent' && (
              <div className="submenu">
                {recentFiles.length === 0 ? (
                  <div className="menu-item submenu-empty">No recent files</div>
                ) : (
                  recentFiles.map((path) => (
                    <button
                      key={path}
                      className="menu-item recent-file-item"
                      onClick={() => void handleOpenRecentPath(path)}
                      disabled={isLoading}
                      title={path}
                    >
                      <FolderOpen size={14} />
                      <span className="recent-file-label">{getFileNameFromPath(path)}</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          <button className="menu-item" onClick={handleSave} disabled={isSaving}>
            <Save size={16} />
            <span>Save{showUnsavedIndicator ? ' *' : ''}</span>
            <span className="shortcut">Ctrl+S</span>
          </button>

          <button className="menu-item" onClick={handleSaveAs} disabled={isSaving}>
            <Save size={16} />
            <span>Save As...</span>
            <span className="shortcut">Ctrl+Shift+S</span>
          </button>

          <button className="menu-item" onClick={handleOpenQuickExport}>
            <Share size={16} />
            <span>Export</span>
            <span className="shortcut">Ctrl+Shift+E</span>
          </button>

          <div className="menu-divider" />

          <button className="menu-item" onClick={handleOpenSettings}>
            <Settings size={16} />
            <span>Settings</span>
          </button>

          <div
            className="menu-item has-submenu"
            onMouseEnter={() => setActiveSubmenu('panels')}
            onMouseLeave={() => setActiveSubmenu('none')}
          >
            <LayoutGrid size={16} />
            <span>Panels</span>
            <ChevronRight size={14} className="submenu-arrow" />

            {activeSubmenu === 'panels' && (
              <div className="submenu">
                <button className="menu-item" onClick={handleToggleBrushPanel}>
                  <Paintbrush size={14} />
                  <span>Brush Settings</span>
                  <span className="shortcut">F5</span>
                </button>
                <button className="menu-item" onClick={handleToggleGradientPanel}>
                  <GradientToolIcon size={14} strokeWidth={1.5} />
                  <span>Gradient Editor</span>
                </button>
                <button
                  className="menu-item"
                  onClick={() => {
                    const win = window as Window & { __openPatternLibrary?: () => void };
                    win.__openPatternLibrary?.();
                    setIsOpen(false);
                  }}
                >
                  <Grid3x3 size={14} />
                  <span>Pattern Library</span>
                  <span className="shortcut">F6</span>
                </button>
                <button
                  className="menu-item"
                  onClick={() => {
                    const win = window as Window & { __openBrushLibrary?: () => void };
                    win.__openBrushLibrary?.();
                    setIsOpen(false);
                  }}
                >
                  <Paintbrush size={14} />
                  <span>Brush Library</span>
                  <span className="shortcut">Ctrl+F5</span>
                </button>
              </div>
            )}
          </div>

          <div className="menu-divider" />

          <button className="menu-item" onClick={handleExit}>
            <LogOut size={16} />
            <span>Exit</span>
          </button>
        </div>
      )}
    </div>
  );
}

export function Toolbar(): JSX.Element {
  const currentTool = useToolStore((s) => s.currentTool);

  const { scale, zoomIn, zoomOut, resetZoom } = useViewportStore();

  const { canUndo, canRedo } = useHistoryStore();

  const zoomPercent = Math.round(scale * 100);

  const handleUndo = () => {
    const win = window as Window & { __canvasUndo?: () => void };
    win.__canvasUndo?.();
  };

  const handleRedo = () => {
    const win = window as Window & { __canvasRedo?: () => void };
    win.__canvasRedo?.();
  };

  const handleOpenCanvasSizePanel = () => {
    const win = window as Window & { __openCanvasSizePanel?: () => void };
    win.__openCanvasSizePanel?.();
  };

  const handleOpenQuickExportPanel = () => {
    const win = window as Window & { __openQuickExportPanel?: () => void };
    win.__openQuickExportPanel?.();
  };

  return (
    <header className="toolbar">
      <AppMenu />

      <div className="toolbar-divider" />

      <div className="toolbar-section tool-options">
        {(currentTool === 'brush' || currentTool === 'eraser') && <BrushToolbar />}
        {currentTool === 'gradient' && <GradientToolbar />}
        {(currentTool === 'select' || currentTool === 'lasso') && <SelectionToolbar />}
        {(currentTool === 'zoom' || currentTool === 'move') && <ZoomToolOptions />}
      </div>

      <div className="toolbar-spacer" />

      <div className="toolbar-section canvas-actions">
        <button onClick={handleOpenCanvasSizePanel} title="Canvas Size">
          <ImageUpscale {...ICON_PROPS} />
        </button>
        <button onClick={handleOpenQuickExportPanel} title="Quick Export (Ctrl+Shift+E)">
          <Share {...ICON_PROPS} />
        </button>
      </div>

      <div className="toolbar-divider" />

      <div className="toolbar-section zoom-controls">
        <button onClick={() => zoomOut()} title="Zoom Out">
          <ZoomOut {...ICON_PROPS} />
        </button>
        <button className="zoom-level" onClick={resetZoom} title="Reset Zoom (100%)">
          {zoomPercent}%
        </button>
        <button onClick={() => zoomIn()} title="Zoom In">
          <ZoomIn {...ICON_PROPS} />
        </button>
      </div>

      <div className="toolbar-divider" />

      <div className="toolbar-section history-actions">
        <button
          data-testid="undo-btn"
          disabled={!canUndo()}
          onClick={handleUndo}
          title="Undo (Ctrl+Z)"
        >
          <Undo2 {...ICON_PROPS} />
        </button>
        <button
          data-testid="redo-btn"
          disabled={!canRedo()}
          onClick={handleRedo}
          title="Redo (Ctrl+Y)"
        >
          <Redo2 {...ICON_PROPS} />
        </button>
      </div>
    </header>
  );
}
