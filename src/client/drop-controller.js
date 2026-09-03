function chooseDropAction(mode, options = {}) {
  const prefix = mode === 'locate' ? 'locate-' : 'upload-'
  const hasDirectories = options.directoryCount > 0
  const hasFiles = options.fileCount > 0
  if (hasDirectories && hasFiles) return { type: prefix + 'mixed' }
  if (hasDirectories) return { type: prefix + 'directories' }
  if (hasFiles) return { type: prefix + 'files' }
  return { type: 'none' }
}

export { chooseDropAction }
