/** Windowing math for the timeline.
 *
 *  Analysis of 10k steps takes ~100ms, but mounting 10k rows (plus 10k overview
 *  ticks) freezes the tab. These two pure functions turn that into bounded DOM:
 *  one renders only the visible slice, the other aggregates the overview strip
 *  into at most `maxBuckets` marks.
 */

import type { Role, Step } from '../core/model'

export interface WindowInput {
  scrollTop: number
  viewportHeight: number
  rowHeight: number
  count: number
  /** Extra rows rendered above and below the viewport. */
  overscan?: number
}

export interface WindowRange {
  /** Inclusive. */
  start: number
  /** Exclusive. */
  end: number
  totalHeight: number
  offsetY: number
}

const DEFAULT_OVERSCAN = 6

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function computeWindow({
  scrollTop,
  viewportHeight,
  rowHeight,
  count,
  overscan = DEFAULT_OVERSCAN,
}: WindowInput): WindowRange {
  if (count <= 0 || rowHeight <= 0) {
    return { start: 0, end: 0, totalHeight: 0, offsetY: 0 }
  }

  const viewport = Math.max(rowHeight, viewportHeight)
  const visible = Math.ceil(viewport / rowHeight)
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight)
  const start = clamp(first - overscan, 0, Math.max(0, count - 1))
  const end = clamp(start + visible + overscan * 2, 0, count)

  return {
    start,
    end,
    totalHeight: count * rowHeight,
    offsetY: start * rowHeight,
  }
}

export interface MapBucket {
  /** Inclusive step index. */
  start: number
  /** Exclusive step index. */
  end: number
  /** Normalised bar height in px. */
  height: number
  role: Role
  error: boolean
}

export interface BucketInput {
  steps: Step[]
  /** Highest per-step token count, used to normalise heights. */
  maxTokens: number
  /** Answers "does this step carry an error-level finding?". */
  hasError: (index: number) => boolean
  maxBuckets?: number
  minHeight?: number
  maxHeight?: number
}

export const DEFAULT_MAX_BUCKETS = 180

export function bucketizeSteps({
  steps,
  maxTokens,
  hasError,
  maxBuckets = DEFAULT_MAX_BUCKETS,
  minHeight = 6,
  maxHeight = 28,
}: BucketInput): MapBucket[] {
  const count = steps.length
  if (count === 0) return []

  const size = Math.max(1, Math.ceil(count / Math.max(1, maxBuckets)))
  const safeMax = Math.max(1, maxTokens)
  const buckets: MapBucket[] = []

  for (let start = 0; start < count; start += size) {
    const end = Math.min(count, start + size)
    let peakTokens = 0
    let peakRole: Role = 'unknown'
    let error = false

    for (let index = start; index < end; index += 1) {
      const step = steps[index]
      if (!step) continue
      if (step.tokens.total >= peakTokens) {
        peakTokens = step.tokens.total
        peakRole = step.role
      }
      if (!error && hasError(index)) error = true
    }

    buckets.push({
      start,
      end,
      role: peakRole,
      error,
      height: minHeight + (peakTokens / safeMax) * (maxHeight - minHeight),
    })
  }

  return buckets
}
