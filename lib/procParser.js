/**
 * Parsers for Linux /proc filesystem outputs.
 */

/**
 * Parses /proc/meminfo lines into memory metrics.
 * @param {string[]|string} linesRaw
 * @returns {{ total: number, free: number, cached: number, available: number, usedPercent: number }}
 */
export function parseMeminfo(linesRaw) {
  const lines = Array.isArray(linesRaw) ? linesRaw : (linesRaw || '').split('\n');
  const values = {};

  for (const raw of lines) {
    const line = raw.trim();
    const match = line.match(/^([A-Za-z0-9_()]+):\s+(\d+)\s*(?:kB)?/);
    if (match) {
      const key = match[1];
      const kb = parseInt(match[2], 10);
      values[key] = kb;
    }
  }

  // Convert kB to MB (1 decimal place)
  const totalKb = values.MemTotal || 0;
  const freeKb = values.MemFree || 0;
  const cachedKb = (values.Cached || 0) + (values.Buffers || 0) + (values.SReclaimable || 0);
  const availableKb = values.MemAvailable !== undefined ? values.MemAvailable : (freeKb + cachedKb);

  const total = totalKb > 0 ? Number((totalKb / 1024).toFixed(1)) : 0;
  const free = Number((freeKb / 1024).toFixed(1));
  const cached = Number((cachedKb / 1024).toFixed(1));
  const available = Number((availableKb / 1024).toFixed(1));

  let usedPercent = 0;
  if (totalKb > 0) {
    const usedKb = Math.max(0, totalKb - availableKb);
    usedPercent = Number(((usedKb / totalKb) * 100).toFixed(1));
  }

  return {
    total,
    free,
    cached,
    available,
    usedPercent,
  };
}

/**
 * Parses /proc/vmstat lines into virtual memory statistics.
 * @param {string[]|string} linesRaw
 * @returns {{ pageFaults: number, majorFaults: number, swapIn: number, swapOut: number }}
 */
export function parseVmstat(linesRaw) {
  const lines = Array.isArray(linesRaw) ? linesRaw : (linesRaw || '').split('\n');
  const values = {};

  for (const raw of lines) {
    const line = raw.trim();
    const match = line.match(/^([a-z0-9_]+)\s+(\d+)/);
    if (match) {
      values[match[1]] = parseInt(match[2], 10);
    }
  }

  return {
    pageFaults: values.pgfault || 0,
    majorFaults: values.pgmajfault || 0,
    swapIn: values.pswpin || 0,
    swapOut: values.pswpout || 0,
  };
}

/**
 * Parses /proc/stat lines into process states and CPU metrics.
 * @param {string[]|string} linesRaw
 * @returns {{ running: number, sleeping: number, stopped: number, zombie: number, cpuMetrics?: object }}
 */
export function parseProcStat(linesRaw) {
  const lines = Array.isArray(linesRaw) ? linesRaw : (linesRaw || '').split('\n');
  let running = 0;
  let blocked = 0;
  let totalProcesses = 0;
  let ctxt = 0;
  let cpuMetrics = null;

  for (const raw of lines) {
    const line = raw.trim();
    
    // CPU line: cpu  user nice system idle iowait irq softirq steal guest guest_nice
    if (line.startsWith('cpu ')) {
      const parts = line.split(/\s+/).slice(1).map(Number);
      if (parts.length >= 4) {
        const user = parts[0] || 0;
        const nice = parts[1] || 0;
        const system = parts[2] || 0;
        const idle = parts[3] || 0;
        const iowait = parts[4] || 0;
        const irq = parts[5] || 0;
        const softirq = parts[6] || 0;
        const steal = parts[7] || 0;
        const total = user + nice + system + idle + iowait + irq + softirq + steal;
        cpuMetrics = { user, nice, system, idle, total };
      }
    }

    if (line.startsWith('procs_running')) {
      const parts = line.split(/\s+/);
      running = parseInt(parts[1], 10) || 0;
    } else if (line.startsWith('procs_blocked')) {
      const parts = line.split(/\s+/);
      blocked = parseInt(parts[1], 10) || 0;
    } else if (line.startsWith('processes')) {
      const parts = line.split(/\s+/);
      totalProcesses = parseInt(parts[1], 10) || 0;
    } else if (line.startsWith('ctxt')) {
      const parts = line.split(/\s+/);
      ctxt = parseInt(parts[1], 10) || 0;
    }
  }

  // Ensure reasonable default values if only partial lines found
  const sleeping = Math.max(0, blocked || (totalProcesses > running ? totalProcesses - running : 0));

  return {
    running: Math.max(1, running), // at least the cat command itself was running
    sleeping,
    stopped: 0,
    zombie: 0,
    ctxt,
    cpuMetrics,
  };
}

/**
 * Parses /proc/[pid]/status blocks into an array of process objects.
 * @param {string[]|string} linesRaw
 * @returns {Array<{ pid: number, name: string, state: string, priority: number }>}
 */
export function parseProcessStatusList(linesRaw) {
  const lines = Array.isArray(linesRaw) ? linesRaw : (linesRaw || '').split('\n');
  const processes = [];
  let current = {};

  const saveCurrent = () => {
    if (current.pid && current.name) {
      processes.push({
        pid: current.pid,
        name: current.name,
        state: current.state || 'S',
        priority: current.priority !== undefined ? current.priority : 20,
      });
    }
    current = {};
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line === '---' || line.includes('===PROCS_')) {
      saveCurrent();
      continue;
    }

    if (line.startsWith('Name:')) {
      if (current.name) saveCurrent();
      current.name = line.replace('Name:', '').trim();
    } else if (line.startsWith('Pid:')) {
      current.pid = parseInt(line.replace('Pid:', '').trim(), 10);
    } else if (line.startsWith('State:')) {
      const stateMatch = line.match(/State:\s+([A-Z])/i);
      current.state = stateMatch ? stateMatch[1].toUpperCase() : 'S';
    } else if (line.startsWith('Priority:') || line.startsWith('Nice:')) {
      current.priority = parseInt(line.split(':')[1].trim(), 10) || 20;
    }
  }
  saveCurrent();

  return processes;
}
