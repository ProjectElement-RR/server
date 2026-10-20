// Heap and RSS monitoring.
//
// Two problems in the previous version:
//
//   1. The threshold order made the GC branch unreachable. The checks ran
//      critical -> warning -> gc with thresholds 1536 / 1024 / 1200, so any
//      value above the 1200 MB GC threshold had already matched the 1024 MB
//      warning branch and never reached the GC test. config.js now validates
//      warning < gc < critical at startup, which makes this impossible.
//
//   2. global.gc is only defined under --expose-gc. Neither package.json nor
//      start.bat passed that flag, so the entire GC path was dead code. The
//      flag is now set in the start script, and this module degrades cleanly if
//      it is absent.

const { config } = require('./config');

/** @param {number} bytes @returns {string} */
function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

let monitoringInterval = null;

/**
 * Log current usage and act on the configured thresholds.
 * @returns {object} the stats that were logged
 */
function logMemoryUsage() {
  const usage = process.memoryUsage();
  const usedMb = usage.heapUsed / 1024 / 1024;
  const { warningMb, gcMb, criticalMb } = config.memory;

  console.log(
    `[Memory] heap ${formatBytes(usage.heapUsed)} / ${formatBytes(usage.heapTotal)} | ` +
      `rss ${formatBytes(usage.rss)} | external ${formatBytes(usage.external)}`
  );

  // Ordered by descending threshold, so each branch is reachable.
  if (usedMb > criticalMb) {
    console.error(`[Memory] CRITICAL: heap ${usedMb.toFixed(0)}MB over ${criticalMb}MB`);
    if (global.gc) {
      console.warn('[Memory] Forcing garbage collection');
      global.gc();
    }
  } else if (usedMb > gcMb) {
    if (global.gc) {
      console.log(`[Memory] heap ${usedMb.toFixed(0)}MB over ${gcMb}MB, collecting`);
      global.gc();
    }
  } else if (usedMb > warningMb) {
    console.warn(`[Memory] heap ${usedMb.toFixed(0)}MB over ${warningMb}MB`);
  }

  return getMemoryStats();
}

/**
 * Begin periodic monitoring. Idempotent: calling it twice will not stack
 * intervals, which previously happened because both the master and each worker
 * invoked it.
 * @returns {NodeJS.Timeout|null}
 */
function startMemoryMonitoring() {
  if (monitoringInterval) return monitoringInterval;

  const { warningMb, gcMb, criticalMb } = config.memory;
  console.log(
    `[Memory] Monitoring every ${config.memory.intervalMs}ms ` +
      `(warning ${warningMb}MB < gc ${gcMb}MB < critical ${criticalMb}MB)`
  );

  if (!global.gc) {
    console.log('[Memory] global.gc unavailable - start with --expose-gc to enable forced collection');
  }

  logMemoryUsage();
  monitoringInterval = setInterval(() => {
    try {
      logMemoryUsage();
    } catch (err) {
      console.error('[Memory] Monitor tick failed:', err.message);
    }
  }, config.memory.intervalMs);

  return monitoringInterval;
}

/**
 * Stop periodic monitoring.
 * @returns {void}
 */
function stopMemoryMonitoring() {
  if (!monitoringInterval) return;
  clearInterval(monitoringInterval);
  monitoringInterval = null;
}

/**
 * Current usage, in MB.
 *
 * Previously these were pre-formatted strings ("12.34 MB"), which forced every
 * caller to parse before doing arithmetic. These are numbers now.
 *
 * @returns {{heapUsed:number,heapTotal:number,external:number,rss:number}}
 */
function getMemoryStats() {
  const usage = process.memoryUsage();
  const toMb = (bytes) => Math.round((bytes / 1024 / 1024) * 100) / 100;
  return {
    heapUsed: toMb(usage.heapUsed),
    heapTotal: toMb(usage.heapTotal),
    external: toMb(usage.external),
    rss: toMb(usage.rss)
  };
}

/** @returns {void} */
function forceGarbageCollection() {
  if (!global.gc) {
    console.warn('[Memory] Cannot force GC without --expose-gc');
    return;
  }
  console.log('[Memory] Manual GC requested');
  global.gc();
  logMemoryUsage();
}

module.exports = {
  startMemoryMonitoring,
  stopMemoryMonitoring,
  getMemoryStats,
  logMemoryUsage,
  forceGarbageCollection
};