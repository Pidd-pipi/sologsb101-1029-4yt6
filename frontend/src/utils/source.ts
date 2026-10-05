/**
 * 提交来源标签：每个浏览器标签页生成一次并保存在 sessionStorage，
 * 同一会话内的录入都带上该标识（如「标签页 A」），跨标签页并发合入后可据此核对来源。
 */
const LABEL_KEY = 'gbcontinuity-client-label'
const LABEL_POOL = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']

function randomPick<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)]
}

export function getClientLabel(): string {
  try {
    const existing = sessionStorage.getItem(LABEL_KEY)
    if (existing) return existing
    const label = `标签页 ${randomPick(LABEL_POOL)}`
    sessionStorage.setItem(LABEL_KEY, label)
    return label
  } catch {
    // sessionStorage 不可用时退回一次性标签
    return `标签页 ${randomPick(LABEL_POOL)}`
  }
}
