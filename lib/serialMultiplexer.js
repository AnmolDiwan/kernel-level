/**
 * Serial stream multiplexer for v86 serial0 output.
 * Classifies raw serial lines and routes them to appropriate handlers.
 */

export const LINE_TYPES = {
  MEMORY_LINE: 'MEMORY_LINE',
  VMSTAT_LINE: 'VMSTAT_LINE',
  PROCSTAT_LINE: 'PROCSTAT_LINE',
  PROC_STATUS_LINE: 'PROC_STATUS_LINE',
  KERNEL_LOG: 'KERNEL_LOG',
};

export class SerialMultiplexer {
  constructor() {
    this.subscribers = {
      [LINE_TYPES.MEMORY_LINE]: new Set(),
      [LINE_TYPES.VMSTAT_LINE]: new Set(),
      [LINE_TYPES.PROCSTAT_LINE]: new Set(),
      [LINE_TYPES.PROC_STATUS_LINE]: new Set(),
      [LINE_TYPES.KERNEL_LOG]: new Set(),
    };

    this.blockSubscribers = {
      [LINE_TYPES.MEMORY_LINE]: new Set(),
      [LINE_TYPES.VMSTAT_LINE]: new Set(),
      [LINE_TYPES.PROCSTAT_LINE]: new Set(),
      [LINE_TYPES.PROC_STATUS_LINE]: new Set(),
    };

    // Global subscriber for all lines
    this.allSubscribers = new Set();

    // Ring buffer history of recent lines (persisted across component mounts)
    this.history = [];

    // Buffer for collecting grouped lines
    this.currentBlockType = null;
    this.currentBlockLines = [];
    this.blockTimeout = null;
  }

  /**
   * Classify line according to requirements:
   * - "MemTotal" || "MemFree" || "Cached" → MEMORY_LINE
   * - "pgfault" || "pgmajfault" || "pswpin" → VMSTAT_LINE
   * - "processes" || "procs_running" → PROCSTAT_LINE
   * - Everything else → KERNEL_LOG
   */
  classifyLine(rawLine) {
    const line = (rawLine || '').trim();

    // Check for explicit markers if sentinels used
    if (line.includes('===MEM_START===') || line.includes('===MEM_END===')) return LINE_TYPES.MEMORY_LINE;
    if (line.includes('===VMSTAT_START===') || line.includes('===VMSTAT_END===')) return LINE_TYPES.VMSTAT_LINE;
    if (line.includes('===STAT_START===') || line.includes('===STAT_END===')) return LINE_TYPES.PROCSTAT_LINE;
    if (line.includes('===PROCS_START===') || line.includes('===PROCS_END===') || line.startsWith('Name:') || line.startsWith('State:') || line.startsWith('Pid:')) {
      return LINE_TYPES.PROC_STATUS_LINE;
    }

    if (line.includes('MemTotal') || line.includes('MemFree') || line.includes('Cached') || line.includes('MemAvailable') || line.includes('Buffers')) {
      return LINE_TYPES.MEMORY_LINE;
    }
    if (line.includes('pgfault') || line.includes('pgmajfault') || line.includes('pswpin') || line.includes('pswpout')) {
      return LINE_TYPES.VMSTAT_LINE;
    }
    if (line.includes('processes') || line.includes('procs_running') || line.includes('procs_blocked') || /^cpu\s+\d+/.test(line)) {
      return LINE_TYPES.PROCSTAT_LINE;
    }

    return LINE_TYPES.KERNEL_LOG;
  }

  /**
   * Feed a raw line into the multiplexer
   */
  feedLine(rawLine) {
    if (typeof rawLine !== 'string') return;
    const cleanLine = rawLine.replace(/\r/g, '').trim();
    if (!cleanLine) return;

    const lineType = this.classifyLine(cleanLine);

    // Save to ring buffer history
    const historyItem = {
      id: Date.now() + Math.random(),
      line: cleanLine,
      type: lineType,
      time: new Date().toLocaleTimeString(),
    };
    this.history.push(historyItem);
    if (this.history.length > 250) {
      this.history.shift();
    }

    // Notify all-subscribers
    this.allSubscribers.forEach(cb => {
      try { cb(cleanLine, lineType, historyItem); } catch (e) { console.error('Error in allSubscriber:', e); }
    });

    // Notify per-line subscribers
    const lineSubs = this.subscribers[lineType];
    if (lineSubs) {
      lineSubs.forEach(cb => {
        try { cb(cleanLine, lineType); } catch (e) { console.error('Error in line subscriber:', e); }
      });
    }

    // Accumulate into block
    this.accumulateBlock(cleanLine, lineType);
  }

  accumulateBlock(cleanLine, lineType) {
    // If sentinel end marker
    if (cleanLine.includes('===MEM_END===') && this.currentBlockType === LINE_TYPES.MEMORY_LINE) {
      this.flushBlock();
      return;
    }
    if (cleanLine.includes('===VMSTAT_END===') && this.currentBlockType === LINE_TYPES.VMSTAT_LINE) {
      this.flushBlock();
      return;
    }
    if (cleanLine.includes('===STAT_END===') && this.currentBlockType === LINE_TYPES.PROCSTAT_LINE) {
      this.flushBlock();
      return;
    }
    if (cleanLine.includes('===PROCS_END===') && this.currentBlockType === LINE_TYPES.PROC_STATUS_LINE) {
      this.flushBlock();
      return;
    }

    // Sentinel start markers
    if (cleanLine.includes('===MEM_START===')) {
      this.flushBlock();
      this.currentBlockType = LINE_TYPES.MEMORY_LINE;
      this.scheduleBlockFlush(1500);
      return;
    }
    if (cleanLine.includes('===VMSTAT_START===')) {
      this.flushBlock();
      this.currentBlockType = LINE_TYPES.VMSTAT_LINE;
      this.scheduleBlockFlush(1500);
      return;
    }
    if (cleanLine.includes('===STAT_START===')) {
      this.flushBlock();
      this.currentBlockType = LINE_TYPES.PROCSTAT_LINE;
      this.scheduleBlockFlush(1500);
      return;
    }
    if (cleanLine.includes('===PROCS_START===')) {
      this.flushBlock();
      this.currentBlockType = LINE_TYPES.PROC_STATUS_LINE;
      this.scheduleBlockFlush(2000);
      return;
    }

    // If matching active block type or start of signature without sentinel
    const isSpecialType = lineType === LINE_TYPES.MEMORY_LINE ||
                          lineType === LINE_TYPES.VMSTAT_LINE ||
                          lineType === LINE_TYPES.PROCSTAT_LINE ||
                          lineType === LINE_TYPES.PROC_STATUS_LINE;

    if (isSpecialType) {
      if (this.currentBlockType && this.currentBlockType !== lineType) {
        this.flushBlock();
      }
      this.currentBlockType = lineType;
      this.currentBlockLines.push(cleanLine);
      this.scheduleBlockFlush(500);
    } else if (this.currentBlockType) {
      // In a block, collect lines that belong to it
      if (this.currentBlockType === LINE_TYPES.MEMORY_LINE && /^[A-Za-z0-9_]+:\s+\d+/.test(cleanLine)) {
        this.currentBlockLines.push(cleanLine);
        this.scheduleBlockFlush(500);
      } else if (this.currentBlockType === LINE_TYPES.VMSTAT_LINE && /^[a-z0-9_]+\s+\d+/.test(cleanLine)) {
        this.currentBlockLines.push(cleanLine);
        this.scheduleBlockFlush(500);
      } else if (this.currentBlockType === LINE_TYPES.PROCSTAT_LINE && (/^[a-z0-9_]+\s+\d+/.test(cleanLine) || cleanLine.startsWith('cpu'))) {
        this.currentBlockLines.push(cleanLine);
        this.scheduleBlockFlush(500);
      } else if (this.currentBlockType === LINE_TYPES.PROC_STATUS_LINE && (cleanLine.startsWith('Name:') || cleanLine.startsWith('Pid:') || cleanLine.startsWith('State:') || cleanLine.startsWith('PPid:') || cleanLine === '---')) {
        this.currentBlockLines.push(cleanLine);
        this.scheduleBlockFlush(500);
      }
    }
  }

  scheduleBlockFlush(timeoutMs) {
    if (this.blockTimeout) clearTimeout(this.blockTimeout);
    this.blockTimeout = setTimeout(() => {
      this.flushBlock();
    }, timeoutMs);
  }

  flushBlock() {
    if (this.blockTimeout) {
      clearTimeout(this.blockTimeout);
      this.blockTimeout = null;
    }
    if (!this.currentBlockType || this.currentBlockLines.length === 0) {
      this.currentBlockType = null;
      this.currentBlockLines = [];
      return;
    }

    const type = this.currentBlockType;
    const lines = [...this.currentBlockLines];
    this.currentBlockType = null;
    this.currentBlockLines = [];

    const subs = this.blockSubscribers[type];
    if (subs) {
      subs.forEach(cb => {
        try { cb(lines, type); } catch (e) { console.error('Error in block subscriber:', e); }
      });
    }
  }

  subscribe(type, callback) {
    if (!this.subscribers[type]) {
      this.subscribers[type] = new Set();
    }
    this.subscribers[type].add(callback);
    return () => this.subscribers[type].delete(callback);
  }

  subscribeBlock(type, callback) {
    if (!this.blockSubscribers[type]) {
      this.blockSubscribers[type] = new Set();
    }
    this.blockSubscribers[type].add(callback);
    return () => this.blockSubscribers[type].delete(callback);
  }

  subscribeAll(callback) {
    this.allSubscribers.add(callback);
    return () => this.allSubscribers.delete(callback);
  }

  getHistory() {
    return [...this.history];
  }

  clear() {
    this.allSubscribers.clear();
    this.history = [];
    Object.values(this.subscribers).forEach(set => set.clear());
    Object.values(this.blockSubscribers).forEach(set => set.clear());
    if (this.blockTimeout) clearTimeout(this.blockTimeout);
  }
}
