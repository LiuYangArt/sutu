import { useEffect, useState } from 'react';
import { Canvas } from './components/Canvas';
import { Toolbar } from './components/Toolbar';
import { LayerPanel } from './components/LayerPanel';
import { useDocumentStore } from './stores/document';

function App() {
  const [isReady, setIsReady] = useState(false);
  const initDocument = useDocumentStore((s) => s.initDocument);

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
    </div>
  );
}

export default App;
