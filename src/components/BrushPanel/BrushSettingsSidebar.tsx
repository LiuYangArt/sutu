export interface TabConfig {
  id: string;
  label: string;
  icon?: React.ReactNode;
  disabled?: boolean;
}

interface BrushSettingsSidebarProps {
  tabs: TabConfig[];
  activeTabId: string;
  onTabSelect: (id: string) => void;
}

export function BrushSettingsSidebar({
  tabs,
  activeTabId,
  onTabSelect,
}: BrushSettingsSidebarProps): JSX.Element {
  return (
    <div className="brush-sidebar">
      {/* Brushes Tab - Special styling usually, but for now part of the list or top */}
      {tabs.map((tab) => (
        <button
          key={tab.id}
          className={`sidebar-item ${activeTabId === tab.id ? 'active' : ''} ${tab.disabled ? 'disabled' : ''}`}
          onClick={() => !tab.disabled && onTabSelect(tab.id)}
          title={tab.disabled ? 'Coming Soon' : tab.label}
        >
          {/* Optional Checkbox for future enabling/disabling features */}
          {/* <input type="checkbox" checked={someState} readOnly /> */}
          <span className="sidebar-label">{tab.label}</span>
          {/* Lock icon could go here */}
        </button>
      ))}
    </div>
  );
}
