import React, { useState, useEffect, useRef, useMemo } from 'react';

const LANE_CONFIG = {
  RUNNING: {
    label: 'RUNNING (CPU CORE)',
    desc: 'Actively executing instructions in the CPU pipeline',
    color: '#10b981',
    bg: 'rgba(16, 185, 129, 0.12)',
    border: '#059669',
    y: 35,
  },
  READY: {
    label: 'READY (CFS RUN QUEUE)',
    desc: 'Runnable threads waiting for their CFS time-slice quantum',
    color: '#f59e0b',
    bg: 'rgba(245, 158, 11, 0.12)',
    border: '#d97706',
    y: 135,
  },
  BLOCKED: {
    label: 'BLOCKED / SLEEPING (WAIT QUEUE)',
    desc: 'Waiting for I/O events, hardware interrupts, or sleep timer',
    color: '#64748b',
    bg: 'rgba(100, 116, 139, 0.12)',
    border: '#475569',
    y: 235,
  },
};

const PROCESS_DESCRIPTIONS = {
  init: 'Root Init Process (PID 1): Ancestor of all processes; mounts rootfs and reaps orphaned child processes.',
  kthreadd: 'Kernel Thread Daemon (PID 2): Parent of all kernel background worker threads.',
  'ksoftirqd/0': 'Software IRQ Daemon: Processes high-volume deferred software interrupts (bottom-half processing).',
  'kworker/0:0': 'Kernel Workqueue Thread: Asynchronous kernel task execution for drivers and subsystems.',
  'kworker/0:0H': 'High-Priority Kernel Workqueue: Handles latency-sensitive background kernel tasks.',
  syslogd: 'Busybox System Logger: Captures and routes kernel log events (klogd/printk).',
  sh: 'Busybox Shell (/bin/sh): Interactive command interpreter executing commands and scripts.',
  writeback: 'Memory Writeback Thread: Flushes dirty page cache pages from RAM to storage.',
  kcompactd0: 'Kernel Memory Compaction Daemon: Defragments physical memory zones to satisfy high-order allocations.',
  kswapd0: 'Kernel Page Replacement Daemon: Reclaims inactive anonymous and page cache pages when free memory drops.',
  kdevtmpfs: 'Device Nodes Daemon: Automatically populates and manages the dynamic /dev filesystem in RAM.',
  oom_reaper: 'Out-Of-Memory Reaper: Quickly reclaims memory from processes terminated by the Linux OOM killer.',
  ps: 'Process Status Utility: Queries and reads /proc entries to display current system state.',
  cat: 'Core Utility: Reads files from pseudo-filesystems like /proc and writes to standard output.',
};

export default function CPUScheduler({
  procStat,
  processes = [],
  onProcessSelect,
}) {
  const [selectedPid, setSelectedPid] = useState(1);
  const [contextSwitches, setContextSwitches] = useState(0);
  const [cpuUsage, setCpuUsage] = useState(14.2);
  const [activeView, setActiveView] = useState('LANES'); // 'LANES' | 'GANTT' | 'TABLE'
  const prevCpuRef = useRef(null);
  const prevRunningPidRef = useRef(null);
  const [simulatedReadyPids, setSimulatedReadyPids] = useState(new Set([2, 5]));

  // Gantt chart historical slices (last 16 intervals)
  const [ganttHistory, setGanttHistory] = useState([
    { time: '-15s', pid: 1, name: 'init', color: '#38bdf8' },
    { time: '-14s', pid: 3, name: 'ksoftirqd', color: '#10b981' },
    { time: '-13s', pid: 21, name: 'sh', color: '#fbbf24' },
    { time: '-12s', pid: 3, name: 'ksoftirqd', color: '#10b981' },
    { time: '-11s', pid: 2, name: 'kthreadd', color: '#a78bfa' },
    { time: '-10s', pid: 21, name: 'sh', color: '#fbbf24' },
    { time: '-9s',  pid: 1, name: 'init', color: '#38bdf8' },
    { time: '-8s',  pid: 4, name: 'kworker', color: '#f43f5e' },
    { time: '-7s',  pid: 3, name: 'ksoftirqd', color: '#10b981' },
    { time: '-6s',  pid: 21, name: 'sh', color: '#fbbf24' },
    { time: '-5s',  pid: 12, name: 'kcompactd', color: '#2dd4bf' },
    { time: '-4s',  pid: 3, name: 'ksoftirqd', color: '#10b981' },
    { time: '-3s',  pid: 21, name: 'sh', color: '#fbbf24' },
    { time: '-2s',  pid: 4, name: 'kworker', color: '#f43f5e' },
    { time: '-1s',  pid: 3, name: 'ksoftirqd', color: '#10b981' },
    { time: 'Now',  pid: 3, name: 'ksoftirqd', color: '#10b981' },
  ]);

  // Baseline processes list if procfs warming up
  const effectiveProcesses = useMemo(() => {
    if (processes && processes.length >= 5) {
      return processes;
    }
    return [
      { pid: 1,  name: 'init', state: 'S', priority: 20 },
      { pid: 2,  name: 'kthreadd', state: 'S', priority: 20 },
      { pid: 3,  name: 'ksoftirqd/0', state: 'R', priority: 20 },
      { pid: 4,  name: 'kworker/0:0', state: 'S', priority: 20 },
      { pid: 5,  name: 'syslogd', state: 'S', priority: 20 },
      { pid: 6,  name: 'kworker/0:0H', state: 'S', priority: 0 },
      { pid: 8,  name: 'kdevtmpfs', state: 'S', priority: 20 },
      { pid: 11, name: 'writeback', state: 'S', priority: 20 },
      { pid: 12, name: 'kcompactd0', state: 'S', priority: 20 },
      { pid: 15, name: 'kswapd0', state: 'S', priority: 20 },
      { pid: 21, name: 'sh', state: 'S', priority: 20 },
    ];
  }, [processes]);

  // CPU delta computation
  useEffect(() => {
    if (procStat && procStat.cpuMetrics) {
      const curr = procStat.cpuMetrics;
      const prev = prevCpuRef.current;
      if (prev && curr.total > prev.total) {
        const deltaTotal = curr.total - prev.total;
        const deltaBusy = (curr.user - prev.user) + (curr.system - prev.system);
        const pct = Math.max(2, Math.min(100, Math.round((deltaBusy / deltaTotal) * 100 * 10) / 10));
        setCpuUsage(pct);
      }
      prevCpuRef.current = curr;
    }
  }, [procStat]);

  // Context switch detection and dynamic ready queue
  useEffect(() => {
    if (procStat && procStat.ctxt) {
      setContextSwitches(procStat.ctxt);
    }

    // Determine current running process
    let currentRunning = effectiveProcesses.find(p => p.state === 'R');
    if (!currentRunning && effectiveProcesses.length > 0) {
      const activeIdx = Math.floor((Date.now() / 2500) % Math.min(effectiveProcesses.length, 5));
      currentRunning = effectiveProcesses[activeIdx];
    }

    const currentRunningPid = currentRunning ? currentRunning.pid : null;
    if (currentRunningPid && currentRunningPid !== prevRunningPidRef.current) {
      setContextSwitches(c => c + 1);
      prevRunningPidRef.current = currentRunningPid;

      // Update Gantt history
      setGanttHistory(prev => [
        ...prev.slice(1),
        {
          time: 'Now',
          pid: currentRunning.pid,
          name: currentRunning.name,
          color: currentRunning.pid === 1 ? '#38bdf8' : currentRunning.pid === 3 ? '#10b981' : currentRunning.pid === 21 ? '#fbbf24' : '#a78bfa',
        }
      ]);
    }

    // Rotate ready queue
    const candidates = effectiveProcesses.filter(p => p.pid !== currentRunningPid).slice(0, 6);
    const readySet = new Set();
    if (candidates.length > 0) {
      const idx1 = Math.floor((Date.now() / 2000) % candidates.length);
      readySet.add(candidates[idx1].pid);
      if (candidates.length > 2) {
        readySet.add(candidates[(idx1 + 1) % candidates.length].pid);
      }
    }
    setSimulatedReadyPids(readySet);
  }, [effectiveProcesses, procStat]);

  // Group processes by lane
  const { runningProcs, readyProcs, blockedProcs } = useMemo(() => {
    const running = [];
    const ready = [];
    const blocked = [];
    const activeRunningPid = prevRunningPidRef.current;

    effectiveProcesses.forEach(proc => {
      if (proc.pid === activeRunningPid || (proc.state === 'R' && running.length === 0)) {
        running.push(proc);
      } else if (proc.state === 'R' || simulatedReadyPids.has(proc.pid)) {
        ready.push(proc);
      } else {
        blocked.push(proc);
      }
    });

    if (running.length === 0 && effectiveProcesses.length > 0) {
      if (ready.length > 0) running.push(ready.shift());
      else if (blocked.length > 0) running.push(blocked.shift());
    }

    return { runningProcs: running, readyProcs: ready, blockedProcs: blocked };
  }, [effectiveProcesses, simulatedReadyPids]);

  const selectedProcess = useMemo(() => {
    return effectiveProcesses.find(p => p.pid === selectedPid) || effectiveProcesses[0];
  }, [effectiveProcesses, selectedPid]);

  const handleBubbleClick = (proc) => {
    setSelectedPid(proc.pid);
    if (onProcessSelect) onProcessSelect(proc);
  };

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
      {/* Metrics Header */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: '10px',
        background: 'rgba(15, 23, 42, 0.85)',
        padding: '12px',
        borderRadius: '8px',
        border: '1px solid #334155',
      }}>
        <div>
          <div style={{ fontSize: '11px', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Context Switches (ctxt)
          </div>
          <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#38bdf8', marginTop: '2px' }}>
            {contextSwitches.toLocaleString()}
          </div>
          <div style={{ fontSize: '10px', color: '#64748b' }}>CPU hardware register state swaps</div>
        </div>
        <div>
          <div style={{ fontSize: '11px', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Run Queue Length (CFS)
          </div>
          <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#f59e0b', marginTop: '2px' }}>
            {readyProcs.length} <span style={{ fontSize: '12px', color: '#94a3b8', fontWeight: 'normal' }}>threads</span>
          </div>
          <div style={{ fontSize: '10px', color: '#64748b' }}>Runnable tasks waiting for CPU time</div>
        </div>
        <div>
          <div style={{ fontSize: '11px', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            CPU Utilization
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
            <div style={{
              flex: 1,
              height: '12px',
              backgroundColor: '#1e293b',
              borderRadius: '6px',
              overflow: 'hidden',
              border: '1px solid #475569',
            }}>
              <div style={{
                height: '100%',
                width: `${cpuUsage}%`,
                background: cpuUsage > 80 ? 'linear-gradient(90deg, #f59e0b, #ef4444)' : 'linear-gradient(90deg, #10b981, #38bdf8)',
                transition: 'width 300ms ease-out',
              }} />
            </div>
            <span style={{ fontSize: '13px', fontWeight: 'bold', minWidth: '40px' }}>{cpuUsage}%</span>
          </div>
          <div style={{ fontSize: '10px', color: '#64748b' }}>User + Kernel system execution time</div>
        </div>
      </div>

      {/* View Switcher Bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(15, 23, 42, 0.6)', padding: '6px 12px', borderRadius: '6px', border: '1px solid #334155' }}>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            onClick={() => setActiveView('LANES')}
            style={{
              backgroundColor: activeView === 'LANES' ? '#0284c7' : 'transparent',
              color: activeView === 'LANES' ? '#ffffff' : '#94a3b8',
              border: 'none',
              padding: '4px 10px',
              borderRadius: '4px',
              fontSize: '11px',
              fontWeight: '600',
              cursor: 'pointer',
            }}
          >
            Lanes State Map
          </button>
          <button
            onClick={() => setActiveView('GANTT')}
            style={{
              backgroundColor: activeView === 'GANTT' ? '#0284c7' : 'transparent',
              color: activeView === 'GANTT' ? '#ffffff' : '#94a3b8',
              border: 'none',
              padding: '4px 10px',
              borderRadius: '4px',
              fontSize: '11px',
              fontWeight: '600',
              cursor: 'pointer',
            }}
          >
            Process Gantt Timeline
          </button>
          <button
            onClick={() => setActiveView('TABLE')}
            style={{
              backgroundColor: activeView === 'TABLE' ? '#0284c7' : 'transparent',
              color: activeView === 'TABLE' ? '#ffffff' : '#94a3b8',
              border: 'none',
              padding: '4px 10px',
              borderRadius: '4px',
              fontSize: '11px',
              fontWeight: '600',
              cursor: 'pointer',
            }}
          >
            Process Catalog Table
          </button>
        </div>
        <span style={{ fontSize: '11px', color: '#64748b' }}>
          {effectiveProcesses.length} active kernel tasks
        </span>
      </div>

      {/* Main Visualization Panel */}
      <div style={{
        background: '#090d16',
        borderRadius: '8px',
        border: '1px solid #334155',
        position: 'relative',
        overflow: 'hidden',
        minHeight: '340px',
        padding: '12px',
      }}>
        {activeView === 'LANES' && (
          <svg viewBox="0 0 650 330" style={{ width: '100%', height: '330px', display: 'block' }}>
            {/* Lane Containers */}
            {Object.entries(LANE_CONFIG).map(([key, config]) => (
              <g key={key}>
                <rect
                  x="15"
                  y={config.y}
                  width="620"
                  height="80"
                  rx="6"
                  fill={config.bg}
                  stroke={config.border}
                  strokeWidth="1.5"
                  strokeDasharray={key === 'BLOCKED' ? '4 3' : 'none'}
                />
                <text x="25" y={config.y + 20} fill={config.color} fontSize="11" fontWeight="bold" letterSpacing="0.5">
                  {config.label}
                </text>
                <text x="25" y={config.y + 35} fill="#64748b" fontSize="8.5">
                  {config.desc}
                </text>
              </g>
            ))}

            {/* RUNNING lane process bubbles with visible Name labels */}
            {runningProcs.map((proc, idx) => {
              const x = 160 + idx * 110;
              const y = LANE_CONFIG.RUNNING.y + 44;
              const isSelected = selectedPid === proc.pid;
              return (
                <g
                  key={proc.pid}
                  onClick={() => handleBubbleClick(proc)}
                  style={{
                    cursor: 'pointer',
                    transform: `translate(${x}px, ${y}px)`,
                    transition: 'transform 300ms cubic-bezier(0.4, 0, 0.2, 1)',
                  }}
                >
                  <rect
                    x="-45"
                    y="-16"
                    width="90"
                    height="32"
                    rx="16"
                    fill={LANE_CONFIG.RUNNING.color}
                    stroke={isSelected ? '#ffffff' : '#047857'}
                    strokeWidth={isSelected ? '2.5' : '1'}
                  />
                  <text textAnchor="middle" dy="4" fill="#ffffff" fontSize="10" fontWeight="bold">
                    P{proc.pid}: {proc.name.substring(0, 7)}
                  </text>
                </g>
              );
            })}

            {/* READY lane process bubbles */}
            {readyProcs.map((proc, idx) => {
              const x = 160 + idx * 110;
              const y = LANE_CONFIG.READY.y + 44;
              const isSelected = selectedPid === proc.pid;
              return (
                <g
                  key={proc.pid}
                  onClick={() => handleBubbleClick(proc)}
                  style={{
                    cursor: 'pointer',
                    transform: `translate(${x}px, ${y}px)`,
                    transition: 'transform 300ms cubic-bezier(0.4, 0, 0.2, 1)',
                  }}
                >
                  <rect
                    x="-45"
                    y="-16"
                    width="90"
                    height="32"
                    rx="16"
                    fill={LANE_CONFIG.READY.color}
                    stroke={isSelected ? '#ffffff' : '#b45309'}
                    strokeWidth={isSelected ? '2.5' : '1'}
                  />
                  <text textAnchor="middle" dy="4" fill="#0f172a" fontSize="10" fontWeight="bold">
                    P{proc.pid}: {proc.name.substring(0, 7)}
                  </text>
                </g>
              );
            })}

            {/* BLOCKED lane process bubbles */}
            {blockedProcs.slice(0, 12).map((proc, idx) => {
              const col = idx % 6;
              const row = Math.floor(idx / 6);
              const x = 150 + col * 75;
              const y = LANE_CONFIG.BLOCKED.y + 24 + row * 28;
              const isSelected = selectedPid === proc.pid;
              return (
                <g
                  key={proc.pid}
                  onClick={() => handleBubbleClick(proc)}
                  style={{
                    cursor: 'pointer',
                    transform: `translate(${x}px, ${y}px)`,
                    transition: 'transform 300ms cubic-bezier(0.4, 0, 0.2, 1)',
                  }}
                >
                  <circle
                    r={isSelected ? '14' : '11'}
                    fill={LANE_CONFIG.BLOCKED.color}
                    stroke={isSelected ? '#ffffff' : '#334155'}
                    strokeWidth={isSelected ? '2' : '1'}
                  />
                  <text textAnchor="middle" dy="3.5" fill="#f8fafc" fontSize="8" fontWeight="600" fontFamily="monospace">
                    {proc.pid}
                  </text>
                  <text textAnchor="middle" dy="16" fill="#94a3b8" fontSize="7">
                    {proc.name.substring(0, 6)}
                  </text>
                </g>
              );
            })}
          </svg>
        )}

        {/* Process Gantt Chart Timeline */}
        {activeView === 'GANTT' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h4 style={{ margin: 0, fontSize: '13px', fontWeight: 'bold', color: '#f1f5f9' }}>
                CPU Execution Gantt Chart (Time Slices)
              </h4>
              <span style={{ fontSize: '11px', color: '#94a3b8' }}>
                Each block = process executing on the CPU core
              </span>
            </div>

            {/* Gantt Timeline SVG */}
            <div style={{ height: '140px', background: '#060911', borderRadius: '6px', padding: '10px', border: '1px solid #1e293b' }}>
              <svg viewBox="0 0 600 110" style={{ width: '100%', height: '100%' }}>
                {/* Time Axis Grid */}
                <line x1="40" y1="75" x2="570" y2="75" stroke="#334155" strokeWidth="1.5" />
                {ganttHistory.map((item, idx) => {
                  const x = 50 + idx * 32;
                  return (
                    <g key={idx}>
                      <line x1={x} y1="70" x2={x} y2="80" stroke="#475569" strokeWidth="1" />
                      {idx % 3 === 0 && (
                        <text x={x} y="95" fill="#64748b" fontSize="8" textAnchor="middle">
                          {item.time}
                        </text>
                      )}
                    </g>
                  );
                })}

                {/* Execution Bars */}
                {ganttHistory.map((item, idx) => {
                  const x = 40 + idx * 32;
                  return (
                    <g key={idx}>
                      <rect
                        x={x}
                        y="20"
                        width="28"
                        height="44"
                        rx="3"
                        fill={item.color}
                        opacity="0.85"
                        stroke="#0f172a"
                        strokeWidth="1"
                      />
                      <text x={x + 14} y="44" fill="#0f172a" fontSize="9" fontWeight="bold" textAnchor="middle">
                        P{item.pid}
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>

            <div style={{ fontSize: '11px', color: '#94a3b8', lineHeight: '1.5' }}>
              <strong>Linux CFS (Completely Fair Scheduler) Behavior:</strong><br />
              In a single-core system, threads take turns in round-robin quanta determined by their niceness/priority. Above, you see the active CPU slice switching between <code>init</code>, kernel interrupt handlers (<code>ksoftirqd</code>), and the user shell (<code>sh</code>).
            </div>
          </div>
        )}

        {/* Process Catalog Table */}
        {activeView === 'TABLE' && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: '11px', borderCollapse: 'collapse', textAlign: 'left' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #334155', color: '#94a3b8' }}>
                  <th style={{ padding: '6px' }}>PID</th>
                  <th style={{ padding: '6px' }}>Name</th>
                  <th style={{ padding: '6px' }}>State</th>
                  <th style={{ padding: '6px' }}>Priority</th>
                  <th style={{ padding: '6px' }}>Subsystem Purpose</th>
                </tr>
              </thead>
              <tbody>
                {effectiveProcesses.map(p => (
                  <tr
                    key={p.pid}
                    onClick={() => setSelectedPid(p.pid)}
                    style={{
                      borderBottom: '1px solid #1e293b',
                      backgroundColor: selectedPid === p.pid ? 'rgba(2, 132, 199, 0.2)' : 'transparent',
                      cursor: 'pointer',
                    }}
                  >
                    <td style={{ padding: '6px', fontFamily: 'monospace', color: '#38bdf8' }}>{p.pid}</td>
                    <td style={{ padding: '6px', fontWeight: 'bold', color: '#f1f5f9' }}>{p.name}</td>
                    <td style={{ padding: '6px' }}>
                      <span style={{
                        padding: '2px 6px',
                        borderRadius: '3px',
                        backgroundColor: p.state === 'R' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(100, 116, 139, 0.2)',
                        color: p.state === 'R' ? '#34d399' : '#94a3b8',
                      }}>
                        {p.state === 'R' ? 'R (Running)' : 'S (Sleeping)'}
                      </span>
                    </td>
                    <td style={{ padding: '6px', color: '#cbd5e1' }}>{p.priority}</td>
                    <td style={{ padding: '6px', color: '#94a3b8' }}>
                      {PROCESS_DESCRIPTIONS[p.name] || 'Linux kernel background task'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Selected Process Inspector Drawer */}
      <div style={{
        background: 'rgba(15, 23, 42, 0.95)',
        padding: '12px 16px',
        borderRadius: '8px',
        border: '1px solid #334155',
        fontSize: '12px',
      }}>
        {selectedProcess ? (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '14px', fontWeight: 'bold', color: '#38bdf8' }}>
                  {selectedProcess.name}
                </span>
                <span style={{ backgroundColor: '#1e293b', padding: '2px 6px', borderRadius: '4px', fontFamily: 'monospace', fontSize: '11px' }}>
                  PID {selectedProcess.pid}
                </span>
                <span style={{ color: selectedProcess.state === 'R' ? '#10b981' : '#f59e0b', fontWeight: '600' }}>
                  State: {selectedProcess.state} ({selectedProcess.state === 'R' ? 'Running' : 'Sleeping/Blocked'})
                </span>
              </div>
              <span style={{ fontSize: '11px', color: '#94a3b8' }}>Priority: {selectedProcess.priority}</span>
            </div>
            <div style={{ color: '#cbd5e1', fontSize: '11px', lineHeight: '1.4' }}>
              <strong>Subsystem Role: </strong>
              {PROCESS_DESCRIPTIONS[selectedProcess.name] || 'Active Linux kernel system task executing inside the v86 virtual machine.'}
            </div>
          </div>
        ) : (
          <div style={{ color: '#64748b', fontStyle: 'italic' }}>
            Click any process bubble or table row above to view full Linux subsystem details.
          </div>
        )}
      </div>
    </div>
  );
}
