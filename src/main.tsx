import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/global.css';
import { VibeKanbanWebCompanion } from 'vibe-kanban-web-companion';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
    <VibeKanbanWebCompanion />
  </React.StrictMode>
);
