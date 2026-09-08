// Host metric collectors — dependency-free readings from node:os, node:fs and
// the /proc pseudo-filesystem.
//
// Container note: /proc/stat, /proc/meminfo, /proc/diskstats and /proc/net/dev
// are NOT namespaced by Docker, so these report the VPS host even when the API
// runs in a container. Filesystem usage is the exception — statfs('/') inside a
// container measures the overlay, so DISK_PATH should point at a bind-mounted
// host path (see docs/monitoring.md).
//
// Rate metrics (CPU, disk I/O, network) need two samples. Previous readings are
// kept in module state; the first call takes a short inline second sample so a
// freshly started worker still reports real numbers.

import { readFile, statfs } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'

const SECTOR_BYTES = 512
/** Physical block devices only — skip partitions, loop, ram and device-mapper. */
const PHYSICAL_DEVICE = /^(sd[a-z]+|nvme\d+n\d+|vd[a-z]+|xvd[a-z]+|hd[a-z]+)$/

export const DISK_PATH = process.env.DISK_PATH ?? '/'
const LATENCY_TARGET = process.env.NET_LATENCY_TARGET ?? '1.1.1.1:443'
const FIRST_SAMPLE_MS = 250

const read = async (path: string): Promise<string | null> => readFile(path, 'utf8').catch(() => null)
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// ---------------------------------------------------------------- CPU

interface CpuSample { total: number, idle: number, at: number }
let prevCpu: CpuSample | undefined

async function readCpu (): Promise<CpuSample | null> {
  const stat = await read('/proc/stat')
  const line = stat?.split('\n').find(l => l.startsWith('cpu '))
  if (!line) return null
  // user nice system idle iowait irq softirq steal (guest* are already counted
  // inside user/nice, so they are deliberately excluded from the total)
  const fields = line.trim().split(/\s+/).slice(1, 9).map(Number)
  if (fields.length < 8 || fields.some(Number.isNaN)) return null
  const total = fields.reduce((sum, n) => sum + n, 0)
  const idle = fields[3]! + fields[4]! // idle + iowait
  return { total, idle, at: Date.now() }
}

/** CPU utilisation across all cores, 0-100. */
export async function cpuUsagePct (): Promise<number | null> {
  let previous = prevCpu
  if (!previous) {
    previous = (await readCpu()) ?? undefined
    if (!previous) return null
    await sleep(FIRST_SAMPLE_MS)
  }
  const current = await readCpu()
  if (!current) return null
  prevCpu = current

  const totalDelta = current.total - previous.total
  const idleDelta = current.idle - previous.idle
  if (totalDelta <= 0) return null
  return clamp((1 - idleDelta / totalDelta) * 100)
}

// ---------------------------------------------------------------- memory

export interface MemoryInfo {
  totalBytes: number
  availableBytes: number
  usedBytes: number
  usedPct: number
  swapTotalBytes: number
  swapUsedBytes: number
  swapUsedPct: number
}

export async function memory (): Promise<MemoryInfo> {
  const meminfo = await read('/proc/meminfo')
  const kb = new Map<string, number>()
  for (const line of meminfo?.split('\n') ?? []) {
    const match = line.match(/^(\w+):\s+(\d+) kB$/)
    if (match) kb.set(match[1]!, Number(match[2]))
  }
  const bytes = (key: string): number | undefined => {
    const value = kb.get(key)
    return value === undefined ? undefined : value * 1024
  }

  // MemAvailable is the honest "how much can a new workload get" figure; fall
  // back to os.freemem() (which ignores reclaimable cache) only if unavailable.
  const totalBytes = bytes('MemTotal') ?? os.totalmem()
  const availableBytes = bytes('MemAvailable') ?? os.freemem()
  const usedBytes = Math.max(0, totalBytes - availableBytes)

  const swapTotalBytes = bytes('SwapTotal') ?? 0
  const swapFreeBytes = bytes('SwapFree') ?? 0
  const swapUsedBytes = Math.max(0, swapTotalBytes - swapFreeBytes)

  return {
    totalBytes,
    availableBytes,
    usedBytes,
    usedPct: totalBytes > 0 ? clamp((usedBytes / totalBytes) * 100) : 0,
    swapTotalBytes,
    swapUsedBytes,
    swapUsedPct: swapTotalBytes > 0 ? clamp((swapUsedBytes / swapTotalBytes) * 100) : 0
  }
}

// ---------------------------------------------------------------- disk usage

export interface DiskUsage { path: string, totalBytes: number, freeBytes: number, usedBytes: number, usedPct: number }

export async function diskUsage (path = DISK_PATH): Promise<DiskUsage | null> {
  try {
    const fs = await statfs(path)
    const blockSize = Number(fs.bsize)
    const totalBytes = Number(fs.blocks) * blockSize
    const freeBytes = Number(fs.bfree) * blockSize
    const availBytes = Number(fs.bavail) * blockSize // excludes root-reserved space
    const usedBytes = totalBytes - freeBytes
    const denominator = usedBytes + availBytes // df(1) semantics
    return {
      path,
      totalBytes,
      freeBytes: availBytes,
      usedBytes,
      usedPct: denominator > 0 ? clamp((usedBytes / denominator) * 100) : 0
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- disk I/O

interface DiskIoSample { readBytes: number, writeBytes: number, ios: number, busyMs: number, at: number }
let prevDiskIo: DiskIoSample | undefined

async function readDiskIo (): Promise<DiskIoSample | null> {
  const stats = await read('/proc/diskstats')
  if (!stats) return null
  const sample: DiskIoSample = { readBytes: 0, writeBytes: 0, ios: 0, busyMs: 0, at: Date.now() }
  for (const line of stats.split('\n')) {
    const f = line.trim().split(/\s+/)
    if (f.length < 14 || !PHYSICAL_DEVICE.test(f[2]!)) continue
    sample.readBytes += Number(f[5]) * SECTOR_BYTES  // sectors read
    sample.writeBytes += Number(f[9]) * SECTOR_BYTES // sectors written
    sample.ios += Number(f[3]) + Number(f[7])        // reads + writes completed
    sample.busyMs += Number(f[6]) + Number(f[10])    // ms spent reading + writing
  }
  return sample
}

export interface DiskIo { readBps: number, writeBps: number, iops: number, awaitMs: number | null }

export async function diskIo (): Promise<DiskIo | null> {
  let previous = prevDiskIo
  if (!previous) {
    previous = (await readDiskIo()) ?? undefined
    if (!previous) return null
    await sleep(FIRST_SAMPLE_MS)
  }
  const current = await readDiskIo()
  if (!current) return null
  prevDiskIo = current

  const seconds = (current.at - previous.at) / 1000
  if (seconds <= 0) return null
  const ioDelta = current.ios - previous.ios
  return {
    readBps: Math.max(0, (current.readBytes - previous.readBytes) / seconds),
    writeBps: Math.max(0, (current.writeBytes - previous.writeBytes) / seconds),
    iops: Math.max(0, ioDelta / seconds),
    // average service time per I/O; meaningless with no I/O in the window
    awaitMs: ioDelta > 0 ? Math.max(0, (current.busyMs - previous.busyMs) / ioDelta) : null
  }
}

// ---------------------------------------------------------------- network

interface NetSample { rxBytes: number, txBytes: number, packets: number, drops: number, at: number }
let prevNet: NetSample | undefined

async function readNet (): Promise<NetSample | null> {
  const dev = await read('/proc/net/dev')
  if (!dev) return null
  const sample: NetSample = { rxBytes: 0, txBytes: 0, packets: 0, drops: 0, at: Date.now() }
  for (const line of dev.split('\n').slice(2)) {
    const [rawName, rest] = line.split(':')
    if (!rest) continue
    const name = rawName!.trim()
    if (name === 'lo' || name.startsWith('veth') || name.startsWith('docker') || name.startsWith('br-')) continue
    const f = rest.trim().split(/\s+/).map(Number)
    if (f.length < 16) continue
    sample.rxBytes += f[0]!;  sample.packets += f[1]!; sample.drops += f[3]!
    sample.txBytes += f[8]!;  sample.packets += f[9]!; sample.drops += f[11]!
  }
  return sample
}

export interface NetworkIo { rxBps: number, txBps: number, dropPct: number }

export async function network (): Promise<NetworkIo | null> {
  let previous = prevNet
  if (!previous) {
    previous = (await readNet()) ?? undefined
    if (!previous) return null
    await sleep(FIRST_SAMPLE_MS)
  }
  const current = await readNet()
  if (!current) return null
  prevNet = current

  const seconds = (current.at - previous.at) / 1000
  if (seconds <= 0) return null
  const packetDelta = current.packets - previous.packets
  return {
    rxBps: Math.max(0, ((current.rxBytes - previous.rxBytes) * 8) / seconds),
    txBps: Math.max(0, ((current.txBytes - previous.txBytes) * 8) / seconds),
    // Interface-level drop ratio. This is NOT end-to-end packet loss — it counts
    // frames the kernel dropped on this NIC (saturated link or full queue).
    dropPct: packetDelta > 0 ? clamp(((current.drops - previous.drops) / packetDelta) * 100) : 0
  }
}

// ---------------------------------------------------------------- latency

/**
 * TCP connect round-trip to a public endpoint. Used instead of ICMP ping
 * because the container runs unprivileged and cannot open raw sockets.
 */
export async function networkLatencyMs (target = LATENCY_TARGET, timeoutMs = 2000): Promise<number | null> {
  const [host, port] = target.split(':')
  return new Promise(resolve => {
    const started = process.hrtime.bigint()
    const socket = net.connect({ host: host!, port: Number(port ?? 443) })
    const done = (value: number | null): void => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(Number(process.hrtime.bigint() - started) / 1e6))
    socket.once('timeout', () => done(null))
    socket.once('error', () => done(null))
  })
}

// ---------------------------------------------------------------- host summary

export interface HostSnapshot {
  cpuUsagePct: number | null
  cores: number
  load1: number
  load5: number
  load15: number
  loadPerCore: number
  uptimeSec: number
  memory: MemoryInfo
  disk: DiskUsage | null
  diskIo: DiskIo | null
  network: NetworkIo | null
  netLatencyMs: number | null
}

/** One full host reading. Individual collectors degrade to null, never throw. */
export async function collectHost (): Promise<HostSnapshot> {
  const cores = os.cpus().length || 1
  const [cpu, mem, disk, io, netIo, latency] = await Promise.all([
    cpuUsagePct(), memory(), diskUsage(), diskIo(), network(), networkLatencyMs()
  ])
  const [load1, load5, load15] = os.loadavg()
  return {
    cpuUsagePct: cpu,
    cores,
    load1: load1!, load5: load5!, load15: load15!,
    loadPerCore: load1! / cores,
    uptimeSec: os.uptime(),
    memory: mem,
    disk,
    diskIo: io,
    network: netIo,
    netLatencyMs: latency
  }
}

function clamp (value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value))
}
