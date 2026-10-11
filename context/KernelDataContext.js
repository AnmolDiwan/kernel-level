import React, { createContext, useContext, useState, useRef, useEffect, useCallback } from 'react';
import { SerialMultiplexer } from '@/lib/serialMultiplexer';

const KernelDataContext = createContext(null);

export function KernelDataProvider({ children }) {
  const [bootState, setBootState] = useState('BOOTING');
  const [meminfo, setMeminfo] = useState(null);
  const [vmstat, setVmstat] = useState(null);
  const [procStat, setProcStat] = useState(null);
  const [processes, setProcesses] = useState([]);
  const [emptyDataCount, setEmptyDataCount] = useState(0);
  const [initError, setInitError] = useState(null);
  const [bootTimer, setBootTimer] = useState(0);

  // Single SerialMultiplexer instance across the entire application lifecycle
  const multiplexerRef = useRef(null);
  if (!multiplexerRef.current) {
    multiplexerRef.current = new SerialMultiplexer();
  }

  const v86WrapperRef = useRef(null);

  // Boot timer countdown/elapsed
  useEffect(() => {
    let timer;
    if (bootState === 'BOOTING') {
      timer = setInterval(() => {
        setBootTimer(prev => prev + 1);
      }, 1000);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [bootState]);

  // Command injection helper
  const sendCommand = useCallback((cmd) => {
    if (v86WrapperRef.current && typeof v86WrapperRef.current.sendCommand === 'function') {
      v86WrapperRef.current.sendCommand(cmd);
    }
  }, []);

  const handleMeminfoUpdate = useCallback((data) => {
    if (!data || data.total === 0) {
      setEmptyDataCount(c => c + 1);
    } else {
      setEmptyDataCount(0);
      setMeminfo(data);
    }
  }, []);

  const handleVmstatUpdate = useCallback((data) => {
    if (!data || data.pageFaults === 0) {
      setEmptyDataCount(c => c + 1);
    } else {
      setEmptyDataCount(0);
      setVmstat(data);
    }
  }, []);

  const handleProcStatUpdate = useCallback((data) => {
    if (data) {
      setProcStat(data);
    }
  }, []);

  const handleProcessesUpdate = useCallback((data) => {
    if (Array.isArray(data) && data.length > 0) {
      setProcesses(data);
    }
  }, []);

  const restartEmulator = useCallback(() => {
    setBootState('BOOTING');
    setBootTimer(0);
    setInitError(null);
    setEmptyDataCount(0);
    if (v86WrapperRef.current && typeof v86WrapperRef.current.restart === 'function') {
      v86WrapperRef.current.restart();
    }
  }, []);

  const value = {
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
    multiplexer: multiplexerRef.current,
    v86WrapperRef,
    sendCommand,
    restartEmulator,
    handleMeminfoUpdate,
    handleVmstatUpdate,
    handleProcStatUpdate,
    handleProcessesUpdate,
  };

  return (
    <KernelDataContext.Provider value={value}>
      {children}
    </KernelDataContext.Provider>
  );
}

export function useKernelData() {
  const context = useContext(KernelDataContext);
  if (!context) {
    throw new Error('useKernelData must be used within a KernelDataProvider');
  }
  return context;
}
