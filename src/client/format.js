export function formatSize(bytes) {
  if (bytes == null || bytes < 0) return '未知'
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1 }
  return (Number.isInteger(value) ? String(value) : value.toFixed(1)) + ' ' + units[i]
}
