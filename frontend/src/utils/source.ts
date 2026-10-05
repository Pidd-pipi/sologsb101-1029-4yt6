/**
 * 写入来源留痕：区分多标签页并为旧数据 / 播种 / 导入补齐来源。
 * 每个浏览器标签页在 sessionStorage 中持有独立短 id，关签即失效，重新打开另取。
 */

const STORAGE_KEY = 'gbcontinuity-tab-id'

/** 旧数据（v1 迁移）与系统写入使用的固定来源 */
export const SOURCE_LEGACY = '历史数据'
export const SOURCE_SEED = '演示播种'
export const SOURCE_IMPORT = '备份导入'

function randomShort(): string {
  return Math.random().toString(36).slice(2, 6).toUpperCase()
}

/** 当前标签页短标识（如 A1B2），sessionStorage 在标签页内持久、标签页间隔离 */
export function tabId(): string {
  try {
    const existing = sessionStorage.getItem(STORAGE_KEY)
    if (existing) return existing
    const next = randomShort()
    sessionStorage.setItem(STORAGE_KEY, next)
    return next
  } catch {
    // 隐私模式等场景下 sessionStorage 不可用时退化为内存随机值
    return randomShort()
  }
}

/** 写入留痕的完整来源描述 */
export function currentSource(): string {
  return `标签页 ${tabId()}`
}
