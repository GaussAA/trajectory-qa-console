/** 批量命名：前缀 + 递增序号。
 *
 *  为什么不是「逐条输入」：一次导入十几条时，逐条改名并没有比单条改名更快；
 *  真正需要的是「同一次实验的切片」这类共性与差异——共性进前缀，差异进序号。
 */

export interface BatchNaming {
  prefix: string
  /** 起始序号（含）。 */
  start: number
  /** 序号补零位数；0 表示不补。 */
  pad: number
}

export const BATCH_DEFAULTS: BatchNaming = { prefix: '', start: 1, pad: 2 }

/** 生成 `count` 个名字：`exp-01`、`exp-02`…；前缀为空则只有序号。 */
export function buildBatchNames(count: number, naming: BatchNaming): string[] {
  if (count <= 0) return []
  const total = Math.max(0, Math.floor(count))
  const start = Number.isFinite(naming.start) ? Math.floor(naming.start) : 1
  const pad = Math.max(0, Math.min(6, Math.floor(naming.pad)))
  const prefix = naming.prefix.trim()

  return Array.from({ length: total }, (_, index) => {
    const serial = String(start + index).padStart(pad, '0')
    return prefix === '' ? serial : `${prefix}-${serial}`
  })
}
