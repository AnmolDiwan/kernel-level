# KernelScope — Implementation Plan

> A Next.js 14 application that boots Alpine Linux via v86 in the browser and visualizes real-time kernel data (CPU scheduling, memory/paging) from the `/proc` filesystem.

---

## Phase 0: Project Scaffolding & Asset Setup

### Step 0.1 — Initialize Next.js 14 Project
- Run `npx -y create-next-app@14 ./` inside `c:\Users\ASUS\kernel-level` with flags: `--js --no-tailwind --no-eslint --no-app --src-dir=false --import-alias="@/*"`
- This gives us a Pages Router project (not App Router) matching the `/pages/index.js` requirement.

### Step 0.2 — Create Directory Structure
```
kernel-level/
├── components/
│   ├── V86Wrapper.jsx
│   ├── SerialParser.jsx       (helper, may merge into multiplexer)
│   ├── CPUScheduler.jsx
│   └── MemoryVisualizer.jsx
├── lib/
│   ├── serialMultiplexer.js
│   └── procParser.js
├── public/
│   ├── bios/
│   │   ├── seabios.bin
│   │   └── vgabios.bin
│   ├── libv86.js
│   └── v86.wasm
├── pages/
│   └── index.js
└── package.json
```

### Step 0.3 — Download v86 Assets
1. Download latest v86 release from GitHub (`https://github.com/copy/v86/releases`).
2. Extract `libv86.js` and `v86.wasm` → place in `/public/`.
3. Download BIOS files from v86 CDN:
   - `https://copy.sh/v86/bios/seabios.bin` → `/public/bios/seabios.bin`
   - `https://copy.sh/v86/bios/vgabios.bin` → `/public/bios/vgabios.bin`
4. **Strategy**: Use `Invoke-WebRequest` (PowerShell) to download each asset directly. v86 is loaded via `<script>` tag in `_document.js` (not `import` — v86 is a browser-only global).

### Step 0.4 — Configure Next.js
- Create `pages/_document.js` to inject `<script src="/libv86.js">` in `<Head>`.
- Add `next.config.js` tweaks: disable strict mode for v86 compatibility (v86 doesn't play well with double-renders).

### Step 0.5 — Verification Gate
- Run `npm run dev`, confirm `localhost:3000` loads without errors.
- Confirm all folders exist. Confirm `libv86.js`, `v86.wasm`, `seabios.bin`, `vgabios.bin` are accessible via browser at their `/public` URLs.

---

## Phase 1: V86 Integration & Serial Capture (Module 1)

### Step 1.1 — V86Wrapper Component Shell
Create `components/V86Wrapper.jsx`:
- Renders a `<div id="screen_container">` containing `<div id="screen"></div>` and a hidden `<canvas>`.
- Uses `useRef` for the emulator instance, `useEffect` for initialization.
- Loads v86 **only on client side** (`typeof window !== 'undefined'` guard + dynamic import or script check).

### Step 1.2 — V86 Configuration
```js
const emulator = new V86({
  wasm_path: "/v86.wasm",
  memory_size: 128 * 1024 * 1024,
  vga_memory_size: 2 * 1024 * 1024,
  screen_container: screenRef.current,
  bios: { url: "/bios/seabios.bin" },
  vga_bios: { url: "/bios/vgabios.bin" },
  bzimage: { url: "https://copy.sh/v86/images/buildroot-bzimage.bin" },
  filesystem: {},
  autostart: true,
});
```

> [!IMPORTANT]
> The `screen_container` must reference the outer container div, not the canvas. v86 creates its own canvas inside it. Use `useRef` to pass the DOM node.

### Step 1.3 — Serial Line Buffering
```
serial0-output-char listener:
  buffer = ""
  on char:
    if char === "\n":
      emit(buffer)  // callback with complete line
      buffer = ""
    else:
      buffer += char
```

### Step 1.4 — Boot State Machine
```
States: BOOTING → READY
Transition trigger: serial line contains "login:" or "buildroot login:" or "# " (shell prompt)
```
- Expose `bootState` via a callback prop or React context.
- Log first 20 serial lines to console for debugging.

### Step 1.5 — Command Injection API
- Expose `sendCommand(cmd)` method via `useImperativeHandle` or callback ref.
- Internally calls `emulator.serial0_send(cmd)`.

### Step 1.6 — Verification Gate
- Boot v86, confirm VGA screen renders in browser.
- Confirm serial lines appear in console.
- Confirm boot state transitions to READY.
- Zero v86 initialization errors.

---

## Phase 2: Serial Multiplexer & /proc Parsers (Module 2)

### Step 2.1 — Serial Multiplexer (`lib/serialMultiplexer.js`)

**Architecture**: A class that receives raw serial lines and routes them to subscribers based on content signatures.

```js
class SerialMultiplexer {
  constructor() {
    this.subscribers = {
      MEMORY_LINE: [],
      VMSTAT_LINE: [],
      PROCSTAT_LINE: [],
      KERNEL_LOG: [],
    };
    this.currentBlock = { type: null, lines: [] };
  }

  // Accumulates lines into blocks, emits when block boundary detected
  processLine(line) {
    const type = this.classifyLine(line);
    // ... routing logic
  }

  classifyLine(line) {
    if (/MemTotal|MemFree|Cached|MemAvailable|Buffers|Slab/.test(line)) return 'MEMORY_LINE';
    if (/pgfault|pgmajfault|pswpin|pswpout|pgpgin/.test(line)) return 'VMSTAT_LINE';
    if (/processes|procs_running|procs_blocked|cpu\s/.test(line)) return 'PROCSTAT_LINE';
    return 'KERNEL_LOG';
  }

  subscribe(type, callback) { ... }
}
```

> [!WARNING]
> **Block accumulation challenge**: `/proc` outputs arrive as individual serial lines, not atomic blocks. We need a strategy to group related lines:
> - Use a sentinel approach: inject a marker before/after each `cat` command (e.g., `echo "---MEMINFO_START---"` and `echo "---MEMINFO_END---"`).
> - Parse between sentinels to extract complete blocks.
> - This is more reliable than pure content-based classification.

**Revised injection strategy**:
```bash
echo "===MEM_START===" && cat /proc/meminfo && echo "===MEM_END==="
echo "===VMSTAT_START===" && cat /proc/vmstat && echo "===VMSTAT_END==="
echo "===STAT_START===" && cat /proc/stat && echo "===STAT_END==="
```

### Step 2.2 — /proc Parsers (`lib/procParser.js`)

#### `parseMeminfo(lines)`
```
Input:  ["MemTotal:       131072 kB", "MemFree:        95000 kB", ...]
Output: { total: 128, free: 92.77, cached: 12.5, available: 105.2, usedPercent: 17.5 }
        (values in MB)
```
- Regex: `/^(\w+):\s+(\d+)\s+kB$/`
- Convert kB → MB by dividing by 1024.
- `usedPercent = ((total - available) / total) * 100`

#### `parseVmstat(lines)`
```
Input:  ["pgfault 12345", "pgmajfault 67", ...]
Output: { pageFaults: 12345, majorFaults: 67, swapIn: 0, swapOut: 0 }
```
- Regex: `/^(\w+)\s+(\d+)$/`
- Map keys: `pgfault→pageFaults`, `pgmajfault→majorFaults`, `pswpin→swapIn`, `pswpout→swapOut`

#### `parseProcStat(lines)`
```
Input:  ["cpu  100 20 30 500 10 0 5 0 0 0", "processes 1234", "procs_running 3", ...]
Output: { running: 3, sleeping: computed, stopped: 0, zombie: 0,
          cpuUser: 100, cpuSystem: 30, cpuIdle: 500 }
```
- Parse `cpu` line for user/nice/system/idle/iowait values.
- Parse `processes`, `procs_running`, `procs_blocked`.

### Step 2.3 — Periodic Command Injection
In `V86Wrapper.jsx`, after READY state:
```js
const interval = setInterval(() => {
  sendCommand('echo "===MEM_START===" && cat /proc/meminfo && echo "===MEM_END==="\n');
  sendCommand('echo "===VMSTAT_START===" && cat /proc/vmstat && echo "===VMSTAT_END==="\n');
  sendCommand('echo "===STAT_START===" && cat /proc/stat && echo "===STAT_END==="\n');
}, 3000);
```

### Step 2.4 — Verification Gate
- `console.log` parsed meminfo → `MemTotal` must be ~128 MB (non-zero).
- `console.log` parsed vmstat → `pageFaults` must be non-zero after boot.
- Injection fires every 3s (check timestamps).
- No misrouted lines (spot check 5+ cycles).

---

## Phase 3: CPU Scheduler Visualization (Module 3)

### Step 3.1 — Process List Data Collection
**Additional injection** (every 5 seconds):
```bash
echo "===PROCS_START===" && for p in /proc/[0-9]*/status; do head -4 "$p" 2>/dev/null; echo "---"; done && echo "===PROCS_END==="
```
This outputs blocks like:
```
Name:   init
Pid:    1
State:  S (sleeping)
PPid:   0
---
Name:   kthreadd
...
```

Parse into: `[{ name: "init", pid: 1, state: "S", priority: 20 }, ...]`

> [!NOTE]
> Buildroot's `/proc/[pid]/status` format may not include `Priority` on all processes. Fallback to a default value of 20 if missing. Limit to first 50 PIDs to avoid serial flooding.

### Step 3.2 — SVG Layout Design

```
┌─────────────────────────────────────────────────────┐
│  Context Switches: 47    Run Queue: 3    CPU: ██░ 34% │
├─────────────────────────────────────────────────────┤
│ RUNNING (green)  │  ○1  ○23                          │
│─────────────────────────────────────────────────────│
│ READY   (yellow) │  ○5  ○12  ○18                     │
│─────────────────────────────────────────────────────│
│ BLOCKED (gray)   │  ○3  ○7  ○15  ○22                 │
├─────────────────────────────────────────────────────┤
│ Selected: PID 23 | Name: httpd | State: R | Pri: 20  │
└─────────────────────────────────────────────────────┘
```

### Step 3.3 — State Mapping
```
/proc state → Lane mapping:
  "R" (running/runnable) → RUNNING lane
  "S" (sleeping)         → BLOCKED lane  (interruptible sleep = waiting for I/O)
  "D" (disk sleep)       → BLOCKED lane
  "Z" (zombie)           → BLOCKED lane  (special color: purple)
  "T" (stopped)          → BLOCKED lane
```

> [!IMPORTANT]
> Most Linux processes will be in "S" state most of the time. To make the visualization interesting:
> - Map "R" → RUNNING lane
> - Processes that were "R" in the previous tick but are now "S" → briefly show in READY lane before animating to BLOCKED (simulates the scheduling concept)
> - This makes the visualization educational even though real Linux doesn't expose a "ready queue" via `/proc`.

### Step 3.4 — Animation System
- Each process bubble is an SVG `<circle>` + `<text>` group.
- Position is determined by lane (y-coordinate) and index within lane (x-coordinate).
- CSS transitions on `transform` property: `transition: transform 300ms ease-in-out`.
- Track previous positions to animate smoothly.

### Step 3.5 — Context Switch Counter
- Compare current tick's RUNNING processes with previous tick's.
- If a PID moved from READY→RUNNING or was not in RUNNING before → increment counter.
- Also use `/proc/stat`'s `ctxt` field for real kernel context switch count.

### Step 3.6 — CPU Usage Bar
- Store previous `/proc/stat` CPU values.
- Delta calculation: `usage = 1 - (idle_delta / total_delta)`.
- Render as SVG rect with width proportional to usage percentage.

### Step 3.7 — State History
- Ring buffer of last ~4 snapshots (10 seconds at 3s intervals).
- Used for animation direction and context switch detection.

### Step 3.8 — Verification Gate
- ≥5 processes visible after boot.
- States update every 3-5 seconds.
- Bubbles animate between lanes on state change.
- Context switch counter increments.
- CPU bar is non-zero and dynamic.
- Graceful loading state when data is empty/delayed.

---

## Phase 4: Memory & Paging Visualization (Module 4)

### Step 4.1 — Memory Bar Component
SVG horizontal stacked bar:
```
┌──────────────────────────────────────────────┐
│  Used (red)  │ Cached (yellow) │ Free (green) │
│   35 MB      │    12 MB        │    81 MB     │
└──────────────────────────────────────────────┘
```
- Widths proportional to percentage of total.
- Smooth width transitions via CSS: `transition: width 300ms`.
- Labels inside or below each segment.

### Step 4.2 — Page Table Diagram
Static SVG diagram with dynamic highlights:
```
┌──────────┐     ┌──────────┐     ┌──────────┐
│ Virtual   │ ──→ │ Page     │ ──→ │ Physical │
│ Address   │     │ Table    │     │ Frame    │
│ 0xABCD   │     │ Entry    │     │ Frame #5 │
└──────────┘     └──────────┘     └──────────┘
```
- Flash red border on page fault (triggered when vmstat `pgfault` delta > 0).
- Display minor fault counter and major fault counter below.

### Step 4.3 — TLB Simulation
Since real TLB data isn't exposed via `/proc`:
- Maintain a simulated TLB cache (Set of ~16 page addresses).
- On each meminfo poll, generate simulated "accesses" based on accessed memory regions.
- First access to a page → MISS (add to TLB set, evict oldest if full).
- Subsequent access → HIT.
- Display last 5 accesses as colored dots (green=HIT, red=MISS).
- Show cumulative hit rate: `hits / (hits + misses) * 100`.

### Step 4.4 — Page Fault Time Series Graph
SVG line chart:
```
Faults │    *
       │   * *        *
       │  *   *      * *
       │ *     *    *   *
       │*       *  *     *
       └─────────────────── Time (30s window)
         Minor (blue)  Major (red)
```
- Store last 10 data points (30 seconds at 3s intervals).
- Plot as SVG `<polyline>` with `points` attribute.
- Delta calculation: `faultDelta = current.pageFaults - previous.pageFaults`.
- Auto-scaling Y axis based on max delta in window.
- Grid lines for readability.

### Step 4.5 — Stress Test Button
```js
const runStressTest = () => {
  sendCommand('dd if=/dev/urandom of=/dev/null bs=1M count=100 &\n');
};
```
- Button styled prominently with warning color.
- On click, inject the `dd` command.
- Expected effect: spike in page faults visible in the graph within 1-2 polling cycles.

### Step 4.6 — Verification Gate
- Memory bar shows real values (non-zero used + free).
- Values update every 3 seconds.
- Page fault counters are non-zero post-boot.
- Graph plots correctly over 30s window.
- Stress test causes observable spike.
- TLB sim shows mixed hits/misses.
- Graceful handling of missing data.

---

## Phase 5: Integration & Layout (Module 5)

### Step 5.1 — React Context for Global State

```jsx
// context/KernelDataContext.js
const KernelDataContext = createContext();

function KernelDataProvider({ children }) {
  const [meminfo, setMeminfo] = useState(null);
  const [vmstat, setVmstat] = useState(null);
  const [procStat, setProcStat] = useState(null);
  const [processes, setProcesses] = useState([]);
  const [bootState, setBootState] = useState('BOOTING');
  const emulatorRef = useRef(null);
  const multiplexerRef = useRef(null);
  // ... single serial multiplexer instance
}
```

### Step 5.2 — Page Layout (`pages/index.js`)

```
┌─────────────────────────────────────────────────────────────┐
│  🔬 KernelScope              Alpine Linux ● Booted          │
├────────────────────────┬────────────────────────────────────┤
│                        │  [CPU Scheduling] [Memory & Paging]│
│                        │ ┌──────────────────────────────────┤
│   V86 Terminal         │ │                                  │
│   (VGA Screen)         │ │  Active Tab Content              │
│                        │ │  (CPUScheduler or                │
│                        │ │   MemoryVisualizer)              │
│                        │ │                                  │
│                        │ │                                  │
├────────────────────────┴─┴──────────────────────────────────┤
│  Status: Polling /proc... | Uptime: 2m 34s                  │
└─────────────────────────────────────────────────────────────┘
```

- Left panel: 40% width, contains `V86Wrapper` screen.
- Right panel: 60% width, tab switcher.
- **Tabs do NOT unmount** — use `display: none` / `visibility: hidden` to keep both components mounted but only one visible.

### Step 5.3 — Boot Overlay
```jsx
{bootState === 'BOOTING' && (
  <div className="boot-overlay">
    <Spinner />
    {bootTime > 30 ? "Still booting, please wait..." : "Booting Alpine Linux..."}
  </div>
)}
```

### Step 5.4 — Error States
- Track consecutive empty `/proc` responses.
- After 3 consecutive empties → show "Kernel not responding" banner.
- v86 init failure → catch in try/catch → show retry button that re-initializes.

### Step 5.5 — Styling
- Dark theme (charcoal background, light text).
- Glassmorphism on panels (semi-transparent backgrounds with backdrop blur).
- Google Font: **Inter** or **JetBrains Mono** for terminal/data feel.
- Smooth transitions on tab switching.
- Color palette:
  - Background: `hsl(220, 15%, 10%)`
  - Panel: `hsla(220, 15%, 18%, 0.8)`
  - Accent green: `hsl(145, 70%, 50%)`
  - Accent red: `hsl(0, 70%, 55%)`
  - Accent yellow: `hsl(45, 90%, 55%)`
  - Text: `hsl(220, 10%, 90%)`

### Step 5.6 — Performance Considerations
- Single `SerialMultiplexer` instance (not per-component).
- `useMemo` / `useCallback` for parsed data to prevent unnecessary re-renders.
- SVG elements keyed by PID for efficient React reconciliation.
- Cleanup intervals on unmount.
- No unnecessary state copies.

### Step 5.7 — Verification Gate (Final Integration)
1. Both tabs switch without killing v86.
2. Data flows to both components simultaneously.
3. Boot overlay appears and disappears correctly.
4. No memory leaks after 2 minutes (stable heap in DevTools).
5. Page loads < 5 seconds.
6. Zero console errors after full boot.

---

## Execution Order Summary

| Step | Phase | Key Deliverable | Est. Complexity |
|------|-------|-----------------|-----------------|
| 1 | Phase 0 | Next.js project + v86 assets downloaded | Low |
| 2 | Phase 1 | V86Wrapper boots Linux, serial capture works | High |
| 3 | Phase 2 | Multiplexer + parsers + periodic injection | Medium |
| 4 | Phase 3 | CPUScheduler SVG visualization | High |
| 5 | Phase 4 | MemoryVisualizer SVG visualization | High |
| 6 | Phase 5 | Full integration, layout, polish | Medium |

## Risk Register

| Risk | Mitigation |
|------|-----------|
| v86 WASM fails to load in Next.js SSR | Load v86 via `<script>` tag, guard all v86 code with `typeof window` checks, use `next/dynamic` with `ssr: false` |
| Serial output is garbled/interleaved | Use sentinel markers (`===START===`/`===END===`) around each command to delimit blocks |
| Buildroot doesn't have expected `/proc` entries | Verify `/proc/meminfo`, `/proc/vmstat`, `/proc/stat` exist in buildroot; fall back to busybox-compatible commands |
| Too many serial commands flood the emulator | Stagger commands (not all at once), use `setTimeout` offsets between injections |
| SVG performance with many process bubbles | Cap at 50 processes, use `will-change: transform` for GPU-accelerated transitions |
| React strict mode double-mounting breaks v86 | Disable strict mode in `next.config.js` |

## Key Design Decisions

1. **Pages Router over App Router** — The spec explicitly uses `/pages/index.js`, so we use Next.js Pages Router.
2. **v86 loaded via script tag** — v86 is not an npm module; it's a browser global loaded from `/public/libv86.js`.
3. **Sentinel-based block parsing** — More reliable than content-sniffing for grouping `/proc` output lines.
4. **CSS transitions over JS animation** — Simpler, GPU-accelerated, 300ms matches spec.
5. **Both tabs stay mounted** — `display: none` prevents v86 crash on tab switch and keeps data flowing.
6. **Single multiplexer via Context** — Prevents duplicate serial listeners and ensures data consistency.
