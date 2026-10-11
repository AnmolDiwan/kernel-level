import React, { useState, useEffect, useRef } from 'react';
import { LINE_TYPES } from '@/lib/serialMultiplexer';
import { useKernelData } from '@/context/KernelDataContext';

export default function SerialParser({ multiplexer }) {
  const [logs, setLogs] = useState([]);
  const [filter, setFilter] = useState('ALL');
  const [customCmd, setCustomCmd] = useState('');
  const [stats, setStats] = useState({
    memLines: 0,
    vmLines: 0,
    procLines: 0,
    kernelLines: 0,
    totalLines: 0,
  });
  const autoScrollRef = useRef(true);
  const logBoxRef = useRef(null);
  const { sendCommand } = useKernelData();

  useEffect(() => {
    if (!multiplexer) return;

    // Load initial history from multiplexer ring buffer
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
        setLogs(initialLogs);

        // Compute initial stats
        let mem = 0, vm = 0, proc = 0, kern = 0;
        history.forEach(h => {
          if (h.type === LINE_TYPES.MEMORY_LINE) mem++;
          else if (h.type === LINE_TYPES.VMSTAT_LINE) vm++;
          else if (h.type === LINE_TYPES.PROCSTAT_LINE || h.type === LINE_TYPES.PROC_STATUS_LINE) proc++;
          else kern++;
        });
        setStats({
          memLines: mem,
          vmLines: vm,
          procLines: proc,
          kernelLines: kern,
          totalLines: history.length,
        });
      }
    }

    // Subscribe to all incoming serial stream lines
    const unsubscribe = multiplexer.subscribeAll((line, lineType, historyItem) => {
      const tag = getTagFromType(lineType);
      const color = getColorFromType(lineType);
      const entry = {
        id: historyItem?.id || (Date.now() + Math.random()),
        tag,
        type: lineType,
        text: line,
        color,
        time: historyItem?.time || new Date().toLocaleTimeString(),
      };

      setLogs(prev => [...prev.slice(-299), entry]);

      setStats(prev => ({
        ...prev,
        totalLines: prev.totalLines + 1,
        memLines: lineType === LINE_TYPES.MEMORY_LINE ? prev.memLines + 1 : prev.memLines,
        vmLines: lineType === LINE_TYPES.VMSTAT_LINE ? prev.vmLines + 1 : prev.vmLines,
        procLines: (lineType === LINE_TYPES.PROCSTAT_LINE || lineType === LINE_TYPES.PROC_STATUS_LINE) ? prev.procLines + 1 : prev.procLines,
        kernelLines: lineType === LINE_TYPES.KERNEL_LOG ? prev.kernelLines + 1 : prev.kernelLines,
      }));
    });

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [multiplexer]);

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

  useEffect(() => {
    if (autoScrollRef.current && logBoxRef.current) {
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
    }
  }, [logs]);

  const handleSendCustomCmd = (e) => {
    e.preventDefault();
    if (!customCmd.trim()) return;
    const cmd = customCmd.trim() + '\n';
    if (sendCommand) {
      sendCommand(cmd);
    }
    setCustomCmd('');
  };

  const filteredLogs = logs.filter(item => {
    if (filter === 'ALL') return true;
    if (filter === 'MEM') return item.type === LINE_TYPES.MEMORY_LINE;
    if (filter === 'VMSTAT') return item.type === LINE_TYPES.VMSTAT_LINE;
    if (filter === 'PROC') return item.type === LINE_TYPES.PROCSTAT_LINE || item.type === LINE_TYPES.PROC_STATUS_LINE;
    if (filter === 'KERNEL') return item.type === LINE_TYPES.KERNEL_LOG;
    return true;
  });

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
      {/* Top Header & Filter Bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px', flexWrap: 'wrap', gap: '6px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '13px', fontWeight: 'bold', color: '#f1f5f9' }}>Serial Stream Monitor</span>
          <span style={{ fontSize: '10px', color: '#64748b' }}>({stats.totalLines} lines parsed)</span>
        </div>

        {/* Filter Pills */}
        <div style={{ display: 'flex', gap: '4px', fontSize: '11px' }}>
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
              }}
            >
              {f}
            </button>
          ))}
          <button
            onClick={() => setLogs([])}
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
      </div>

      {/* Stream Terminal View */}
      <div
        ref={logBoxRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          background: '#060911',
          padding: '8px',
          borderRadius: '4px',
          fontSize: '11px',
          lineHeight: '1.45',
          border: '1px solid #1e293b',
        }}
      >
        {filteredLogs.length === 0 ? (
          <div style={{ color: '#64748b', fontStyle: 'italic', padding: '12px', textAlign: 'center' }}>
            No serial output lines matched filter &apos;{filter}&apos;.
          </div>
        ) : (
          filteredLogs.map(item => (
            <div key={item.id} style={{ display: 'flex', gap: '6px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              <span style={{ color: '#475569' }}>[{item.time}]</span>
              <span style={{ color: item.color, fontWeight: 'bold', minWidth: '55px' }}>[{item.tag}]</span>
              <span style={{ color: '#e2e8f0' }}>{item.text}</span>
            </div>
          ))
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
