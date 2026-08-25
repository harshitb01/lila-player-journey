import { useState } from 'react';

import { DataQualityPanel } from './components/DataQualityPanel';
import { Header } from './components/Header';
import { Inspector } from './components/Inspector';
import { LeftRail } from './components/LeftRail';
import { Legend } from './components/Legend';
import { MapCanvas } from './components/MapCanvas';
import { RegionInspector } from './components/RegionInspector';
import { AppLoading, FatalError, TracksError } from './components/States';
import { Timeline } from './components/Timeline';
import { useAppState } from './state/store';

export function App() {
  const { status, error } = useAppState();
  const [showDataQuality, setShowDataQuality] = useState(false);

  if (status === 'loading') return <AppLoading />;
  if (status === 'error' && error) {
    return <FatalError message={error.message} detail={error.detail} />;
  }

  return (
    <div className="flex h-full flex-col">
      <Header onOpenDataQuality={() => setShowDataQuality(true)} />
      <div className="flex min-h-0 flex-1">
        <LeftRail />
        <main className="relative min-w-0 flex-1">
          <MapCanvas />
          <RegionInspector />
          <Legend />
          <TracksError />
        </main>
        <Inspector />
      </div>
      <Timeline />
      {showDataQuality && <DataQualityPanel onClose={() => setShowDataQuality(false)} />}
    </div>
  );
}
