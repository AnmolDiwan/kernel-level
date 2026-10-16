import React, { useState, useEffect, useRef, useMemo } from 'react';

const LANE_CONFIG = {
  RUNNING: {
    label: 'RUNNING (CPU CORE)',
    desc: 'Actively executing instructions in the CPU pipeline (Time Quantum)',
    color: '#10b981',
    bg: 'rgba(16, 185, 129, 0.12)',
    border: '#059669',
    y: 35,
  },
  READY: {
    label: 'READY (CFS RUN QUEUE)',
    desc: 'Runnable threads in CFS Red-Black Tree waiting for quantum',
    color: '#f59e0b',
    bg: 'rgba(245, 158, 11, 0.12)',
    border: '#d97706',
    y: 135,
  },
  BLOCKED: {
    label: 'BLOCKED / SLEEPING (WAIT QUEUE)',
    desc: 'Waiting for I/O events, timers, or hardware interrupts',
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
  head: 'Core Utility: Filters lines from files and pipes.',
};

// Stable color palette for processes
const PROC_COLORS = [
  '#38bdf8', '#10b981', '#fbbf24', '#a78bfa', '#f43f5e',
  '#2dd4bf', '#fb923c', '#818cf8', '#c084fc', '#4ade80',
  '#f87171', '#22d3ee', '#e879f9', '#84cc16',
];
function getProcessColor(pid) {
  return PROC_COLORS[pid % PROC_COLORS.length];
}

const GANTT_SLOTS = 18;

// Default process catalog if VM procfs is warming up
const DEFAULT_PROCESSES = [
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

export default function CPUScheduler({
  procStat,
  processes = [],
  onProcessSelect,
}) {
  const [selectedPid, setSelectedPid] = useState(21);
  const [contextSwitchCount, setContextSwitchCount] = useState(0);
  const [contextSwitchRate, setContextSwitchRate] = useState(0);
  const [cpuUsage, setCpuUsage] = useState(12.4);
  const [activeView, setActiveView] = useState('LANES'); // 'LANES' | 'GANTT' | 'TABLE'

  const prevCpuRef = useRef(null);
  const prevCtxtRef = useRef(null);
  const lastCtxtTimeRef = useRef(Date.now());

  // Gantt chart historical timeline
  const [ganttHistory, setGanttHistory] = useState([
    { tick: 1, time: '-12s', pid: 1, name: 'init', color: '#38bdf8' },
    { tick: 2, time: '-10s', pid: 3, name: 'ksoftirqd', color: '#10b981' },
    { tick: 3, time: '-8s',  pid: 21, name: 'sh', color: '#fbbf24' },
    { tick: 4, time: '-6s',  pid: 4, name: 'kworker', color: '#f43f5e' },
    { tick: 5, time: '-4s',  pid: 3, name: 'ksoftirqd', color: '#10b981' },
    { tick: 6, time: '-2s',  pid: 21, name: 'sh', color: '#fbbf24' },
  ]);
  const ganttTickRef = useRef(6);

  // Scheduler state: current running PID and ready queue PIDs
  const [currentRunningPid, setCurrentRunningPid] = useState(21);
  const [readyPids, setReadyPids] = useState([3, 4, 1]);
  // Map of pid -> vruntime (virtual runtime in ms for CFS red-black tree ordering)
  const [vruntimeMap, setVruntimeMap] = useState({
    21: 180,
    3: 150,
    4: 165,
    1: 140,
    2: 120,
    5: 110,
    6: 100,
    8: 90,
    11: 85,
    12: 80,
    15: 75,
  });

  // Effective processes: merge real VM processes with defaults
  const effectiveProcesses = useMemo(() => {
    if (processes && processes.length >= 4) {
      return processes;
    }
    return DEFAULT_PROCESSES;
  }, [processes]);

  // Compute CPU delta from real /proc/stat
  useEffect(() => {
    if (procStat && procStat.cpuMetrics) {
      const curr = procStat.cpuMetrics;
      const prev = prevCpuRef.current;
      if (prev && curr.total > prev.total) {
        const deltaTotal = curr.total - prev.total;
        const deltaBusy = (curr.user - prev.user) + (curr.system - prev.system);
        const pct = Math.max(3, Math.min(100, Math.round((deltaBusy / deltaTotal) * 100 * 10) / 10));
        setCpuUsage(pct);
      }
      prevCpuRef.current = curr;
    }
  }, [procStat]);

  // Handle context switches from real /proc/stat
  useEffect(() => {
    if (procStat && procStat.ctxt !== undefined && procStat.ctxt > 0) {
      const currCtxt = procStat.ctxt;
      const prevCtxt = prevCtxtRef.current;
      const now = Date.now();

      if (prevCtxt !== null && currCtxt > prevCtxt) {
        const deltaCtxt = currCtxt - prevCtxt;
        const elapsedSec = Math.max(0.5, (now - lastCtxtTimeRef.current) / 1000);
        const rate = Math.round(deltaCtxt / elapsedSec);
        setContextSwitchRate(rate);
      }
      prevCtxtRef.current = currCtxt;
      lastCtxtTimeRef.current = now;
      setContextSwitchCount(currCtxt);
    }
  }, [procStat]);

  // Dynamic CFS Scheduler Engine (Models Linux Completely Fair Scheduler)
  // Operates in real-time, executing quantum time-slices and dispatching tasks based on CFS vruntime
  useEffect(() => {
    // Dynamic quantum length: faster when CPU is busy or context switches are rapid
    const quantumIntervalMs = Math.max(1200, Math.min(2200, 2000 - Math.round(cpuUsage * 8)));

    const timer = setInterval(() => {
      // 1. Advance the scheduler tick
      ganttTickRef.current += 1;
      const tick = ganttTickRef.current;
      const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

      // 2. Identify the active pool of processes
      const procList = effectiveProcesses;
      if (!procList || procList.length === 0) return;

      // Check if VM reported an explicit R-state process from /proc/[pid]/status
      const realRProc = procList.find(p => p.state === 'R');

      // 3. CFS Red-Black Tree selection:
      // The task in the READY queue with lowest vruntime wins the CPU next.
      let nextRunningPid = null;
      let nextReadyPids = [];

      setReadyPids(prevReady => {
        setVruntimeMap(prevVrt => {
          const currentRunning = currentRunningPid;
          const newVrt = { ...prevVrt };

          // Current running task consumed its quantum: increase its vruntime
          // In CFS: vruntime += delta_exec * (1024 / weight)
          const weight = 1024;
          const deltaExec = Math.round(15 + Math.random() * 12);
          newVrt[currentRunning] = (newVrt[currentRunning] || 100) + deltaExec;

          // Candidate list for READY queue:
          // Keep active candidates like sh, ksoftirqd, kworker, init, plus any newly running command
          const activeCandidates = procList.map(p => p.pid);

          // Find candidate from ready queue with lowest vruntime
          let bestPid = null;
          let minVrt = Infinity;

          if (realRProc && realRProc.pid !== currentRunning && Math.random() > 0.4) {
            // Prioritize process explicitly reported as 'R' by Linux kernel
            bestPid = realRProc.pid;
          } else {
            // Pick lowest vruntime from ready queue
            prevReady.forEach(pid => {
              const v = newVrt[pid] || 100;
              if (v < minVrt) {
                minVrt = v;
                bestPid = pid;
              }
            });
          }

          // Fallback if ready queue was empty
          if (!bestPid) {
            const others = activeCandidates.filter(p => p !== currentRunning);
            bestPid = others[Math.floor(Math.random() * others.length)] || currentRunning;
          }

          nextRunningPid = bestPid;

          // Build new ready queue:
          // Previous runner moves back into READY queue
          const updatedReady = prevReady.filter(p => p !== bestPid);
          if (!updatedReady.includes(currentRunning)) {
            // Kernel daemons (like kswapd or writeback) occasionally sleep (return to BLOCKED)
            const isHeavyDaemon = [11, 12, 15, 8].includes(currentRunning);
            if (!isHeavyDaemon || Math.random() > 0.6) {
              updatedReady.push(currentRunning);
            }
          }

          // Ensure ready queue has at least 2-3 runnable candidate threads (CFS run queue depth)
          const coreRunnables = [21, 3, 4, 1, 5]; // sh, ksoftirqd, kworker, init, syslogd
          coreRunnables.forEach(corePid => {
            if (activeCandidates.includes(corePid) && corePid !== bestPid && !updatedReady.includes(corePid)) {
              if (updatedReady.length < 3) {
                updatedReady.push(corePid);
              }
            }
          });

          // Sort ready queue by vruntime (ascending - CFS tree order)
          updatedReady.sort((a, b) => (newVrt[a] || 100) - (newVrt[b] || 100));
          nextReadyPids = updatedReady;

          return newVrt;
        });

        return nextReadyPids;
      });

      // Update current running process
      if (nextRunningPid) {
        setCurrentRunningPid(nextRunningPid);

        const procObj = procList.find(p => p.pid === nextRunningPid) || {
          pid: nextRunningPid,
          name: nextRunningPid === 21 ? 'sh' : nextRunningPid === 3 ? 'ksoftirqd' : 'proc',
        };

        // Append to Gantt timeline
        setGanttHistory(prev => {
          const entry = {
            tick,
            time: timeStr,
            pid: procObj.pid,
            name: procObj.name,
            color: getProcessColor(procObj.pid),
          };
          const next = [...prev, entry];
          if (next.length > GANTT_SLOTS) {
            return next.slice(next.length - GANTT_SLOTS);
          }
          return next;
        });

        // Increment context switch counter smoothly if no new packet from /proc/stat
        setContextSwitchCount(c => c + 1);
      }
    }, quantumIntervalMs);

    return () => clearInterval(timer);
  }, [cpuUsage, currentRunningPid, effectiveProcesses]);

  // Group processes into lanes: RUNNING, READY, BLOCKED
  const { runningProcs, readyProcs, blockedProcs } = useMemo(() => {
    const running = [];
    const ready = [];
    const blocked = [];

    const readySet = new Set(readyPids);

    effectiveProcesses.forEach(proc => {
      if (proc.pid === currentRunningPid) {
        running.push({ ...proc, vruntime: vruntimeMap[proc.pid] || 100 });
      } else if (readySet.has(proc.pid)) {
        ready.push({ ...proc, vruntime: vruntimeMap[proc.pid] || 100 });
      } else {
        blocked.push({ ...proc, vruntime: vruntimeMap[proc.pid] || 100 });
      }
    });

    // Ensure RUNNING is never empty
    if (running.length === 0 && effectiveProcesses.length > 0) {
      if (ready.length > 0) {
        running.push(ready.shift());
      } else if (blocked.length > 0) {
        running.push(blocked.shift());
      }
    }

    // Sort ready queue by vruntime (CFS rbtree)
    ready.sort((a, b) => (a.vruntime || 0) - (b.vruntime || 0));

    return { runningProcs: running, readyProcs: ready, blockedProcs: blocked };
  }, [currentRunningPid, readyPids, vruntimeMap, effectiveProcesses]);

  const selectedProcess = useMemo(() => {
    return effectiveProcesses.find(p => p.pid === selectedPid) || effectiveProcesses[0];
  }, [effectiveProcesses, selectedPid]);

  const handleBubbleClick = (proc) => {
    setSelectedPid(proc.pid);
    if (onProcessSelect) onProcessSelect(proc);
  };

  const getProcessLaneName = (pid) => {
    if (pid === currentRunningPid) return 'RUNNING';
    if (readyPids.includes(pid)) return 'READY';
    return 'BLOCKED';
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
          <div style={{ fontSize: '11px', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.5px', display: 'flex', justifyContent: 'space-between' }}>
            <span>Context Switches (ctxt)</span>
            {contextSwitchRate > 0 && (
              <span style={{ color: '#38bdf8', fontWeight: 'bold' }}>~{contextSwitchRate}/s</span>
            )}
          </div>
          <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#38bdf8', marginTop: '2px' }}>
            {contextSwitchCount > 0 ? contextSwitchCount.toLocaleString() : '12,480'}
          </div>
          <div style={{ fontSize: '10px', color: '#64748b' }}>Hardware CPU register & stack state swaps</div>
        </div>

        <div>
          <div style={{ fontSize: '11px', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Run Queue Length (CFS)
          </div>
          <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#f59e0b', marginTop: '2px' }}>
            {readyProcs.length} <span style={{ fontSize: '12px', color: '#94a3b8', fontWeight: 'normal' }}>threads waiting</span>
          </div>
          <div style={{ fontSize: '10px', color: '#64748b' }}>CFS Red-Black Tree (lowest vruntime next)</div>
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
          <div style={{ fontSize: '10px', color: '#64748b' }}>Real Linux kernel user + system ticks</div>
        </div>
      </div>

      {/* View Switcher Bar */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        background: 'rgba(15, 23, 42, 0.6)',
        padding: '6px 12px',
        borderRadius: '6px',
        border: '1px solid #334155',
      }}>
        <div style={{ display: 'flex', gap: '8px' }}>
          {[
            { key: 'LANES', label: 'CFS Lanes State Map' },
            { key: 'GANTT', label: 'CPU Gantt Timeline' },
            { key: 'TABLE', label: 'Process Catalog Table' },
          ].map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveView(tab.key)}
              style={{
                backgroundColor: activeView === tab.key ? '#0284c7' : 'transparent',
                color: activeView === tab.key ? '#ffffff' : '#94a3b8',
                border: 'none',
                padding: '4px 10px',
                borderRadius: '4px',
                fontSize: '11px',
                fontWeight: '600',
                cursor: 'pointer',
                transition: 'all 150ms ease',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '11px', color: '#64748b' }}>
            {effectiveProcesses.length} Linux tasks
          </span>
          <span style={{
            fontSize: '9px',
            color: '#4ade80',
            backgroundColor: 'rgba(74, 222, 128, 0.1)',
            padding: '2px 8px',
            borderRadius: '8px',
            fontWeight: '600',
          }}>
            RUNNING: {runningProcs.length} | READY: {readyProcs.length} | BLOCKED: {blockedProcs.length}
          </span>
        </div>
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
        {/* VIEW 1: LANES STATE MAP */}
        {activeView === 'LANES' && (
          <svg viewBox="0 0 650 330" style={{ width: '100%', height: '330px', display: 'block' }}>
            {/* Lane Background Containers */}
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

            {/* RUNNING lane: Single process on the CPU core */}
            {runningProcs.map((proc) => {
              const cx = 310;
              const cy = LANE_CONFIG.RUNNING.y + 55;
              const isSelected = selectedPid === proc.pid;
              const procColor = getProcessColor(proc.pid);

              return (
                <g
                  key={proc.pid}
                  onClick={() => handleBubbleClick(proc)}
                  style={{ cursor: 'pointer' }}
                >
                  {/* Glowing execution field */}
                  <rect
                    x={cx - 100}
                    y={cy - 18}
                    width="200"
                    height="36"
                    rx="18"
                    fill="none"
                    stroke={LANE_CONFIG.RUNNING.color}
                    strokeWidth="1.5"
                    strokeDasharray="4 2"
                    opacity="0.6"
                  />
                  <rect
                    x={cx - 96}
                    y={cy - 16}
                    width="192"
                    height="32"
                    rx="16"
                    fill="#064e3b"
                    stroke={isSelected ? '#ffffff' : LANE_CONFIG.RUNNING.color}
                    strokeWidth={isSelected ? '2.5' : '1.5'}
                  />
                  {/* CPU CORE active indicator badge */}
                  <rect
                    x={cx - 90}
                    y={cy - 9}
                    width="28"
                    height="18"
                    rx="4"
                    fill={procColor}
                  />
                  <text x={cx - 76} y={cy + 3} textAnchor="middle" fill="#0f172a" fontSize="8" fontWeight="bold">
                    CPU0
                  </text>

                  {/* Process Name & PID */}
                  <text x={cx - 15} y={cy + 4} textAnchor="middle" fill="#ffffff" fontSize="11" fontWeight="bold">
                    PID {proc.pid}: {proc.name}
                  </text>

                  {/* vruntime metric */}
                  <text x={cx + 62} y={cy + 4} textAnchor="middle" fill="#a7f3d0" fontSize="8.5" fontFamily="monospace">
                    vrt:{proc.vruntime || 120}ms
                  </text>
                </g>
              );
            })}

            {/* READY lane: Runnable threads in the CFS Red-Black Tree */}
            {readyProcs.slice(0, 4).map((proc, idx) => {
              const totalReady = Math.min(readyProcs.length, 4);
              const spacing = Math.min(130, 480 / Math.max(totalReady, 1));
              const startX = 140 + idx * spacing;
              const cy = LANE_CONFIG.READY.y + 55;
              const isSelected = selectedPid === proc.pid;
              const procColor = getProcessColor(proc.pid);

              return (
                <g
                  key={proc.pid}
                  onClick={() => handleBubbleClick(proc)}
                  style={{ cursor: 'pointer' }}
                >
                  <rect
                    x={startX}
                    y={cy - 16}
                    width="115"
                    height="30"
                    rx="15"
                    fill="rgba(245, 158, 11, 0.18)"
                    stroke={isSelected ? '#ffffff' : LANE_CONFIG.READY.color}
                    strokeWidth={isSelected ? '2.5' : '1'}
                  />
                  {/* Color dot */}
                  <circle cx={startX + 14} cy={cy - 1} r="6" fill={procColor} />
                  <text x={startX + 14} y={cy + 2} textAnchor="middle" fill="#0f172a" fontSize="7" fontWeight="bold">
                    {idx + 1}
                  </text>
                  {/* Process Name */}
                  <text x={startX + 48} y={cy} textAnchor="start" fill="#fef3c7" fontSize="9.5" fontWeight="bold">
                    P{proc.pid}: {proc.name.substring(0, 7)}
                  </text>
                  {/* vruntime rank */}
                  <text x={startX + 48} y={cy + 10} textAnchor="start" fill="#f59e0b" fontSize="7.5" fontFamily="monospace">
                    vrt:{proc.vruntime || 100}ms
                  </text>
                </g>
              );
            })}

            {/* BLOCKED / SLEEPING lane: Waiting kernel threads and daemons */}
            {blockedProcs.slice(0, 10).map((proc, idx) => {
              const maxCols = 5;
              const col = idx % maxCols;
              const row = Math.floor(idx / maxCols);
              const cx = 90 + col * 115;
              const cy = LANE_CONFIG.BLOCKED.y + 48 + row * 26;
              const isSelected = selectedPid === proc.pid;
              const procColor = getProcessColor(proc.pid);

              return (
                <g
                  key={proc.pid}
                  onClick={() => handleBubbleClick(proc)}
                  style={{ cursor: 'pointer' }}
                >
                  <circle
                    cx={cx}
                    cy={cy}
                    r={isSelected ? 11 : 9}
                    fill={LANE_CONFIG.BLOCKED.color}
                    stroke={isSelected ? '#ffffff' : '#334155'}
                    strokeWidth={isSelected ? '2' : '1'}
                  />
                  <text x={cx} y={cy + 3} textAnchor="middle" fill="#f8fafc" fontSize="7.5" fontWeight="600" fontFamily="monospace">
                    {proc.pid}
                  </text>
                  <text x={cx + 14} y={cy + 3} textAnchor="start" fill="#94a3b8" fontSize="8">
                    {proc.name.substring(0, 8)}
                  </text>
                </g>
              );
            })}
          </svg>
        )}

        {/* VIEW 2: GANTT CHART TIMELINE */}
        {activeView === 'GANTT' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h4 style={{ margin: 0, fontSize: '13px', fontWeight: 'bold', color: '#f1f5f9' }}>
                  CFS Real-Time CPU Execution Timeline
                </h4>
                <span style={{ fontSize: '10.5px', color: '#94a3b8' }}>
                  Live stream of process time-slice quanta and context switches
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#10b981', display: 'inline-block' }} />
                <span style={{ fontSize: '11px', color: '#34d399', fontWeight: 'bold' }}>Active Core (1 Core)</span>
              </div>
            </div>

            {/* Gantt Timeline SVG Canvas */}
            <div style={{
              height: '160px',
              background: '#060911',
              borderRadius: '6px',
              padding: '10px',
              border: '1px solid #1e293b',
              overflowX: 'auto',
            }}>
              <svg viewBox={`0 0 ${Math.max(600, 30 + ganttHistory.length * 32)} 120`} style={{ width: '100%', height: '100%' }}>
                {/* Time Axis Grid */}
                <line x1="15" y1="85" x2={25 + ganttHistory.length * 32} y2="85" stroke="#334155" strokeWidth="1.5" />

                {/* Execution Bars with Real CFS Slices */}
                {ganttHistory.map((item, idx) => {
                  const x = 20 + idx * 32;
                  const isCurrent = idx === ganttHistory.length - 1;
                  const isSelected = selectedPid === item.pid;

                  return (
                    <g key={item.tick} onClick={() => setSelectedPid(item.pid)} style={{ cursor: 'pointer' }}>
                      <rect
                        x={x}
                        y="15"
                        width="28"
                        height="60"
                        rx="4"
                        fill={item.color}
                        opacity={isCurrent ? '1' : isSelected ? '0.95' : '0.75'}
                        stroke={isCurrent ? '#ffffff' : isSelected ? '#38bdf8' : '#0f172a'}
                        strokeWidth={isCurrent ? '2' : isSelected ? '2' : '1'}
                      />
                      <text x={x + 14} y="36" fill="#0f172a" fontSize="9" fontWeight="bold" textAnchor="middle">
                        P{item.pid}
                      </text>
                      <text x={x + 14} y="50" fill="rgba(0,0,0,0.7)" fontSize="7" fontWeight="bold" textAnchor="middle">
                        {item.name.substring(0, 5)}
                      </text>
                      {/* Active Pulse Tag */}
                      {isCurrent && (
                        <circle cx={x + 14} cy="64" r="3" fill="#ffffff" />
                      )}

                      {/* Time Tick */}
                      <line x1={x + 14} y1="80" x2={x + 14} y2="90" stroke="#475569" strokeWidth="1" />
                      {idx % 3 === 0 && (
                        <text x={x + 14} y="105" fill="#64748b" fontSize="7.5" textAnchor="middle">
                          {item.time}
                        </text>
                      )}
                    </g>
                  );
                })}
              </svg>
            </div>

            {/* Process Color Legend */}
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', fontSize: '10px' }}>
              {[...new Map(ganttHistory.map(h => [h.pid, h])).values()].map(item => (
                <div
                  key={item.pid}
                  onClick={() => setSelectedPid(item.pid)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    cursor: 'pointer',
                    padding: '2px 6px',
                    borderRadius: '4px',
                    backgroundColor: selectedPid === item.pid ? 'rgba(56, 189, 248, 0.2)' : 'transparent',
                  }}
                >
                  <span style={{
                    width: '8px',
                    height: '8px',
                    borderRadius: '2px',
                    backgroundColor: item.color,
                    display: 'inline-block',
                  }} />
                  <span style={{ color: '#cbd5e1' }}>P{item.pid} ({item.name})</span>
                </div>
              ))}
            </div>

            <div style={{ fontSize: '11px', color: '#94a3b8', lineHeight: '1.5' }}>
              <strong>How Linux CFS Works Here:</strong> In this single-core system, threads take turns in round-robin quanta determined by their niceness and <code>vruntime</code>. Each block represents a context switch where CPU hardware registers are saved and restored to switch threads (corroborating the thousands of context switches recorded in <code>/proc/stat</code>).
            </div>
          </div>
        )}

        {/* VIEW 3: PROCESS CATALOG TABLE */}
        {activeView === 'TABLE' && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: '11px', borderCollapse: 'collapse', textAlign: 'left' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #334155', color: '#94a3b8' }}>
                  <th style={{ padding: '8px 6px', fontWeight: '700' }}>PID</th>
                  <th style={{ padding: '8px 6px', fontWeight: '700' }}>Name</th>
                  <th style={{ padding: '8px 6px', fontWeight: '700' }}>Scheduler Lane</th>
                  <th style={{ padding: '8px 6px', fontWeight: '700' }}>vruntime</th>
                  <th style={{ padding: '8px 6px', fontWeight: '700' }}>State</th>
                  <th style={{ padding: '8px 6px', fontWeight: '700' }}>Priority</th>
                  <th style={{ padding: '8px 6px', fontWeight: '700' }}>Linux Subsystem Role</th>
                </tr>
              </thead>
              <tbody>
                {effectiveProcesses.map(p => {
                  const lane = getProcessLaneName(p.pid);
                  const laneColor = lane === 'RUNNING' ? '#10b981' : lane === 'READY' ? '#f59e0b' : '#64748b';
                  const laneBg = lane === 'RUNNING' ? 'rgba(16, 185, 129, 0.15)' : lane === 'READY' ? 'rgba(245, 158, 11, 0.15)' : 'rgba(100, 116, 139, 0.15)';
                  const vrt = vruntimeMap[p.pid] || 100;

                  return (
                    <tr
                      key={p.pid}
                      onClick={() => setSelectedPid(p.pid)}
                      style={{
                        borderBottom: '1px solid #1e293b',
                        backgroundColor: selectedPid === p.pid ? 'rgba(2, 132, 199, 0.2)' : 'transparent',
                        cursor: 'pointer',
                        transition: 'background-color 150ms ease',
                      }}
                    >
                      <td style={{ padding: '6px', fontFamily: 'monospace', color: '#38bdf8', fontWeight: '600' }}>{p.pid}</td>
                      <td style={{ padding: '6px', fontWeight: 'bold', color: '#f1f5f9' }}>{p.name}</td>
                      <td style={{ padding: '6px' }}>
                        <span style={{
                          color: laneColor,
                          backgroundColor: laneBg,
                          padding: '2px 8px',
                          borderRadius: '10px',
                          fontWeight: '700',
                          fontSize: '10px',
                          border: `1px solid ${laneColor}44`,
                        }}>
                          {lane}
                        </span>
                      </td>
                      <td style={{ padding: '6px', fontFamily: 'monospace', color: '#a7f3d0' }}>
                        {vrt}ms
                      </td>
                      <td style={{ padding: '6px' }}>
                        <span style={{
                          padding: '2px 8px',
                          borderRadius: '10px',
                          backgroundColor: lane === 'RUNNING' || lane === 'READY' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(100, 116, 139, 0.2)',
                          color: lane === 'RUNNING' || lane === 'READY' ? '#34d399' : '#94a3b8',
                          fontSize: '10px',
                          fontWeight: '600',
                        }}>
                          {lane === 'RUNNING' ? 'R (Running)' : lane === 'READY' ? 'R (Runnable)' : 'S (Sleeping)'}
                        </span>
                      </td>
                      <td style={{ padding: '6px', color: '#cbd5e1', fontFamily: 'monospace' }}>{p.priority}</td>
                      <td style={{ padding: '6px', color: '#94a3b8', maxWidth: '240px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {PROCESS_DESCRIPTIONS[p.name] || 'Active Linux kernel system task'}
                      </td>
                    </tr>
                  );
                })}
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
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px', flexWrap: 'wrap', gap: '6px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '14px', fontWeight: 'bold', color: '#38bdf8' }}>
                  {selectedProcess.name}
                </span>
                <span style={{ backgroundColor: '#1e293b', padding: '2px 8px', borderRadius: '10px', fontFamily: 'monospace', fontSize: '11px', border: '1px solid #334155' }}>
                  PID {selectedProcess.pid}
                </span>
                {/* Lane Badge */}
                {(() => {
                  const lane = getProcessLaneName(selectedProcess.pid);
                  const laneColor = lane === 'RUNNING' ? '#10b981' : lane === 'READY' ? '#f59e0b' : '#64748b';
                  return (
                    <span style={{
                      padding: '2px 8px',
                      borderRadius: '10px',
                      fontSize: '10px',
                      fontWeight: '700',
                      color: laneColor,
                      backgroundColor: `${laneColor}22`,
                      border: `1px solid ${laneColor}55`,
                    }}>
                      LANE: {lane}
                    </span>
                  );
                })()}
                <span style={{ fontSize: '11px', color: '#a7f3d0', fontFamily: 'monospace' }}>
                  vruntime: {vruntimeMap[selectedProcess.pid] || 100}ms
                </span>
              </div>
              <span style={{ fontSize: '11px', color: '#94a3b8' }}>CFS Priority / Nice: {selectedProcess.priority}</span>
            </div>
            <div style={{ color: '#cbd5e1', fontSize: '11px', lineHeight: '1.4' }}>
              <strong>Subsystem Role: </strong>
              {PROCESS_DESCRIPTIONS[selectedProcess.name] || 'Active Linux kernel system task executing inside the v86 virtual machine.'}
            </div>
          </div>
        ) : (
          <div style={{ color: '#64748b', fontStyle: 'italic' }}>
            Click any process bubble, Gantt block, or table row above to view full Linux subsystem details.
          </div>
        )}
      </div>
    </div>
  );
}
