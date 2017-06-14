'use strict';

const path = require('path');
const symlinkOrCopy = require('symlink-or-copy');

module.exports.ROOT = 'root';

module.exports.isDirectory = function(entry) {
  if (entry._symlink && entry._symlink.entry) {
    // All directory symlinks must be root links.
    return entry._symlink.entry === module.exports.ROOT;
  }

  return (entry.mode & 0o170000) === 0o40000;
}

module.exports.isSymlink = function(entry) {
  return !!entry._symlink;
}

module.exports.isFile = function(entry) {
  return !module.exports.isDirectory(entry);
}

module.exports.commonPrefix = function(a, b, term) {
  var max = Math.min(a.length, b.length);
  var end = -1;

  for(var i = 0; i < max; ++i) {
    if (a[i] !== b[i]) {
      break;
    } else if (a[i] === term) {
      end = i;
    }
  }

  return a.substr(0, end + 1);
};

module.exports.basename = function(entry) {
  var path = module.exports.entryRelativePath(entry);
  var end = path.length - 2;
  for(var i = end; i >= 0; --i) {
    if (path[i] === '/') {
      return path.substr(0, i + 1);
    }
  }

  return '';
};

module.exports.chompLeadAndTrailingPathSep = function(path) {
  // strip leading and trailing path.sep (but both seps on posix and win32);
  return path.replace(/^(\/|\\)|(\/|\\)$/g, '');
};

module.exports.chompPathSep = function(path) {
  // strip trailing path.sep (but both seps on posix and win32);
  return path.replace(/(\/|\\)$/, '');
};

module.exports.ensurePathSep = function(inputPath) {
  return inputPath === '' ? '' : `${module.exports.chompPathSep(inputPath)}${path.sep}`;
}

module.exports.entryRelativePath = function(entry) {
  let path = entry.relativePath;
  if (module.exports.isDirectory(entry)) {
    return module.exports.chompPathSep(path);
  }

  return path;
}

// TODO: do we actually have to have Stat and entry2stat?
// it's here because we added support for walksync to accept us (an fs facade)
// as a custom fs API.
//
// This means walksync will be calling statSync on us, and walksync expects the
// stats it gets back to have `mtime`'s that are `Date`s, not `Number`s.
class Stat {
  constructor(size, mtime, mode) {
    this.size = size;
    this.mtime = mtime;
    this.mode = mode;
  }

  isDirectory() {
    return module.exports.isDirectory(this);
  }
}

module.exports.entry2Stat = function(entry) {
  if (!entry) { return entry; }

  return new Stat(
    entry.size,
    new Date(entry.mtime),
    entry.mode
  );
}

module.exports.compareChanges = function(a, b) {
  const operationTypeA = (a[0] === 'rmdir' || a[0] === 'unlink') ? 'remove' : 'add';
  const operationTypeB = (b[0] === 'rmdir' || b[0] === 'unlink') ? 'remove' : 'add';

  if (operationTypeA === 'remove' && operationTypeB === 'add') {
    return -1;
  } else if (operationTypeA === 'add' && operationTypeB === 'remove') {
    return 1;
  }

  // Operation types are now known to be the same, so we only need to check one.
  const desc = operationTypeA === 'remove';

  if (a[1] > b[1]) {
    return desc ? -1 : 1;
  } else if (a[1] < b[1]) {
    return desc ? 1 : -1;
  }

  return 0;
}
