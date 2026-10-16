import React, { useState, useEffect, useRef, useCallback } from 'react';
import { LINE_TYPES } from '@/lib/serialMultiplexer';
import { useKernelData } from '@/context/KernelDataContext';

const SPEED_PRESETS = {
  REALTIME: { label: 'Real-time', ms: 0, desc: 'No throttle' },
  NORMAL:   { label: 'Normal',    ms: 300, desc: '300ms batch' },
  SLOW:     { label: 'Slow',      ms: 1000, desc: '1s batch' },
  FROZEN:   { label: 'Frozen',    ms: Infinity, desc: 'Paused' },
};

export default function SerialParser({ multiplexer }) {
  const [displayedLogs, setDisplayedLogs] = useState([]);
  const [filter, setFilter] = useState('ALL');
  const [customCmd, setCustomCmd] = useState('');
  const [speed, setSpeed] = useState('NORMAL');
  const [isPaused, setIsPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [cmdHighlightUntil, setCmdHighlightUntil] = useState(0);
  const [stats, setStats] = useState({
    memLines: 0,
    vmLines: 0,
    procLines: 0,
    kernelLines: 0,
    totalLines: 0,
  });

  // Pending buffer for throttled/paused mode
  const pendingRef = useRef([]);
  const flushTimerRef = useRef(null);
  const logBoxRef = useRef(null);
  const { sendCommand } = useKernelData();

  // Flush pending lines into displayedLogs
  const flushPending = useCallback(() => {
    if (pendingRef.current.length === 0) return;
    const batch = [...pendingRef.current];
    pendingRef.current = [];
    setDisplayedLogs(prev => [...prev, ...batch].slice(-400));
  }, []);

  // Schedule flush based on speed
  const scheduleFlush = useCallback(() => {
    const preset = SPEED_PRESETS[speed];
    if (!preset || preset.ms === Infinity) return; // Frozen/paused — don't flush

    if (preset.ms === 0) {
      // Real-time: flush immediately
      flushPending();
      return;
    }

    // Throttled: schedule a flush if not already scheduled
    if (!flushTimerRef.current) {
      flushTimerRef.current = setTimeout(() => {
        flushTimerRef.current = null;
        flushPending();
      }, preset.ms);
    }
  }, [speed, flushPending]);

  // When unpausing, flush any buffered lines
  useEffect(() => {
    if (!isPaused && speed !== 'FROZEN') {
      flushPending();
    }
  }, [isPaused, speed, flushPending]);

  // Subscribe to multiplexer
  useEffect(() => {
    if (!multiplexer) return;

    // Load initial history
    if (typeof multiplexer.getHistory === 'function') {
      const history = multiplexer.getHistory();
      if (history && history.length > 0) {
        const initialLogs = history.map(item => ({
          id: item.id,
          tag: getTagFromType(item.type),
          type: item.type,
          text: item.line,
          color: getColorFromType(item.type),
          time: item.time,
        }));
        setDisplayedLogs(initialLogs);

        let mem = 0, vm = 0, proc = 0, kern = 0;
        history.forEach(h => {
          if (h.type === LINE_TYPES.MEMORY_LINE) mem++;
          else if (h.type === LINE_TYPES.VMSTAT_LINE) vm++;
          else if (h.type === LINE_TYPES.PROCSTAT_LINE || h.type === LINE_TYPES.PROC_STATUS_LINE) proc++;
          else kern++;
        });
        setStats({ memLines: mem, vmLines: vm, procLines: proc, kernelLines: kern, totalLines: history.length });
      }
    }

    const unsubscribe = multiplexer.subscribeAll((line, lineType, historyItem) => {
      const entry = {
        id: historyItem?.id || (Date.now() + Math.random()),
        tag: getTagFromType(lineType),
        type: lineType,
        text: line,
        color: getColorFromType(lineType),
        time: historyItem?.time || new Date().toLocaleTimeString(),
      };

      setStats(prev => ({
        ...prev,
        totalLines: prev.totalLines + 1,
        memLines: lineType === LINE_TYPES.MEMORY_LINE ? prev.memLines + 1 : prev.memLines,
        vmLines: lineType === LINE_TYPES.VMSTAT_LINE ? prev.vmLines + 1 : prev.vmLines,
        procLines: (lineType === LINE_TYPES.PROCSTAT_LINE || lineType === LINE_TYPES.PROC_STATUS_LINE) ? prev.procLines + 1 : prev.procLines,
        kernelLines: lineType === LINE_TYPES.KERNEL_LOG ? prev.kernelLines + 1 : prev.kernelLines,
      }));

      // Add to pending buffer
      pendingRef.current.push(entry);
    });

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [multiplexer]);

  // Whenever pending buffer changes (via subscription), schedule a flush
  useEffect(() => {
    if (isPaused || speed === 'FROZEN') return;

    const checkInterval = setInterval(() => {
      if (pendingRef.current.length > 0) {
        scheduleFlush();
      }
    }, 100);

    return () => clearInterval(checkInterval);
  }, [isPaused, speed, scheduleFlush]);

  // Cleanup flush timer on unmount
  useEffect(() => {
    return () => {
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
      }
    };
  }, []);

  function getTagFromType(type) {
    switch (type) {
      case LINE_TYPES.MEMORY_LINE: return 'MEM';
      case LINE_TYPES.VMSTAT_LINE: return 'VMSTAT';
      case LINE_TYPES.PROCSTAT_LINE: return 'PROC';
      case LINE_TYPES.PROC_STATUS_LINE: return 'STATUS';
      default: return 'KERNEL';
    }
  }

  function getColorFromType(type) {
    switch (type) {
      case LINE_TYPES.MEMORY_LINE: return '#38bdf8';
      case LINE_TYPES.VMSTAT_LINE: return '#c084fc';
      case LINE_TYPES.PROCSTAT_LINE: return '#4ade80';
      case LINE_TYPES.PROC_STATUS_LINE: return '#fbbf24';
      default: return '#94a3b8';
    }
  }

  // Auto-scroll effect
  useEffect(() => {
    if (autoScroll && !isPaused && logBoxRef.current) {
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
    }
  }, [displayedLogs, autoScroll, isPaused]);

  // Detect manual scroll-up to auto-disable auto-scroll
  const handleScroll = useCallback(() => {
    if (!logBoxRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logBoxRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 40;
    if (!isAtBottom && autoScroll) {
      setAutoScroll(false);
    }
  }, [autoScroll]);

  const handleTogglePause = () => {
    if (isPaused) {
      // Unpause: flush everything that was buffered
      setIsPaused(false);
      setSpeed(prev => prev === 'FROZEN' ? 'NORMAL' : prev);
      flushPending();
    } else {
      setIsPaused(true);
      setSpeed('FROZEN');
    }
  };

  const handleSpeedChange = (newSpeed) => {
    setSpeed(newSpeed);
    if (newSpeed === 'FROZEN') {
      setIsPaused(true);
    } else {
      setIsPaused(false);
      // Flush immediately when switching to a faster speed
      flushPending();
    }
  };

  const handleSendCustomCmd = (e) => {
    e.preventDefault();
    if (!customCmd.trim()) return;
    const cmd = customCmd.trim() + '\n';
    if (sendCommand) {
      sendCommand(cmd);
    }
    // Highlight output for next 4 seconds
    setCmdHighlightUntil(Date.now() + 4000);
    // Add a visual marker line
    const marker = {
      id: Date.now() + Math.random(),
      tag: '▶ CMD',
      type: 'COMMAND',
      text: `$ ${customCmd.trim()}`,
      color: '#22d3ee',
      time: new Date().toLocaleTimeString(),
      isCommand: true,
    };
    setDisplayedLogs(prev => [...prev, marker].slice(-400));
    setCustomCmd('');
  };

  const filteredLogs = displayedLogs.filter(item => {
    if (filter === 'ALL') return true;
    if (filter === 'MEM') return item.type === LINE_TYPES.MEMORY_LINE;
    if (filter === 'VMSTAT') return item.type === LINE_TYPES.VMSTAT_LINE;
    if (filter === 'PROC') return item.type === LINE_TYPES.PROCSTAT_LINE || item.type === LINE_TYPES.PROC_STATUS_LINE;
    if (filter === 'KERNEL') return item.type === LINE_TYPES.KERNEL_LOG;
    if (filter === 'CMD') return item.isCommand;
    return true;
  });

  const pendingCount = pendingRef.current.length;

  const filterCounts = {
    ALL: stats.totalLines,
    MEM: stats.memLines,
    VMSTAT: stats.vmLines,
    PROC: stats.procLines,
    KERNEL: stats.kernelLines,
  };

  return (
    <div style={{
      background: 'rgba(15, 23, 42, 0.95)',
      borderRadius: '8px',
      border: '1px solid #334155',
      padding: '10px 12px',
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      fontFamily: 'monospace',
    }}>
      {/* Top Header & Controls */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px', flexWrap: 'wrap', gap: '6px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '13px', fontWeight: 'bold', color: '#f1f5f9' }}>Serial Stream Monitor</span>
          <span style={{
            fontSize: '10px',
            color: isPaused ? '#f87171' : '#4ade80',
            fontWeight: '600',
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
          }}>
            <span style={{
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              backgroundColor: isPaused ? '#f87171' : '#4ade80',
              display: 'inline-block',
              boxShadow: `0 0 6px ${isPaused ? '#f87171' : '#4ade80'}`,
            }} />
            {isPaused ? 'PAUSED' : 'LIVE'}
          </span>
          {pendingCount > 0 && isPaused && (
            <span style={{
              fontSize: '10px',
              color: '#fbbf24',
              backgroundColor: 'rgba(251, 191, 36, 0.15)',
              padding: '1px 6px',
              borderRadius: '8px',
              border: '1px solid rgba(251, 191, 36, 0.3)',
            }}>
              {pendingCount} buffered
            </span>
          )}
        </div>

        {/* Pause + Speed Controls */}
        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
          <button
            onClick={handleTogglePause}
            style={{
              backgroundColor: isPaused ? 'rgba(239, 68, 68, 0.2)' : 'rgba(16, 185, 129, 0.15)',
              color: isPaused ? '#f87171' : '#4ade80',
              border: `1px solid ${isPaused ? 'rgba(239, 68, 68, 0.4)' : 'rgba(16, 185, 129, 0.3)'}`,
              padding: '3px 10px',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '11px',
              fontWeight: '700',
              fontFamily: 'monospace',
              transition: 'all 150ms ease',
            }}
          >
            {isPaused ? '▶ Resume' : '⏸ Pause'}
          </button>

          <div style={{
            display: 'flex',
            gap: '2px',
            backgroundColor: '#0f172a',
            borderRadius: '4px',
            padding: '2px',
            border: '1px solid #1e293b',
          }}>
            {Object.entries(SPEED_PRESETS).filter(([k]) => k !== 'FROZEN').map(([key, preset]) => (
              <button
                key={key}
                onClick={() => handleSpeedChange(key)}
                title={preset.desc}
                style={{
                  backgroundColor: speed === key ? '#0284c7' : 'transparent',
                  color: speed === key ? '#ffffff' : '#64748b',
                  border: 'none',
                  padding: '2px 7px',
                  borderRadius: '3px',
                  cursor: 'pointer',
                  fontSize: '9px',
                  fontWeight: '600',
                  transition: 'all 150ms ease',
                }}
              >
                {preset.label}
              </button>
            ))}
          </div>

          {/* Auto-scroll toggle */}
          <button
            onClick={() => {
              setAutoScroll(!autoScroll);
              if (!autoScroll && logBoxRef.current) {
                logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
              }
            }}
            title={autoScroll ? 'Auto-scroll ON' : 'Auto-scroll OFF (click to re-enable)'}
            style={{
              backgroundColor: autoScroll ? 'rgba(56, 189, 248, 0.15)' : '#1e293b',
              color: autoScroll ? '#38bdf8' : '#64748b',
              border: `1px solid ${autoScroll ? 'rgba(56, 189, 248, 0.3)' : '#334155'}`,
              padding: '2px 6px',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '10px',
              fontWeight: '600',
            }}
          >
            {autoScroll ? '↓ Auto' : '↓ Off'}
          </button>
        </div>
      </div>

      {/* Filter Pills */}
      <div style={{ display: 'flex', gap: '4px', fontSize: '11px', marginBottom: '6px', flexWrap: 'wrap' }}>
        {['ALL', 'MEM', 'VMSTAT', 'PROC', 'KERNEL'].map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            style={{
              backgroundColor: filter === f ? '#0284c7' : '#1e293b',
              color: filter === f ? '#ffffff' : '#94a3b8',
              border: '1px solid #334155',
              padding: '2px 7px',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '10px',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
            }}
          >
            {f}
            <span style={{
              fontSize: '9px',
              opacity: 0.7,
              fontFamily: 'monospace',
            }}>
              {filterCounts[f] || 0}
            </span>
          </button>
        ))}
        <button
          onClick={() => {
            setDisplayedLogs([]);
            pendingRef.current = [];
          }}
          style={{
            backgroundColor: '#1e293b',
            color: '#f87171',
            border: '1px solid #475569',
            padding: '2px 7px',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '10px',
          }}
        >
          Clear
        </button>
      </div>

      {/* Stream Terminal View */}
      <div
        ref={logBoxRef}
        onScroll={handleScroll}
        style={{
          flex: 1,
          overflowY: 'auto',
          background: '#060911',
          padding: '8px',
          borderRadius: '4px',
          fontSize: '11px',
          lineHeight: '1.5',
          border: `1px solid ${isPaused ? 'rgba(239, 68, 68, 0.3)' : '#1e293b'}`,
          transition: 'border-color 300ms ease',
          position: 'relative',
        }}
      >
        {filteredLogs.length === 0 ? (
          <div style={{ color: '#64748b', fontStyle: 'italic', padding: '12px', textAlign: 'center' }}>
            No serial output lines matched filter &apos;{filter}&apos;.
          </div>
        ) : (
          filteredLogs.map(item => (
            <div
              key={item.id}
              style={{
                display: 'flex',
                gap: '6px',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                padding: '1px 0',
                backgroundColor: item.isCommand
                  ? 'rgba(34, 211, 238, 0.08)'
                  : 'transparent',
                borderLeft: item.isCommand
                  ? '2px solid #22d3ee'
                  : '2px solid transparent',
                paddingLeft: '6px',
              }}
            >
              <span style={{ color: '#475569', minWidth: '70px', flexShrink: 0 }}>[{item.time}]</span>
              <span style={{
                color: item.color,
                fontWeight: 'bold',
                minWidth: '55px',
                flexShrink: 0,
              }}>
                [{item.tag}]
              </span>
              <span style={{ color: item.isCommand ? '#22d3ee' : '#e2e8f0' }}>{item.text}</span>
            </div>
          ))
        )}

        {/* Paused overlay indicator */}
        {isPaused && (
          <div style={{
            position: 'sticky',
            bottom: '0',
            left: '0',
            right: '0',
            textAlign: 'center',
            padding: '6px',
            background: 'linear-gradient(transparent, rgba(127, 29, 29, 0.3))',
            color: '#fca5a5',
            fontSize: '11px',
            fontWeight: '600',
            pointerEvents: 'none',
          }}>
            ⏸ Output paused — {pendingRef.current.length} lines buffered
          </div>
        )}
      </div>

      {/* Interactive Command Injection Form */}
      <form onSubmit={handleSendCustomCmd} style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
        <input
          type="text"
          value={customCmd}
          onChange={(e) => setCustomCmd(e.target.value)}
          placeholder="Inject command into Linux: e.g. cat /proc/version or free -m"
          style={{
            flex: 1,
            backgroundColor: '#0f172a',
            border: '1px solid #334155',
            borderRadius: '4px',
            padding: '5px 8px',
            color: '#f8fafc',
            fontSize: '11px',
            fontFamily: 'monospace',
          }}
        />
        <button
          type="submit"
          style={{
            backgroundColor: '#0284c7',
            color: '#ffffff',
            border: 'none',
            borderRadius: '4px',
            padding: '5px 12px',
            fontSize: '11px',
            cursor: 'pointer',
            fontWeight: '600',
          }}
        >
          Send
        </button>
      </form>
    </div>
  );
}
