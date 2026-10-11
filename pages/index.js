import React, { useState, useEffect } from 'react';
import Head from 'next/head';
import dynamic from 'next/dynamic';
import { KernelDataProvider, useKernelData } from '@/context/KernelDataContext';
import CPUScheduler from '@/components/CPUScheduler';
import MemoryVisualizer from '@/components/MemoryVisualizer';
import SerialParser from '@/components/SerialParser';

// Dynamically import V86Wrapper with SSR disabled to prevent browser globals issues
const V86Wrapper = dynamic(() => import('@/components/V86Wrapper'), {
  ssr: false,
  loading: () => (
    <div style={{
      width: '100%',
      height: '380px',
      backgroundColor: '#000',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: '#64748b',
      borderRadius: '8px',
      fontFamily: 'monospace',
    }}>
      Loading v86 core...
    </div>
  ),
});

function KernelScopeApp() {
  const [activeTab, setActiveTab] = useState('cpu');
  const [mounted, setMounted] = useState(false);
  const [showConsole, setShowConsole] = useState(false);

  const {
    bootState,
    setBootState,
    bootTimer,
    meminfo,
    vmstat,
    procStat,
    processes,
    emptyDataCount,
    initError,
    setInitError,
    multiplexer,
    v86WrapperRef,
    sendCommand,
    restartEmulator,
    handleMeminfoUpdate,
    handleVmstatUpdate,
    handleProcStatUpdate,
    handleProcessesUpdate,
  } = useKernelData();

  useEffect(() => {
    setMounted(true);
  }, []);

  const isBooting = bootState === 'BOOTING';

  return (
    <>
      <Head>
        <title>KernelScope - Live Linux Kernel Visualizer</title>
        <meta name="description" content="Real-time Linux kernel CPU scheduler and memory visualizer running on in-browser v86" />
      </Head>

      <div style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        width: '100vw',
        backgroundColor: '#07090e',
        color: '#f8fafc',
      }}>
        {/* Header Bar */}
        <header style={{
          height: '60px',
          borderBottom: '1px solid rgba(51, 65, 85, 0.6)',
          backgroundColor: 'rgba(11, 17, 32, 0.9)',
          backdropFilter: 'blur(12px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 24px',
          zIndex: 10,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{
              width: '32px',
              height: '32px',
              borderRadius: '8px',
              background: 'linear-gradient(135deg, #0284c7, #38bdf8)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '18px',
              boxShadow: '0 0 12px rgba(56, 189, 248, 0.4)',
            }}>
              ⚙️
            </div>
            <div>
              <h1 style={{ margin: 0, fontSize: '18px', fontWeight: '800', letterSpacing: '-0.3px', background: 'linear-gradient(90deg, #f8fafc, #94a3b8)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                KernelScope
              </h1>
              <div style={{ fontSize: '11px', color: '#64748b' }}>v86 In-Browser Linux Kernel Visualizer</div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            {/* Error banner if /proc empty 3 times */}
            {emptyDataCount >= 3 && (
              <div style={{
                backgroundColor: 'rgba(239, 68, 68, 0.15)',
                border: '1px solid #ef4444',
                color: '#fca5a5',
                padding: '4px 10px',
                borderRadius: '6px',
                fontSize: '11px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}>
                <span>⚠️ Kernel not responding</span>
              </div>
            )}

            {/* Alpine Linux Boot Status Badge */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              backgroundColor: 'rgba(30, 41, 59, 0.8)',
              border: `1px solid ${bootState === 'READY' ? '#059669' : '#d97706'}`,
              padding: '6px 14px',
              borderRadius: '20px',
              fontSize: '12px',
              boxShadow: bootState === 'READY' ? '0 0 10px rgba(16, 185, 129, 0.2)' : 'none',
            }}>
              <span style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                backgroundColor: bootState === 'READY' ? '#10b981' : '#f59e0b',
                display: 'inline-block',
                boxShadow: `0 0 8px ${bootState === 'READY' ? '#10b981' : '#f59e0b'}`,
              }} />
              <span style={{ fontWeight: '600', color: bootState === 'READY' ? '#34d399' : '#fbbf24' }}>
                Alpine Linux
              </span>
              <span style={{ color: '#94a3b8' }}>•</span>
              <span style={{ color: '#cbd5e1' }}>
                {bootState === 'READY' ? 'READY' : `BOOTING (${bootTimer}s)`}
              </span>
            </div>
          </div>
        </header>

        {/* Emulator Init Error Banner */}
        {initError && (
          <div style={{
            backgroundColor: '#7f1d1d',
            color: '#fecaca',
            padding: '10px 24px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            fontSize: '13px',
          }}>
            <span><strong>Emulator failed to load:</strong> {initError}</span>
            <button
              onClick={restartEmulator}
              style={{
                backgroundColor: '#dc2626',
                color: '#ffffff',
                border: 'none',
                padding: '4px 12px',
                borderRadius: '4px',
                cursor: 'pointer',
                fontWeight: 'bold',
              }}
            >
              Retry Boot
            </button>
          </div>
        )}

        {/* Main Grid: Left Panel (40%) and Right Panel (60%) */}
        <main style={{
          flex: 1,
          display: 'grid',
          gridTemplateColumns: '40% 60%',
          overflow: 'hidden',
          padding: '16px',
          gap: '16px',
        }}>
          {/* LEFT PANEL (40%): V86 Screen Terminal */}
          <section style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
            height: '100%',
            overflow: 'hidden',
          }}>
            <div style={{
              flex: 1,
              backgroundColor: 'rgba(15, 23, 42, 0.7)',
              borderRadius: '10px',
              border: '1px solid rgba(51, 65, 85, 0.7)',
              padding: '12px',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '0 8px 30px rgba(0, 0, 0, 0.4)',
            }}>
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '8px',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '13px', fontWeight: 'bold', color: '#f1f5f9' }}>V86 Terminal Screen</span>
                  <span style={{ fontSize: '11px', color: '#64748b' }}>(ttyS0 + VGA)</span>
                </div>
                <button
                  onClick={() => setShowConsole(!showConsole)}
                  style={{
                    backgroundColor: showConsole ? '#0284c7' : '#1e293b',
                    color: '#e2e8f0',
                    border: '1px solid #475569',
                    padding: '3px 8px',
                    borderRadius: '4px',
                    fontSize: '11px',
                    cursor: 'pointer',
                  }}
                >
                  {showConsole ? 'Hide Stream Monitor' : 'Show Stream Monitor'}
                </button>
              </div>

              {/* V86 Emulator Component */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                {mounted && (
                  <V86Wrapper
                    ref={v86WrapperRef}
                    multiplexer={multiplexer}
                    onBootStateChange={setBootState}
                    onMeminfoUpdate={handleMeminfoUpdate}
                    onVmstatUpdate={handleVmstatUpdate}
                    onProcStatUpdate={handleProcStatUpdate}
                    onProcessesUpdate={handleProcessesUpdate}
                  />
                )}
              </div>
            </div>

            {/* Optional Collapsible Diagnostic Serial Monitor */}
            {showConsole && (
              <div style={{ height: '180px' }}>
                <SerialParser multiplexer={multiplexer} />
              </div>
            )}
          </section>

          {/* RIGHT PANEL (60%): Tab Switcher & Visualizers */}
          <section style={{
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            backgroundColor: 'rgba(15, 23, 42, 0.7)',
            borderRadius: '10px',
            border: '1px solid rgba(51, 65, 85, 0.7)',
            padding: '16px',
            position: 'relative',
            overflow: 'hidden',
            boxShadow: '0 8px 30px rgba(0, 0, 0, 0.4)',
          }}>
            {/* Tab Switcher Header */}
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              borderBottom: '1px solid #334155',
              paddingBottom: '12px',
              marginBottom: '14px',
            }}>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  id="tab-cpu-btn"
                  onClick={() => setActiveTab('cpu')}
                  style={{
                    backgroundColor: activeTab === 'cpu' ? '#0284c7' : 'rgba(30, 41, 59, 0.6)',
                    color: activeTab === 'cpu' ? '#ffffff' : '#94a3b8',
                    border: activeTab === 'cpu' ? '1px solid #38bdf8' : '1px solid #334155',
                    padding: '8px 18px',
                    borderRadius: '6px',
                    fontSize: '13px',
                    fontWeight: '600',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    transition: 'all 200ms ease',
                  }}
                >
                  <span>⚡</span> CPU Scheduling
                </button>
                <button
                  id="tab-memory-btn"
                  onClick={() => setActiveTab('memory')}
                  style={{
                    backgroundColor: activeTab === 'memory' ? '#0284c7' : 'rgba(30, 41, 59, 0.6)',
                    color: activeTab === 'memory' ? '#ffffff' : '#94a3b8',
                    border: activeTab === 'memory' ? '1px solid #38bdf8' : '1px solid #334155',
                    padding: '8px 18px',
                    borderRadius: '6px',
                    fontSize: '13px',
                    fontWeight: '600',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    transition: 'all 200ms ease',
                  }}
                >
                  <span>🧠</span> Memory & Paging
                </button>
              </div>

              <div style={{ fontSize: '12px', color: '#64748b' }}>
                Polling rate: <strong>3.0s</strong> (/proc)
              </div>
            </div>

            {/* Tab 1 Content: CPUScheduler (Kept in DOM so state/data is preserved) */}
            <div style={{
              flex: 1,
              display: activeTab === 'cpu' ? 'flex' : 'none',
              flexDirection: 'column',
              overflow: 'hidden',
            }}>
              <CPUScheduler
                procStat={procStat}
                processes={processes}
              />
            </div>

            {/* Tab 2 Content: MemoryVisualizer (Kept in DOM so state/data is preserved) */}
            <div style={{
              flex: 1,
              display: activeTab === 'memory' ? 'flex' : 'none',
              flexDirection: 'column',
              overflow: 'hidden',
            }}>
              <MemoryVisualizer
                meminfo={meminfo}
                vmstat={vmstat}
                onInjectCommand={sendCommand}
              />
            </div>

            {/* Booting Overlay (disappears when bootState === 'READY') */}
            {isBooting && (
              <div style={{
                position: 'absolute',
                inset: 0,
                backgroundColor: 'rgba(7, 9, 14, 0.88)',
                backdropFilter: 'blur(6px)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 20,
                gap: '16px',
              }}>
                <div className="spinner" />
                <div style={{ textAlign: 'center' }}>
                  <h3 style={{ fontSize: '16px', fontWeight: '600', color: '#f1f5f9', margin: '0 0 6px 0' }}>
                    {bootTimer > 30 ? 'Still booting, please wait...' : 'Booting Alpine Linux...'}
                  </h3>
                  <p style={{ fontSize: '13px', color: '#94a3b8', margin: 0 }}>
                    Initializing Seabios, loading kernel image & mounting procfs ({bootTimer}s elapsed)
                  </p>
                </div>
              </div>
            )}
          </section>
        </main>
      </div>
    </>
  );
}

export default function HomePage() {
  return (
    <KernelDataProvider>
      <KernelScopeApp />
    </KernelDataProvider>
  );
}
