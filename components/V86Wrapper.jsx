import React, { useEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef } from 'react';
import { parseMeminfo, parseVmstat, parseProcStat, parseProcessStatusList } from '@/lib/procParser';
import { LINE_TYPES } from '@/lib/serialMultiplexer';

const V86Wrapper = forwardRef(function V86Wrapper({
  multiplexer,
  onBootStateChange,
  onSerialLine,
  onMeminfoUpdate,
  onVmstatUpdate,
  onProcStatUpdate,
  onProcessesUpdate,
}, ref) {
  const [bootState, setBootState] = useState('BOOTING');
  const [initError, setInitError] = useState(null);
  const screenRef = useRef(null);
  const emulatorRef = useRef(null);
  const charBufferRef = useRef('');
  const lineCountRef = useRef(0);
  const loggedInRef = useRef(false);
  const bootStateRef = useRef('BOOTING');

  // Keep bootStateRef in sync
  useEffect(() => {
    bootStateRef.current = bootState;
    if (onBootStateChange) {
      onBootStateChange(bootState);
    }
  }, [bootState, onBootStateChange]);

  // Expose command sender to parent
  useImperativeHandle(ref, () => ({
    sendCommand: (cmd) => {
      if (emulatorRef.current) {
        if (typeof emulatorRef.current.serial0_send === 'function') {
          try { emulatorRef.current.serial0_send(cmd); } catch (e) {}
        }
        if (typeof emulatorRef.current.keyboard_send_text === 'function') {
          try { emulatorRef.current.keyboard_send_text(cmd); } catch (e) {}
        }
      }
    },
    getEmulator: () => emulatorRef.current,
    restart: () => {
      if (emulatorRef.current && typeof emulatorRef.current.restart === 'function') {
        emulatorRef.current.restart();
      }
    }
  }));

  const sendCommand = useCallback((cmd) => {
    if (emulatorRef.current) {
      if (typeof emulatorRef.current.serial0_send === 'function') {
        try { emulatorRef.current.serial0_send(cmd); } catch (e) {}
      }
      if (typeof emulatorRef.current.keyboard_send_text === 'function') {
        try { emulatorRef.current.keyboard_send_text(cmd); } catch (e) {}
      }
    }
  }, []);

  // Initialize v86
  useEffect(() => {
    if (typeof window === 'undefined') return;

    // URL interceptor to redirect 404 CDN URL to local/working image
    if (!window.__v86_interceptor_set) {
      window.__v86_interceptor_set = true;
      const originalOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        if (typeof url === 'string' && url.includes('copy.sh/v86/images/buildroot-bzimage.bin')) {
          url = '/images/buildroot-bzimage.bin';
        }
        return originalOpen.call(this, method, url, ...rest);
      };
      if (window.fetch) {
        const originalFetch = window.fetch;
        window.fetch = function(input, init) {
          if (typeof input === 'string' && input.includes('copy.sh/v86/images/buildroot-bzimage.bin')) {
            input = '/images/buildroot-bzimage.bin';
          }
          return originalFetch.call(this, input, init);
        };
      }
    }

    let isMounted = true;
    let pollInterval = null;
    let procListInterval = null;

    const startV86 = () => {
      if (!window.V86) {
        console.warn('V86 script not loaded yet, waiting...');
        setTimeout(startV86, 200);
        return;
      }

      if (!screenRef.current) return;

      try {
        console.log('[v86] Initializing Alpine/Buildroot Linux emulator...');

        const v86Config = {
          wasm_path: '/v86.wasm',
          memory_size: 128 * 1024 * 1024,
          vga_memory_size: 2 * 1024 * 1024,
          screen_container: document.getElementById('screen') || screenRef.current,
          bios: { url: '/bios/seabios.bin' },
          vga_bios: { url: '/bios/vgabios.bin' },
          bzimage: { url: 'https://copy.sh/v86/images/buildroot-bzimage.bin' },
          filesystem: {},
          autostart: true,
        };

        const emulator = new window.V86(v86Config);
        emulatorRef.current = emulator;

        const seenScreenLines = new Set();

        const handleIncomingChar = (rawChar) => {
          if (!isMounted) return;
          const char = typeof rawChar === 'number' ? String.fromCharCode(rawChar) : rawChar;

          if (char === '\r') return;

          if (char === '\n') {
            const line = charBufferRef.current;
            charBufferRef.current = '';

            if (line) {
              // Log first 20 lines to console as requested
              if (lineCountRef.current < 20) {
                lineCountRef.current += 1;
                console.log(`[serial0 #${lineCountRef.current}]`, line);
              }

              if (onSerialLine) onSerialLine(line);
              if (multiplexer) multiplexer.feedLine(line);

              // Detect login prompt or shell ready
              const lowerLine = line.toLowerCase();
              const isLogin = !loggedInRef.current && (lowerLine.includes('login:') || lowerLine.includes('buildroot login:'));
              const isShellPrompt = line.includes('~%') || line.includes('% ') || line.includes('/ #') || line.includes('~ #') || line.includes('# ') || line.includes('Run /init as init process') || line.includes('Files send via emulator');

              if (isLogin) {
                loggedInRef.current = true;
                console.log('[v86] Login prompt detected! Sending credentials...');
                setTimeout(() => {
                  try { emulator.serial0_send('root\n'); } catch (e) {}
                  try { emulator.keyboard_send_text('root\n'); } catch (e) {}
                }, 400);

                setTimeout(() => {
                  setBootState('READY');
                  console.log('[v86] Boot state transitioned: BOOTING -> READY');
                }, 1200);
              } else if (bootStateRef.current === 'BOOTING' && (isShellPrompt || loggedInRef.current)) {
                loggedInRef.current = true;
                setBootState('READY');
                console.log('[v86] Shell prompt detected! Boot state: READY');
              }
            }
          } else {
            charBufferRef.current += char;
            const buf = charBufferRef.current;
            const bufLower = buf.toLowerCase();
            if (!loggedInRef.current && (bufLower.endsWith('login: ') || bufLower.endsWith('login:'))) {
              loggedInRef.current = true;
              console.log('[v86] Login prompt detected in buffer! Sending credentials...');
              setTimeout(() => {
                try { emulator.serial0_send('root\n'); } catch (e) {}
                try { emulator.keyboard_send_text('root\n'); } catch (e) {}
              }, 400);
              setTimeout(() => {
                setBootState('READY');
                console.log('[v86] Boot state transitioned: BOOTING -> READY');
              }, 1200);
            } else if (bootStateRef.current === 'BOOTING' && (buf.includes('~%') || buf.endsWith('% ') || buf.endsWith('# ') || buf.endsWith('$ '))) {
              loggedInRef.current = true;
              setBootState('READY');
              console.log('[v86] Shell prompt detected in buffer! Boot state: READY');
            }
          }
        };

        // Listen on both serial0 byte and char events
        emulator.add_listener('serial0-output-byte', handleIncomingChar);
        emulator.add_listener('serial0-output-char', handleIncomingChar);

        // Periodically read lines from VGA screen adapter to capture stdout from tty1
        pollInterval = setInterval(() => {
          if (!emulatorRef.current || !emulatorRef.current.screen_adapter) return;
          try {
            if (typeof emulatorRef.current.screen_adapter.get_text_screen === 'function') {
              const screenRows = emulatorRef.current.screen_adapter.get_text_screen();
              if (Array.isArray(screenRows)) {
                screenRows.forEach(row => {
                  const line = (row || '').trim();
                  if (line && !seenScreenLines.has(line)) {
                    seenScreenLines.add(line);
                    if (seenScreenLines.size > 400) {
                      const first = seenScreenLines.values().next().value;
                      seenScreenLines.delete(first);
                    }
                    if (multiplexer) {
                      multiplexer.feedLine(line);
                    }
                    if (bootStateRef.current === 'BOOTING' && (line.includes('~%') || line.includes('Files send via') || line.includes('Run /init'))) {
                      setBootState('READY');
                    }
                  }
                });
              }
            }
          } catch (e) {}
        }, 1200);

        // Fallback timer: if boot takes 15 seconds, awaken prompt and set ready
        setTimeout(() => {
          if (bootStateRef.current === 'BOOTING' && emulatorRef.current) {
            console.log('[v86] Fallback timer fired. Awakening shell...');
            emulatorRef.current.serial0_send('\n');
            setTimeout(() => {
              if (bootStateRef.current === 'BOOTING') {
                setBootState('READY');
                console.log('[v86] Boot state set to READY via fallback');
              }
            }, 1000);
          }
        }, 15000);

      } catch (err) {
        console.error('[v86] Initialization error:', err);
        setInitError(err.message || 'Failed to initialize emulator');
      }
    };

    startV86();

    return () => {
      isMounted = false;
      if (pollInterval) clearInterval(pollInterval);
      if (procListInterval) clearInterval(procListInterval);
      if (emulatorRef.current) {
        try {
          emulatorRef.current.destroy();
        } catch (e) {
          console.warn('[v86] Error during destroy:', e);
        }
        emulatorRef.current = null;
      }
    };
  }, [multiplexer, onSerialLine]);

  // Periodic command injector (Module 2 & 3)
  useEffect(() => {
    if (bootState !== 'READY') return;

    console.log('[v86 Injector] Boot state is READY. Starting 3s injection interval...');

    // Route multiplexer block parsed events to state updaters
    let unsubscribeMem = null;
    let unsubscribeVm = null;
    let unsubscribeStat = null;
    let unsubscribeProcs = null;

    if (multiplexer) {
      unsubscribeMem = multiplexer.subscribeBlock(LINE_TYPES.MEMORY_LINE, (lines) => {
        const parsed = parseMeminfo(lines);
        console.log(`[v86 Injector ${new Date().toISOString()}] Parsed Meminfo:`, parsed);
        if (onMeminfoUpdate) onMeminfoUpdate(parsed);
      });

      unsubscribeVm = multiplexer.subscribeBlock(LINE_TYPES.VMSTAT_LINE, (lines) => {
        const parsed = parseVmstat(lines);
        console.log(`[v86 Injector ${new Date().toISOString()}] Parsed Vmstat:`, parsed);
        if (onVmstatUpdate) onVmstatUpdate(parsed);
      });

      unsubscribeStat = multiplexer.subscribeBlock(LINE_TYPES.PROCSTAT_LINE, (lines) => {
        const parsed = parseProcStat(lines);
        if (onProcStatUpdate) onProcStatUpdate(parsed);
      });

      unsubscribeProcs = multiplexer.subscribeBlock(LINE_TYPES.PROC_STATUS_LINE, (lines) => {
        const parsed = parseProcessStatusList(lines);
        if (onProcessesUpdate) onProcessesUpdate(parsed);
      });
    }

    const runCmd = (cmd) => {
      if (!emulatorRef.current) return;
      try {
        emulatorRef.current.serial0_send(cmd);
      } catch (e) {}
      try {
        if (typeof emulatorRef.current.keyboard_send_text === 'function') {
          // If shell is on tty1, redirect output to ttyS0 so serial0 captures it
          const redirected = cmd.replace(/\n$/, ' >/dev/ttyS0 2>&1\n');
          emulatorRef.current.keyboard_send_text(redirected);
        }
      } catch (e) {}
    };

    // Command injection every 3 seconds
    const interval3s = setInterval(() => {
      if (!emulatorRef.current) return;
      const timestamp = new Date().toLocaleTimeString();
      console.log(`[v86 Injector @ ${timestamp}] Injecting /proc commands every 3s...`);
      // Inject with sentinels for atomic multiplexer block parsing
      runCmd('echo "===MEM_START===" && cat /proc/meminfo && echo "===MEM_END==="\n');
      setTimeout(() => {
        runCmd('echo "===VMSTAT_START===" && cat /proc/vmstat && echo "===VMSTAT_END==="\n');
      }, 350);
      setTimeout(() => {
        runCmd('echo "===STAT_START===" && cat /proc/stat && echo "===STAT_END==="\n');
      }, 700);
    }, 3000);

    // Initial trigger right away
    setTimeout(() => {
      runCmd('echo "===MEM_START===" && cat /proc/meminfo && echo "===MEM_END==="\n');
      runCmd('echo "===VMSTAT_START===" && cat /proc/vmstat && echo "===VMSTAT_END==="\n');
      runCmd('echo "===STAT_START===" && cat /proc/stat && echo "===STAT_END==="\n');
    }, 500);

    // Process list injection every 5 seconds (Module 3)
    const interval5s = setInterval(() => {
      runCmd('echo "===PROCS_START===" && for p in /proc/[0-9]*/status; do head -n 4 "$p" 2>/dev/null; echo "---"; done && echo "===PROCS_END==="\n');
    }, 5000);

    // Initial process list poll
    setTimeout(() => {
      runCmd('echo "===PROCS_START===" && for p in /proc/[0-9]*/status; do head -n 4 "$p" 2>/dev/null; echo "---"; done && echo "===PROCS_END==="\n');
    }, 1500);

    return () => {
      clearInterval(interval3s);
      clearInterval(interval5s);
      if (unsubscribeMem) unsubscribeMem();
      if (unsubscribeVm) unsubscribeVm();
      if (unsubscribeStat) unsubscribeStat();
      if (unsubscribeProcs) unsubscribeProcs();
    };
  }, [bootState, multiplexer, onMeminfoUpdate, onVmstatUpdate, onProcStatUpdate, onProcessesUpdate]);

  return (
    <div className="v86-wrapper-container" style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      {initError && (
        <div style={{ padding: '12px', background: '#e53e3e', color: '#fff', borderRadius: '6px', marginBottom: '8px' }}>
          <strong>Emulator Error:</strong> {initError}
        </div>
      )}
      <div
        id="screen_container"
        ref={screenRef}
        style={{
          flex: 1,
          backgroundColor: '#000',
          position: 'relative',
          overflow: 'hidden',
          borderRadius: '8px',
          border: '1px solid #334155',
          boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
          minHeight: '380px',
        }}
      >
        <div
          id="screen"
          style={{
            whiteSpace: 'pre',
            fontFamily: 'monospace',
            fontSize: '13px',
            lineHeight: '14px',
            color: '#e2e8f0',
            width: '100%',
            height: '100%',
          }}
        />
        <canvas style={{ display: 'none' }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '8px', fontSize: '12px', color: '#94a3b8' }}>
        <span>Status: <strong style={{ color: bootState === 'READY' ? '#10b981' : '#f59e0b' }}>{bootState}</strong></span>
        <span>Buildroot Linux (i386)</span>
      </div>
    </div>
  );
});

export default V86Wrapper;
