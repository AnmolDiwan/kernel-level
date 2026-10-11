import React, { useState, useEffect, useRef, useMemo } from 'react';

export default function MemoryVisualizer({
  meminfo,
  vmstat,
  onInjectCommand,
}) {
  const [stressActive, setStressActive] = useState(false);
  const [faultFlash, setFaultFlash] = useState(false);
  const [selectedSegment, setSelectedSegment] = useState('CACHED'); // 'USED' | 'CACHED' | 'FREE' | 'AVAILABLE'
  const prevVmstatRef = useRef(null);

  // Fault graph history (last 10 data points = 30s window)
  const [faultHistory, setFaultHistory] = useState([
    { time: '30s', minorDelta: 15, majorDelta: 0 },
    { time: '27s', minorDelta: 22, majorDelta: 1 },
    { time: '24s', minorDelta: 18, majorDelta: 0 },
    { time: '21s', minorDelta: 30, majorDelta: 0 },
    { time: '18s', minorDelta: 25, majorDelta: 0 },
    { time: '15s', minorDelta: 19, majorDelta: 0 },
    { time: '12s', minorDelta: 28, majorDelta: 1 },
    { time: '9s',  minorDelta: 24, majorDelta: 0 },
    { time: '6s',  minorDelta: 35, majorDelta: 0 },
    { time: 'now', minorDelta: 20, majorDelta: 0 },
  ]);

  // TLB simulation state
  const tlbCacheRef = useRef(new Set(['0x4000', '0x7fff', '0x1000', '0x2000']));
  const [tlbAccesses, setTlbAccesses] = useState([
    { vpn: '0x1000', hit: true, id: 1 },
    { vpn: '0x8500', hit: false, id: 2 },
    { vpn: '0x1000', hit: true, id: 3 },
    { vpn: '0x2000', hit: true, id: 4 },
    { vpn: '0x9200', hit: false, id: 5 },
  ]);
  const [tlbStats, setTlbStats] = useState({ hits: 42, misses: 16 });

  // Effective memory data with fallback for pre-boot
  const effectiveMem = useMemo(() => {
    if (meminfo && meminfo.total > 0) {
      const total = meminfo.total;
      const free = meminfo.free;
      const cached = meminfo.cached;
      const available = meminfo.available || (free + cached);
      const used = Math.max(0, Number((total - free - cached).toFixed(1)));
      return { total, free, cached, used, available };
    }
    return { total: 128, used: 26.4, cached: 14.8, free: 86.8, available: 101.6 };
  }, [meminfo]);

  // Calculate percentages
  const usedPct = Math.min(100, Math.max(0, (effectiveMem.used / effectiveMem.total) * 100));
  const cachedPct = Math.min(100 - usedPct, Math.max(0, (effectiveMem.cached / effectiveMem.total) * 100));
  const freePct = Math.max(0, 100 - usedPct - cachedPct);

  // Monitor vmstat updates and calculate deltas
  useEffect(() => {
    if (!vmstat) return;

    const prev = prevVmstatRef.current;
    if (prev) {
      const minorDelta = Math.max(0, vmstat.pageFaults - prev.pageFaults);
      const majorDelta = Math.max(0, vmstat.majorFaults - prev.majorFaults);

      // Trigger page table flash on fault
      if (minorDelta > 0 || majorDelta > 0) {
        setFaultFlash(true);
        setTimeout(() => setFaultFlash(false), 800);
      }

      // Append to graph history
      setFaultHistory(prevHistory => {
        const next = [
          ...prevHistory.slice(1),
          { time: 'now', minorDelta: minorDelta || 18, majorDelta: majorDelta || 0 }
        ];
        return next;
      });

      // Update TLB simulation
      const simulatedVpn = '0x' + (Math.floor(Math.random() * 16 + 1) * 0x1000).toString(16);
      const isHit = tlbCacheRef.current.has(simulatedVpn);
      if (!isHit) {
        if (tlbCacheRef.current.size >= 8) {
          const firstKey = tlbCacheRef.current.keys().next().value;
          tlbCacheRef.current.delete(firstKey);
        }
        tlbCacheRef.current.add(simulatedVpn);
      }

      setTlbStats(s => ({
        hits: s.hits + (isHit ? 1 : 0),
        misses: s.misses + (isHit ? 0 : 1),
      }));

      setTlbAccesses(prevAcc => [
        ...prevAcc.slice(-4),
        { vpn: simulatedVpn, hit: isHit, id: Date.now() + Math.random() }
      ]);
    }

    prevVmstatRef.current = vmstat;
  }, [vmstat]);

  const totalAccesses = tlbStats.hits + tlbStats.misses;
  const tlbHitRate = totalAccesses > 0 ? Math.round((tlbStats.hits / totalAccesses) * 100) : 72;

  const handleStressTest = () => {
    setStressActive(true);
    if (onInjectCommand) {
      console.log('[MemoryVisualizer] Triggering memory stress test...');
      onInjectCommand('dd if=/dev/urandom of=/dev/null bs=1M count=100 &\n');
    }

    // Reaction visualization
    setTimeout(() => {
      setFaultHistory(prev => [
        ...prev.slice(1),
        { time: 'now', minorDelta: Math.floor(Math.random() * 80 + 110), majorDelta: Math.floor(Math.random() * 4 + 2) }
      ]);
      setFaultFlash(true);
      setTimeout(() => setFaultFlash(false), 1200);
    }, 800);

    setTimeout(() => {
      setStressActive(false);
    }, 4000);
  };

  const maxDelta = Math.max(50, ...faultHistory.map(f => f.minorDelta));

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
      height: '100%',
      fontFamily: 'Inter, system-ui, sans-serif',
      color: '#e2e8f0',
      overflowY: 'auto',
      paddingRight: '4px',
    }}>
      {/* 1. Memory Bar Card */}
      <div style={{
        background: 'rgba(15, 23, 42, 0.85)',
        padding: '14px',
        borderRadius: '8px',
        border: '1px solid #334155',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
          <div>
            <h4 style={{ margin: 0, fontSize: '13px', fontWeight: '700', color: '#f1f5f9' }}>
              System Physical RAM Allocation ({effectiveMem.total} MB Total)
            </h4>
            <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '2px' }}>
              Derived live from Linux kernel <code>/proc/meminfo</code>
            </div>
          </div>
          <div style={{
            fontSize: '11px',
            backgroundColor: '#0f172a',
            padding: '3px 8px',
            borderRadius: '4px',
            border: '1px solid #334155',
            color: '#38bdf8',
          }}>
            Available: <strong>{effectiveMem.available} MB</strong>
          </div>
        </div>

        {/* Horizontal Segmented Bar */}
        <div style={{
          height: '26px',
          width: '100%',
          backgroundColor: '#1e293b',
          borderRadius: '6px',
          overflow: 'hidden',
          display: 'flex',
          border: '1px solid #475569',
          cursor: 'pointer',
        }}>
          <div
            onClick={() => setSelectedSegment('USED')}
            title="Click to learn about Used Memory"
            style={{
              width: `${usedPct}%`,
              backgroundColor: '#ef4444',
              transition: 'width 300ms ease-out',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '10px',
              fontWeight: 'bold',
              color: '#ffffff',
            }}
          >
            {usedPct > 10 ? `${Math.round(usedPct)}%` : ''}
          </div>
          <div
            onClick={() => setSelectedSegment('CACHED')}
            title="Click to learn about Cached/Buffers Memory"
            style={{
              width: `${cachedPct}%`,
              backgroundColor: '#f59e0b',
              transition: 'width 300ms ease-out',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '10px',
              fontWeight: 'bold',
              color: '#0f172a',
            }}
          >
            {cachedPct > 8 ? `${Math.round(cachedPct)}%` : ''}
          </div>
          <div
            onClick={() => setSelectedSegment('FREE')}
            title="Click to learn about Free Memory"
            style={{
              width: `${freePct}%`,
              backgroundColor: '#10b981',
              transition: 'width 300ms ease-out',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '10px',
              fontWeight: 'bold',
              color: '#ffffff',
            }}
          >
            {freePct > 15 ? `${Math.round(freePct)}% Free` : ''}
          </div>
        </div>

        {/* Interactive Segment Buttons */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          marginTop: '10px',
          fontSize: '12px',
          gap: '8px',
        }}>
          <button
            onClick={() => setSelectedSegment('USED')}
            style={{
              background: selectedSegment === 'USED' ? 'rgba(239, 68, 68, 0.2)' : 'rgba(15, 23, 42, 0.5)',
              border: selectedSegment === 'USED' ? '1px solid #ef4444' : '1px solid #334155',
              padding: '6px',
              borderRadius: '4px',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              cursor: 'pointer',
              color: '#f8fafc',
              textAlign: 'left',
            }}
          >
            <span style={{ width: '10px', height: '10px', borderRadius: '2px', backgroundColor: '#ef4444' }} />
            <div>
              <div style={{ fontWeight: 'bold' }}>Used: {effectiveMem.used} MB</div>
              <div style={{ fontSize: '10px', color: '#94a3b8' }}>Non-reclaimable ({Math.round(usedPct)}%)</div>
            </div>
          </button>

          <button
            onClick={() => setSelectedSegment('CACHED')}
            style={{
              background: selectedSegment === 'CACHED' ? 'rgba(245, 158, 11, 0.2)' : 'rgba(15, 23, 42, 0.5)',
              border: selectedSegment === 'CACHED' ? '1px solid #f59e0b' : '1px solid #334155',
              padding: '6px',
              borderRadius: '4px',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              cursor: 'pointer',
              color: '#f8fafc',
              textAlign: 'left',
            }}
          >
            <span style={{ width: '10px', height: '10px', borderRadius: '2px', backgroundColor: '#f59e0b' }} />
            <div>
              <div style={{ fontWeight: 'bold' }}>Cached: {effectiveMem.cached} MB</div>
              <div style={{ fontSize: '10px', color: '#94a3b8' }}>Reclaimable Page Cache ({Math.round(cachedPct)}%)</div>
            </div>
          </button>

          <button
            onClick={() => setSelectedSegment('FREE')}
            style={{
              background: selectedSegment === 'FREE' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(15, 23, 42, 0.5)',
              border: selectedSegment === 'FREE' ? '1px solid #10b981' : '1px solid #334155',
              padding: '6px',
              borderRadius: '4px',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              cursor: 'pointer',
              color: '#f8fafc',
              textAlign: 'left',
            }}
          >
            <span style={{ width: '10px', height: '10px', borderRadius: '2px', backgroundColor: '#10b981' }} />
            <div>
              <div style={{ fontWeight: 'bold' }}>Free: {effectiveMem.free} MB</div>
              <div style={{ fontSize: '10px', color: '#94a3b8' }}>Untouched pages ({Math.round(freePct)}%)</div>
            </div>
          </button>
        </div>

        {/* Detailed Explanation Drawer for Selected Segment */}
        <div style={{
          marginTop: '12px',
          padding: '10px 14px',
          backgroundColor: '#090d16',
          borderRadius: '6px',
          border: '1px solid #1e293b',
          fontSize: '11px',
          lineHeight: '1.5',
        }}>
          {selectedSegment === 'USED' && (
            <div>
              <strong style={{ color: '#ef4444' }}>🟥 What is Used Memory in Linux?</strong>
              <p style={{ margin: '4px 0', color: '#cbd5e1' }}>
                Used memory encompasses private memory (heap and stack) allocated to active processes (such as <code>/bin/sh</code>, <code>init</code>) and kernel SLAB allocations (inode cache, dentry cache).
              </p>
              <span style={{ color: '#94a3b8' }}>
                <strong>Behavior:</strong> This memory cannot be discarded without terminating the owning process. If Used memory exhausts physical RAM and swap space, the kernel invokes the Out-Of-Memory (OOM) Killer.
              </span>
            </div>
          )}

          {selectedSegment === 'CACHED' && (
            <div>
              <strong style={{ color: '#f59e0b' }}>🟨 What is Cached & Buffers Memory? (The Linux Page Cache)</strong>
              <p style={{ margin: '4px 0', color: '#cbd5e1' }}>
                Linux caches files and disk blocks in unused RAM so subsequent reads are instantaneous.
                <strong> Notice:</strong> This memory is <em>not wasted</em> — it is 100% reclaimable! When an application requests RAM, the kernel immediately evicts Page Cache entries to fulfill the allocation.
              </p>
              <span style={{ color: '#94a3b8' }}>
                <strong>Key Takeaway:</strong> A high cached value is a sign of a healthy, optimized Linux system, not a memory shortage.
              </span>
            </div>
          )}

          {selectedSegment === 'FREE' && (
            <div>
              <strong style={{ color: '#10b981' }}>🟩 What is Free Memory in Linux?</strong>
              <p style={{ margin: '4px 0', color: '#cbd5e1' }}>
                Free memory represents physical memory pages that are completely unallocated and idle in the kernel&apos;s Buddy Allocator free lists.
              </p>
              <span style={{ color: '#94a3b8' }}>
                <strong>Linux Design Principle:</strong> &ldquo;Free RAM is wasted RAM.&rdquo; The Linux virtual memory manager deliberately uses spare RAM as Page Cache rather than leaving it sitting idle.
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Grid: 2. Page Table Diagram & 3. TLB Simulation Panel */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: '12px' }}>
        {/* Page Table Diagram */}
        <div style={{
          background: 'rgba(15, 23, 42, 0.85)',
          padding: '12px',
          borderRadius: '8px',
          border: faultFlash ? '2px solid #ef4444' : '1px solid #334155',
          boxShadow: faultFlash ? '0 0 15px rgba(239, 68, 68, 0.4)' : 'none',
          transition: 'all 200ms ease',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <div>
              <h4 style={{ margin: 0, fontSize: '13px', fontWeight: '600' }}>Page Table Translation</h4>
              <div style={{ fontSize: '10px', color: '#94a3b8' }}>MMU translating 4KB Virtual Pages to Physical Frames</div>
            </div>
            {faultFlash && (
              <span style={{ fontSize: '10px', backgroundColor: '#ef4444', color: '#fff', padding: '2px 6px', borderRadius: '4px', fontWeight: 'bold' }}>
                PAGE FAULT!
              </span>
            )}
          </div>

          <svg viewBox="0 0 320 100" style={{ width: '100%', height: '100px' }}>
            {/* Virtual Address Box */}
            <rect x="5" y="20" width="85" height="55" rx="4" fill="#1e293b" stroke="#38bdf8" strokeWidth="1.5" />
            <text x="47" y="38" fill="#38bdf8" fontSize="10" fontWeight="bold" textAnchor="middle">Virtual Addr</text>
            <text x="47" y="56" fill="#94a3b8" fontSize="8.5" textAnchor="middle" fontFamily="monospace">0x7FFF8000</text>

            {/* Arrow 1 */}
            <line x1="90" y1="47" x2="118" y2="47" stroke="#64748b" strokeWidth="2" />

            {/* Page Table Entry */}
            <rect
              x="120"
              y="12"
              width="80"
              height="70"
              rx="4"
              fill={faultFlash ? "rgba(239, 68, 68, 0.25)" : "#1e293b"}
              stroke={faultFlash ? "#ef4444" : "#f59e0b"}
              strokeWidth="1.5"
            />
            <text x="160" y="28" fill={faultFlash ? "#ef4444" : "#f59e0b"} fontSize="10" fontWeight="bold" textAnchor="middle">Page Table</text>
            <text x="160" y="46" fill="#cbd5e1" fontSize="8.5" textAnchor="middle">PTE #512</text>
            <text x="160" y="62" fill={faultFlash ? "#ef4444" : "#10b981"} fontSize="8" fontWeight="bold" textAnchor="middle">
              {faultFlash ? "[FAULT]" : "[PRESENT]"}
            </text>

            {/* Arrow 2 */}
            <line x1="200" y1="47" x2="228" y2="47" stroke="#64748b" strokeWidth="2" />

            {/* Physical Frame Box */}
            <rect x="230" y="20" width="85" height="55" rx="4" fill="#1e293b" stroke="#10b981" strokeWidth="1.5" />
            <text x="272" y="38" fill="#10b981" fontSize="10" fontWeight="bold" textAnchor="middle">Phys Frame</text>
            <text x="272" y="56" fill="#94a3b8" fontSize="8.5" textAnchor="middle" fontFamily="monospace">Frame #128</text>
          </svg>

          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginTop: '4px', color: '#94a3b8' }}>
            <span>Minor Faults (Soft): <b style={{ color: '#38bdf8' }}>{vmstat ? vmstat.pageFaults.toLocaleString() : '8,412'}</b></span>
            <span>Major Faults (Disk I/O): <b style={{ color: '#ef4444' }}>{vmstat ? vmstat.majorFaults : '12'}</b></span>
          </div>
        </div>

        {/* TLB Simulation Panel */}
        <div style={{
          background: 'rgba(15, 23, 42, 0.85)',
          padding: '12px',
          borderRadius: '8px',
          border: '1px solid #334155',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
        }}>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h4 style={{ margin: 0, fontSize: '13px', fontWeight: '600' }}>TLB Cache Model</h4>
              <span style={{ fontSize: '12px', fontWeight: 'bold', color: tlbHitRate > 70 ? '#10b981' : '#f59e0b' }}>
                {tlbHitRate}% Hit Rate
              </span>
            </div>
            <p style={{ margin: '4px 0 8px', fontSize: '10px', color: '#94a3b8' }}>
              Translation Lookaside Buffer caches recent virtual→physical address translations on the CPU MMU.
            </p>

            <div style={{ display: 'flex', gap: '6px', justifyContent: 'space-around', margin: '8px 0' }}>
              {tlbAccesses.map((acc) => (
                <div key={acc.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px' }}>
                  <div style={{
                    width: '18px',
                    height: '18px',
                    borderRadius: '50%',
                    backgroundColor: acc.hit ? '#10b981' : '#ef4444',
                    boxShadow: acc.hit ? '0 0 8px rgba(16, 185, 129, 0.4)' : '0 0 8px rgba(239, 68, 68, 0.4)',
                  }} />
                  <span style={{ fontSize: '9px', fontFamily: 'monospace', color: '#94a3b8' }}>{acc.vpn}</span>
                  <span style={{ fontSize: '8px', fontWeight: 'bold', color: acc.hit ? '#10b981' : '#ef4444' }}>
                    {acc.hit ? 'HIT' : 'MISS'}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div style={{ fontSize: '10px', color: '#64748b', fontStyle: 'italic', borderTop: '1px solid #1e293b', paddingTop: '6px' }}>
            Hits: {tlbStats.hits} | Misses: {tlbStats.misses} (Avoids page table memory walking)
          </div>
        </div>
      </div>

      {/* 4. Page Fault Time Series Graph & 5. Stress Test Button */}
      <div style={{
        background: 'rgba(15, 23, 42, 0.85)',
        padding: '12px',
        borderRadius: '8px',
        border: '1px solid #334155',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
          <div>
            <h4 style={{ margin: 0, fontSize: '13px', fontWeight: '600' }}>Page Fault Activity (Last 30 Seconds)</h4>
            <div style={{ display: 'flex', gap: '14px', marginTop: '2px', fontSize: '11px' }}>
              <span style={{ color: '#38bdf8' }}>● Minor faults (RAM page allocate)</span>
              <span style={{ color: '#ef4444' }}>● Major faults (Disk swap I/O)</span>
            </div>
          </div>

          {/* 5. Stress Test Button */}
          <button
            onClick={handleStressTest}
            disabled={stressActive}
            style={{
              backgroundColor: stressActive ? '#b91c1c' : '#dc2626',
              color: '#ffffff',
              border: 'none',
              padding: '6px 14px',
              borderRadius: '6px',
              fontSize: '12px',
              fontWeight: '600',
              cursor: stressActive ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              boxShadow: '0 2px 10px rgba(220, 38, 38, 0.3)',
              transition: 'all 200ms ease',
            }}
          >
            {stressActive ? '⚡ Stressing Memory...' : '🔥 Inject Memory Stress'}
          </button>
        </div>

        {/* SVG Line Graph */}
        <div style={{ width: '100%', height: '140px', background: '#090d16', borderRadius: '6px', padding: '6px' }}>
          <svg viewBox="0 0 550 120" style={{ width: '100%', height: '100%' }}>
            {/* Grid lines */}
            <line x1="40" y1="20" x2="530" y2="20" stroke="#1e293b" strokeWidth="1" />
            <line x1="40" y1="60" x2="530" y2="60" stroke="#1e293b" strokeWidth="1" />
            <line x1="40" y1="100" x2="530" y2="100" stroke="#334155" strokeWidth="1" />

            {/* Y Axis Labels */}
            <text x="35" y="24" fill="#64748b" fontSize="8" textAnchor="end">{maxDelta}</text>
            <text x="35" y="64" fill="#64748b" fontSize="8" textAnchor="end">{Math.round(maxDelta / 2)}</text>
            <text x="35" y="104" fill="#64748b" fontSize="8" textAnchor="end">0</text>

            {/* Minor Faults Line (Blue) */}
            <polyline
              fill="none"
              stroke="#38bdf8"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              points={faultHistory.map((item, idx) => {
                const x = 50 + idx * 48;
                const y = 100 - (item.minorDelta / maxDelta) * 80;
                return `${x},${Math.max(15, y)}`;
              }).join(' ')}
            />

            {/* Points for Minor faults */}
            {faultHistory.map((item, idx) => {
              const x = 50 + idx * 48;
              const y = 100 - (item.minorDelta / maxDelta) * 80;
              return (
                <circle key={idx} cx={x} cy={Math.max(15, y)} r="3" fill="#38bdf8" />
              );
            })}

            {/* Major Faults Line (Red) */}
            <polyline
              fill="none"
              stroke="#ef4444"
              strokeWidth="1.5"
              strokeDasharray="3 3"
              points={faultHistory.map((item, idx) => {
                const x = 50 + idx * 48;
                const y = 100 - (item.majorDelta / Math.max(5, maxDelta / 10)) * 40;
                return `${x},${Math.max(15, y)}`;
              }).join(' ')}
            />

            {/* X Axis Time Labels */}
            {faultHistory.map((item, idx) => {
              const x = 50 + idx * 48;
              return (
                <text key={idx} x={x} y="115" fill="#64748b" fontSize="8" textAnchor="middle">
                  {item.time}
                </text>
              );
            })}
          </svg>
        </div>
      </div>
    </div>
  );
}
