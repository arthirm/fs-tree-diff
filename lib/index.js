'use strict';

const fs = require('fs');
const path = require('path-posix');
const assign = require('object-assign');
const symlinkOrCopy = require('symlink-or-copy');
const Entry = require('./entry');
const logger = require('heimdalljs-logger')('fs-tree-diff:');
const util = require('./util');
const treeOptionHelpers = require('./tree-option-helpers');
const md5hex = require('md5hex');
const MatcherCollection = require('matcher-collection');
const existsSync = require('exists-sync');
const walkSync = require('walk-sync');
const Minimatch = require('minimatch').Minimatch;

const compareChanges = util.compareChanges;
const chompPathSep = util.chompPathSep;
const ensurePathSep = util.ensurePathSep;
const entry2Stat = util.entry2Stat;
const sortAndExpand = treeOptionHelpers.sortAndExpand;
const entryRelativePath = util.entryRelativePath;
const validateSortedUnique = treeOptionHelpers.validateSortedUnique;
const isFile = Entry.isFile;
const isDirectory = Entry.isDirectory;
const isSymlink = Entry.isSymlink;
const filterIterable = util.filterIterable;
const mapIterable = util.mapIterable;

const ROOT = util.ROOT;

const DEFAULT_DELEGATE = {
  unlink: function(inputPath, outputPath, relativePath) {
    fs.unlinkSync(outputPath);
  },
  rmdir: function(inputPath, outputPath, relativePath) {
    fs.rmdirSync(outputPath);
  },
  mkdir: function(inputPath, outputPath, relativePath) {
    fs.mkdirSync(outputPath);
  },
  change: function(inputPath, outputPath, relativePath) {
    // We no-op if the platform can symlink, because we assume the output path
    // is already linked via a prior create operation.
    if (symlinkOrCopy.canSymlink) {
      return;
    }

    fs.unlinkSync(outputPath);
    symlinkOrCopy.sync(inputPath, outputPath);
  },
  create: function(inputPath, outputPath, relativePath) {
    symlinkOrCopy.sync(inputPath, outputPath);
  }
};

const DISABLED = 'disabled';
const STARTED = 'started';
const STOPPED = 'stopped';

module.exports = FSTree;

function FSTree(options) {
  options = options || {};

  // A map of relativePath (string) -> filter match (boolean).
  this._filterMatchesCache = new Map();

  // A map of relativePath (string) -> excluded (boolean).  This only tracks
  // directories and only those which match exclude filters.
  this._excludedDirectoriesCache = new Map();

  // Parent -> child relationships must be tracked so that children can update
  // when the parent's entries change.
  this._children = new Set();

  if (options.parent) {
    this.parent = options.parent;
  } else {
    /**
      Indicates whether this tree should act as a source tree.  A source tree is
      one that has to reread its root to discover changes, rather than tracking
      its changes from calls to `mkdirSync`, `writeFileSync` &c.

      There are two kinds of source trees:

        1.  Trees that are no plugin's output, ie the input trees for leaf nodes
            that refer to source directories.
        2.  Trees that are the output of a plugin that does not support the
            fsFacade feature and therefore still uses fs to write.
    */
    this._srcTree = !!options.srcTree;

    if (options.entries) {
      this._scanState = DISABLED;
      this._rawEntries = options.entries;

      if (options.sortAndExpand) {
        sortAndExpand(this._rawEntries);
      } else {
        validateSortedUnique(this._rawEntries);
      }
    } else {
      this._scanState = STOPPED;
    }
  }

  this.cwd = options.cwd;
  this.files = options.files;
  this.exclude = options.exclude;
  this.include = options.include;

  // Ensure the values used by _prev* are the values sanitized by the setters.
  this._prevCwd = this.cwd;
  this._prevFiles = this.files;
  this._prevExclude = this.exclude;
  this._prevInclude = this.include;

  if ('root' in options) {
    validateRoot(options.root);

    this._root = path.normalize(options.root);
  }

  if (!this.parent) {
    if (!this.srcTree) {
      this.start();
   } else {
      // srcTree is true, should not write to a tree.
      this.stop();
    }
  }
}

function validateRoot(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw TypeError(`Root must be an absolute path, tree.root: '${root}'`);
  }
}

FSTree.prototype = {
  get _changes() {
    return this._filterItems(
      // treeToItems
      tree => {
        if (tree.parent) {
          return tree.parent._changes;
        }

        return tree.srcTree ? tree._diffToFindPatches() : tree._rawChanges;
      },
      // itemToEntry
      change => change[2],
      // replaceRelativePath
      (change, relativePath) => [change[0], relativePath, Entry.clone(change[2], relativePath)]);
  },

  get cwd() {
    return this._cwd;
  },

  set cwd(value) {
    this._cwd = ensurePathSep((value || '').replace(/^\//, ''));
  },

  get _entries() {
    this._ensureRootScanned();

    return this._filterItems(
      // treeToItems
      tree => tree.parent ? tree.parent._entries : tree._rawEntries,
      // itemToEntry
      entry => entry,
      // replaceRelativePath
      (entry, relativePath) => Entry.clone(entry, relativePath));
  },

  get exclude() {
    return this._exclude;
  },

  set exclude(value) {
    this._setFilter('exclude', value);
  },

  get files() {
    return this._files;
  },

  set files(value) {
    if (this._scanState === STARTED) {
      throw new Error('Cannot change the files filter once scanning has begun.');
    }

    const newValue = value === undefined ? null : value;
    const oldValue = this._files;

    if (newValue !== null && !Array.isArray(newValue)) {
      throw new Error(`files must be null or an array, got ${value}`);
    }

    if (newValue === oldValue || newValue && oldValue && newValue.length === oldValue.length && newValue.every((v, i) => v === oldValue[i])) {
      // No change; no need to reset caches, etc.
      return;
    }

    this._resetCaches();
    this._files = newValue;
    this._processedFiles = newValue && newValue.map(path => this._normalizePath(path));
  },

  get _hasEntries() {
    if (this.parent) {
      if (!this.parent._hasEntries) {
        return false;
      }
      const result = this.parent.findByRelativePath(this.cwd);
      return result.entry && !result.entry._unscanned;
    }

    return Array.isArray(this._rawEntries);
  },

  get include() {
    return this._include;
  },

  set include(value) {
    this._setFilter('include', value);
  },

  get parent() {
    return this._parent;
  },

  set parent(value) {
    this._resetCaches();

    if (this._parent) {
      this._parent._children.delete(this);
    }

    this._parent = value;

    if (this._parent) {
      this._parent._children.add(this);
    }
  },

  get root() {
    if (this.parent) {
      return ensurePathSep(path.join(this.parent.root, this.cwd));
    }

    return this._root ? ensurePathSep(path.join(this._root, this.cwd)) : '';
  },

  get srcTree() {
    return this.parent ? this.parent.srcTree : this._srcTree;
  },

  /** Get all entries, even those which don't match filters.
   *
   * Still respects CWD.  Also ignores ancestor filters.
   */
  get _unfilteredEntries() {  // TODO: rename?
    this._ensureRootScanned();

    const entries = this.parent ? this.parent._unfilteredEntries : this._rawEntries;
    const filtered = filterIterable(entries, entry => entry.relativePath !== this.cwd && entry.relativePath.startsWith(this.cwd));

    return mapIterable(filtered, entry => Entry.clone(entry, entry.relativePath.replace(this.cwd, '')));
  },
};

FSTree.fromParent = function(tree, options) {
  return new FSTree(Object.assign({}, options || {}, {
    parent: tree,
  }));
};

FSTree.fromPaths = function(paths, options) {
  return new FSTree(Object.assign({}, options || {}, {
    entries: paths.map(e => Entry.fromPath(e)),
  }));
};

FSTree.fromEntries = function(entries, options) {
  return new FSTree(Object.assign({}, options || {}, {
    entries: entries,
  }));
};

// TODO: remove this; _entries isn't guaranteed to be complete unless _ensureAllScanned has been called
Object.defineProperty(FSTree.prototype, 'size', {
  get: function() {
    return Array.from(this._entries).length;
  }
});

FSTree.prototype._setFilter = function(filter, value) {
  if (this._scanState === STARTED) {
    throw new Error(`Cannot change the ${filter} filter once scanning has begun.`);
  }

  const newValue = value || [];
  const oldValue = this[`_${filter}`];

  if (!Array.isArray(newValue)) {
    throw new Error(`${filter} must be an array, got ${value}`);
  }

  if (newValue === oldValue || newValue && oldValue && newValue.length === oldValue.length && newValue.every((v, i) => v === oldValue[i])) {
    // No change; no need to reset caches, etc.
    return;
  }

  this._resetCaches();
  this[`_${filter}`] = newValue;
  this[`_processed${filter.replace(/\w/, c => c.toUpperCase())}`] = newValue.map(matcher => {
    if (typeof matcher === 'string') {
      return new Minimatch(matcher);
    }

    return matcher;
  });
};

FSTree.prototype._hasLinkedEntries = function(tree, relativePath) {
  const entries = Array.from(tree._entries).map(entry => Entry.clone(entry, path.join(relativePath, entry.relativePath)));

  return Array.from(this._filterItems(
    // treeToItems
    tree => tree === this ? entries : tree._entries,  // I reject your entries and substitute my own.
    // itemToEntry
    entry => entry,
    // replaceRelativePath
    (entry, relativePath) => Entry.clone(entry, relativePath)
  )).length > 0;
};

FSTree.prototype._filterItems = function(treeToItems, itemToEntry, replaceRelativePath) {
  let dirStack = [];
  let dirDepth = 0;
  const rawItems = treeToItems(this);

  const iterable = function*() {
    for (let item of rawItems) {
      const entry = itemToEntry(item);

      if (isSymlink(entry) && isDirectory(entry) && this.cwd.startsWith(ensurePathSep(entry.relativePath))) {
        // Can't use chdir, as that calls findByRelativePath, which reads _entries, which calls this.
        const rootedTree = new FSTree({ parent: entry._symlink.tree, cwd: this.cwd.replace(entry.relativePath, '') });

        // Return the items from the target tree, not this one (no items from this tree can match cwd).
        const rootedItems = rootedTree._filterItems(treeToItems, itemToEntry, replaceRelativePath);
        const itemsWithCwd = mapIterable(rootedItems, item => replaceRelativePath(item, path.join(this.cwd, itemToEntry(item).relativePath)));
        const filteredItems = filterIterable(itemsWithCwd, item => this._filterMatches(itemToEntry(item).relativePath));

        for (let change of filteredItems) {
          yield change;
        }

        // This is a temporary tree; remove its parent <-> child relationship so that it can be garbage-collected.
        rootedTree.parent = undefined;

        return;
      }

      if (this._filterMatches(entry.relativePath)) {
        // Add non-matched directories which contain matching files.
        for (let dir of dirStack) {
          if (entry.relativePath.startsWith(ensurePathSep(itemToEntry(dir).relativePath))) {
            yield dir;
          }
        };

        dirStack = [];
        dirDepth = 0;

        // Add matching entry.
        yield item;
      } else if (chompPathSep(entry.relativePath).startsWith(this.cwd)) {
        if (isSymlink(entry) && isDirectory(entry)) {
          // Only include item if it's symlink target contains entries that match all filters.
          if (this._hasLinkedEntries(entry._symlink.tree, entry.relativePath)) {
            yield item;
          }
        } else if (isDirectory(entry)) {
          // Track non-matching directories in case they contain matching files.
          const newDirDepth = getDirDepth(entry.relativePath);

          while (dirStack.length && dirDepth >= newDirDepth) {
            dirStack.pop();
            dirDepth--;
          }

          dirStack.push(item);
          dirDepth = newDirDepth;
        }
      }
    }
  }.call(this);

  return mapIterable(iterable, item => {
    // Remove the cwd from the beginnings of the relativePaths.
    return replaceRelativePath(item, itemToEntry(item).relativePath.replace(this.cwd, ''));
  });
}

FSTree.prototype.addEntries = function(entries, options) {
  if (this.parent) {
    throw new Error('Cannot add entries to a projection.');
  }

  if (!Array.isArray(entries)) {
    throw new TypeError('entries must be an array');
  }

  if (!entries.length) {
    // Nothing to do.
    return;
  }

  if (options && options.sortAndExpand) {
    sortAndExpand(entries);
  } else {
    validateSortedUnique(entries);
  }

  let fromIndex = 0;
  let toIndex = 0;

  while (fromIndex < entries.length) {
    while (toIndex < this._rawEntries.length &&
           entryRelativePath(this._rawEntries[toIndex]) < entryRelativePath(entries[fromIndex])) {
      toIndex++;
    }
    if (toIndex < this._rawEntries.length &&
        entryRelativePath(this._rawEntries[toIndex]) === entryRelativePath(entries[fromIndex])) {
      this._rawEntries.splice(toIndex, 1, entries[fromIndex++]);
    } else {
      this._rawEntries.splice(toIndex++, 0, entries[fromIndex++]);
    }
  }

  this._resetCaches();
};

FSTree.prototype.addPaths = function(paths, options) {
  this._throwIfNotWritable('addPaths');

  this.addEntries(paths.map(e => Entry.fromPath(e)), options);
};

FSTree.prototype.start = function() {
  if (!this.parent && !this.srcTree) {
    this._rawChanges = [];
  }

  this._prevCwd = this.cwd;
  this._prevFiles = this.files;
  this._prevInclude = this.include;
  this._prevExclude = this.exclude;

  this._state = STARTED;
};

FSTree.prototype.stop = function() {
  this._state = STOPPED;
};

FSTree.prototype._normalizePath = function(relativePath) {
  const absolutePath = this.resolvePath(relativePath);

  if (this.root) {
    return path.relative(this.root, absolutePath);
  }

  return path.relative(path.resolve(''), absolutePath);
};

FSTree.prototype.resolvePath = function(relativePath) {
  if (typeof relativePath !== 'string') {
    throw new Error('Relative path must be a string.');
  }

  const root = this.root;
  const resolvedPath = path.resolve(path.join(root, relativePath));

  if (resolvedPath !== chompPathSep(root) && !resolvedPath.startsWith(ensurePathSep(root))) {
    throw new Error(`Invalid path: '${relativePath}' not within root '${root}'`);
  }
  return resolvedPath;
};

FSTree.prototype.findByRelativePath = function(relativePath, options) {
  const normalizedPath = this._normalizePath(relativePath);

  if (normalizedPath === '') {
    return { entry: ROOT, tree: this };
  }

  const applyFilters = options && options.applyFilters !== undefined ? options.applyFilters : true;
  const resolveSymlinks = options && options.resolveSymlinks !== undefined ? options.resolveSymlinks : true;
  const entries = applyFilters ? this._entries : this._unfilteredEntries;

  for (let entry of entries) {
    if (entry._unscanned && normalizedPath.startsWith(ensurePathSep(entry.relativePath))) {
      this._scanDir(entry.relativePath);
      continue;
    }

    const symlink = entry._symlink;

    // The relativePath in entry and relativePath function parameter matches
    if (entryRelativePath(entry) === chompPathSep(normalizedPath)) {
      if (resolveSymlinks && symlink) {
        return symlink;
      }

      return { entry, tree: this };
    }

    if (symlink && normalizedPath.startsWith(ensurePathSep(entry.relativePath))) {
      // find the relativePath with respect to the symlink's entry
      // eg. relativePath = 'a/b/c/foo.js' and symlink's entry is 'd' (c is symlinked to d), with foo.js as its children
      //     search in the symlink for d/foo.js
      const sourceRelativePath = normalizedPath.replace(ensurePathSep(entry.relativePath), '');
      return symlink.tree.findByRelativePath(sourceRelativePath, options);
    }
  };

  return { entry: null, tree: null };
};

FSTree.prototype._getRootStat = function() {
  if (this.parent) {
    return this.parent.statSync(this.cwd);
  }

  if (!this._rootStat) {
    this._rootStat = fs.statSync(this.root);
  }

  return this._rootStat;
};

FSTree.prototype.statSync = function(relativePath) {
  const result = this.findByRelativePath(relativePath);

  if (!result.entry) {
    throw new Error(`ENOENT: no such file or directory, stat '${relativePath}'`);
  }

  return result.entry === ROOT ? result.tree._getRootStat() : entry2Stat(result.entry);
};

FSTree.prototype.existsSync = function(relativePath) {
  let resolvedPath = this.resolvePath(relativePath);

  if (resolvedPath === chompPathSep(this.root) || !this._hasEntries) {
    return fs.existsSync(resolvedPath);
  }

  let result = this.findByRelativePath(relativePath);

  // result.entry.mode === undefined is essentialy isSymlink(result.entry)
  // we can't *actually* check the mode of result.entry b/c it's not the stat
  // info for the symlink b/c walkSync follows symlinks
  if (result.entry && result.entry !== ROOT && result.entry.mode === undefined) {
    return existsSync(resolvedPath);
  }

  return !!result.entry;
};

/** Read the contents of a directory.
 *
 * Returns each of the entries immediately contained by the specified path
 * (i.e. not including the contents of subdirectories).
 */
FSTree.prototype.readdirSync = function(relativePath) {
  // We do this for walk-sync, but once we have globs in projections we'll
  // implement walkSync ourselves
  const result = this.findByRelativePath(relativePath);

  if (!result.entry) {
    throw new Error(`ENOENT: no such file or directory, scandir '${relativePath}'`);
  }

  let tree = result.tree;

  if (result.entry !== ROOT) {
    if (!isDirectory(result.entry)) {
      throw new Error(`ENOTDIR: not a directory, scandir '${relativePath}'`);
    }

    tree = tree.chdir(result.entry.relativePath);
  }

  if (result.entry._unscanned) {
    // Cheap trick: we don't care whether the path is found or not, but
    // findByRelativePath will ensure the correct tree scans the directory.
    this.findByRelativePath(path.join(relativePath, 'foo'));
  }

  const names = Array.from(tree._entries).map(entry => chompPathSep(entry.relativePath)).filter(relativePath => {
    return relativePath.indexOf(path.sep) === -1;
  });

  if (result.entry !== ROOT) {
    // This is a temporary tree; remove its parent <-> child relationship so that it can be garbage-collected.
    tree.parent = undefined;
  }

  return names;
}

FSTree.prototype.walkPaths = function() {
  return this.walkEntries().map(e => e.relativePath);
};

FSTree.prototype.walkEntries = function() {
  this._ensureAllScanned();

  let entries = [];

  for (let entry of this._entries) {
    entries.push(entry);

    if (isSymlink(entry) && isDirectory(entry)) {
      const linkedEntries = entry._symlink.tree.walkEntries().map(linkedEntry => {
        // Prepend CWD and entry relativePath so that we can pass through _filterItems.
        const relativePath = path.join(this.cwd, entry.relativePath, linkedEntry.relativePath);

        return Entry.clone(linkedEntry, relativePath);
      });

      entries = entries.concat(Array.from(this._filterItems(
        // treeToItems
        tree => tree === this ? linkedEntries : tree._entries, // substitute our own set of entries
        // itemToEntry
        entry => entry,
        // replaceRelativePath
        (entry, relativePath) => Entry.clone(entry, relativePath)
      )));
    }
  };

  return entries;
};

function getDirDepth(dirPath){
  return dirPath.split(path.sep).length - 1;
}

FSTree.prototype.changes = function() {
  if (this.srcTree) {
    return this._diffToFindPatches();
  }

  return this._diffFilterChanges().concat(this._processChanges());
};

FSTree.prototype._diffFilterChanges = function() {
  if (this._cwd !== this._prevCwd || this._files !== this._prevFiles || this._include !== this._prevInclude || this._exclude !== this._prevExclude) {
    // Filter changed; must emit changes to match the changes in visible files.
    const prevTree = this.parent ? this.parent.filtered({
      cwd: this._prevCwd,
      files: this._prevFiles,
      include: this._prevInclude,
      exclude: this._prevExclude
    }) : new FSTree({
      entries: this.srcTree ? this._prevEntries || [] : this._rawEntries,
      cwd: this._prevCwd,
      files: this._prevFiles,
      include: this._prevInclude,
      exclude: this._prevExclude
    });
    const currentTree = this.srcTree ? new FSTree({
      entries: this._prevEntries || [],
      cwd: this.cwd,
      files: this.files,
      include: this.include,
      exclude: this.exclude,
    }) : this;

    const changes = prevTree.calculatePatch(currentTree);

    if (prevTree.parent) {
      // This is a temporary tree; remove its parent <-> child relationship so that it can be garbage-collected.
      prevTree.parent = undefined;
    }

    return changes;
  }

  return [];
}

/** Get changes for srcTrees by diffing against a previous set of entries. */
FSTree.prototype._diffToFindPatches = function() {
  return FSTree.fromEntries(this._prevEntries || []).calculatePatch(this);
}

/** Aggregate changes from this tree with symlinked trees. */
FSTree.prototype._processChanges = function() {
  const traversedSymlinks = new Set();
  let combinedChanges = [];

  for (let change of this._changes) {
    combinedChanges.push(change);

    if (isSymlink(change[2]) && isDirectory(change[2])) {
      const linkedChanges = change[2]._symlink.tree.walkEntries().map(entry => {
        const relativePath = path.join(this.cwd, change[2].relativePath, entry.relativePath);

        return [isDirectory(entry) ? 'mkdir' : 'create', relativePath, Entry.clone(entry, relativePath)];
      });

      combinedChanges = combinedChanges.concat(Array.from(this._filterItems(
        // treeToItems
        tree => tree === this ? linkedChanges : tree._changes, // substitute our own set of changes
        // itemToEntry
        change => change[2],
        // replaceRelativePath
        (change, relativePath) => [change[0], relativePath, Entry.clone(change[2], relativePath)]
      )));

      traversedSymlinks.add(change[2].relativePath);
    }
  }

  for (let entry of this._entries) {
    if (isSymlink(entry) && isDirectory(entry) && !traversedSymlinks.has(entry.relativePath)) {
      const linkedChanges = Array.from(entry._symlink.tree.changes()).map(change => {
        if(this.cwd !== '' && !change[2].relativePath.startsWith(this.cwd)) {
          const relativePath = path.join(this.cwd, change[2].relativePath);
          return [change[0], relativePath, Entry.clone(change[2], relativePath)];
         } else {
           return change;
         }
      });

      combinedChanges = combinedChanges.concat(Array.from(this._filterItems(
        // treeToItems
        tree => tree === this ? linkedChanges : tree._changes, // substitute our own set of changes
        // itemToEntry
        change => change[2],
        // replaceRelativePath
        (change, relativePath) => [change[0], relativePath, Entry.clone(change[2], relativePath)]
      )).map(change => {
        const relativePath = path.join(entry.relativePath, change[2].relativePath);

        return [change[0], relativePath, Entry.clone(change[2], relativePath)];
      }));
    }
  }

  // TODO: is this really necessary?
  combinedChanges.sort(compareChanges);

  return combinedChanges;
}

FSTree.prototype.chdir = function(relativePath, options) {
  const allowEmpty = options && options.allowEmpty;
  const result = this.findByRelativePath(relativePath);

  if (result.entry === ROOT) {
    if (result.tree === this) {
      return this;
    }
  } else {
    if (result.entry) {
      if (isFile(result.entry)) {
        throw new Error(`ENOTDIR: not a directory, ${relativePath}`);
      }
    } else if (!allowEmpty) {
      throw new Error(`ENOENT: no such file or directory, ${relativePath}`);
    }
  }

  return FSTree.fromParent(this, {
    cwd: this._normalizePath(relativePath),
  });
};

FSTree.prototype.filtered = function(options) {
  return FSTree.fromParent(this, {
    cwd: options.cwd,
    include: options.include,
    exclude: options.exclude,
    files: options.files,
  });
};

FSTree.prototype.readFileSync = function(relativePath, encoding) {
  const result = this.findByRelativePath(relativePath);

  // if instead of this.root we asked the entry, we could emulate symlinks on
  // readFileSync. (there will be other things to do as well, for example
  // rmdir/unlink etc..
  if (!result.entry) {
    throw new Error(`ENOENT: no such file or directory, open '${relativePath}'`);
  }

  return fs.readFileSync(this.resolvePath(relativePath), encoding);
};

FSTree.prototype._throwIfStopped = function(operation) {
  if (this._state === STOPPED) {
    throw new Error(`Cannot '${operation}' on a stopped tree.`);
  }
}

FSTree.prototype._throwIfNotWritable = function(operation, relativePath, allowRoot) {
  if (this.parent) {
    throw new Error(`Cannot '${operation}' on a projection.`);
  }

  this._throwIfStopped(operation);

  if (typeof relativePath !== 'undefined') {
    const normalizedPath = this._normalizePath(relativePath);

    if (!allowRoot || normalizedPath !== '') {
      if (normalizedPath === '') {
        throw new Error('Cannot overwrite the tree\'s root.');
      }

      if (operation !== 'mkdirp') {
        const parentResult = this.findByRelativePath(path.dirname(normalizedPath), { applyFilters: false });

        if (!parentResult.entry) {
          throw new Error(`ENOENT: no such file or directory, ${operation} '${relativePath}'`);
        }

        if (this !== parentResult.tree) {
          throw new Error(`Cannot write across symlinks, '${relativePath}'`);
        }
      }
    }
  }
};

FSTree.prototype.unlinkSync = function(relativePath) {
  this._throwIfNotWritable('unlink', relativePath);

  const result = this.findByRelativePath(relativePath, { resolveSymlinks: false });

  if (!result.entry) {
    throw new Error(`ENOENT: no such file or directory, unlink '${relativePath}'`)
  }

  fs.unlinkSync(this.resolvePath(relativePath));
  this._track('unlink', result.entry);
  this._removeEntry(result.entry);
};

FSTree.prototype.rmdirSync = function(relativePath) {
  this._throwIfNotWritable('rmdir', relativePath);

  const result = this.findByRelativePath(relativePath);
  const entry = result.entry;

  if (!entry) {
    throw new Error(`ENOENT: no such file or directory, rmdir '${relativePath}'`);
  }

  if (!isDirectory(entry)) {
    throw new Error(`ENOTDIR: not a directory, rmdir '${relativePath}'`);
  }

  fs.rmdirSync(result.tree.resolvePath(entry.relativePath));
  result.tree._track('rmdir', entry);
  result.tree._removeEntry(entry);
};

FSTree.prototype.mkdirSync = function(relativePath) {
  this._throwIfNotWritable('mkdir', relativePath);

  const result = this.findByRelativePath(relativePath, { applyFilters: false });

  if (result.entry) {
    if (isDirectory(result.entry)) {
      logger.info('mkdirSync %s noop, directory exists', relativePath);

      return;
    } else {
      throw new Error(`EEXIST: file already exists, mkdir '${relativePath}'`);
    }
  }

  const normalizedPath = this._normalizePath(relativePath);

  fs.mkdirSync(this.resolvePath(normalizedPath));
  const entry = new Entry(normalizedPath, 0, Date.now(), Entry.DIRECTORY_MODE, null);

  this._track('mkdir', entry);
  this._insertEntry(entry);
};

FSTree.prototype.mkdirpSync = function(relativePath) {
  this._throwIfNotWritable('mkdirp', relativePath);

  const result = this.findByRelativePath(relativePath, { applyFilters: false });

  if (result.entry) {
    if (result.entry === ROOT || isDirectory(result.entry)) {
      logger.info('mkdirpSync %s noop, directory exists', relativePath);

      return;
    } else {
      throw new Error(`EEXIST: file already exists, mkdirp '${relativePath}'`);
    }
  }

  const subpaths = [];
  const tokens = relativePath.split(path.sep);

  // TODO: Its O(N2) should change it to O(N)
  for (let i = 0; i < tokens.length; i++) {
    if (i === 0) {
      subpaths[i] = tokens[i];
    } else {
      subpaths[i] = path.join(subpaths[i - 1], tokens[i]);
    }

    if (!this.findByRelativePath(subpaths[i]).entry) {
      this.mkdirSync(subpaths[i]);
    }
  }
};

FSTree.prototype.writeFileSync = function(relativePath, content, options) {
  this._throwIfNotWritable('writeFile', relativePath);

  const normalizedPath = this._normalizePath(relativePath);

  if (!this._filterMatches(normalizedPath)) {
    throw new Error(`Cannot write file which does match current filters '${relativePath}'`);
  }

  const result = this.findByRelativePath(normalizedPath);

  let entry = result.entry;
  // ensureFile, so throw if the entry is a directory
  let mode;
  // TODO: cleanup idempotent stuff
  const checksum = md5hex('' + content);

  if (entry) {
    mode = entry.mode;

    if (!entry.checksum) {
      // lazily load checksum
      entry.checksum = md5hex(fs.readFileSync(this.resolvePath(normalizedPath), 'UTF8'));
    }

    if (entry.checksum === checksum) {
      // do nothin
      logger.info('writeFileSync %s noop, checksum did not change: %s === %s', relativePath, checksum, entry.checksum);

      return;
    };
  }

  fs.writeFileSync(this.resolvePath(normalizedPath), content, options);
  entry = new Entry(normalizedPath, content.length, Date.now(), mode || 0, checksum);
  var operation = result.entry ? 'change' : 'create';

  this._track(operation, entry);
  this._insertEntry(entry);
};

FSTree.prototype.symlinkSync = function(target, relativePath) {
  this._throwIfNotWritable('symlink', relativePath);

  const result = this.findByRelativePath(relativePath);

  if (result.entry) {
    throw new Error(`EEXIST: file already exists, symlink '${target}' -> '${relativePath}'`);
  }

  const normalizedPath = this._normalizePath(relativePath);

  symlinkOrCopy.sync(target, this.resolvePath(normalizedPath));

  // TODO: should we read the file here so our entry has size, mode & checksum?
  // this turns 1 io -> 2 io (symlink -> symlink + stat)

  const entry = new Entry(normalizedPath, 0, Date.now(), 0);

  this._track('create', entry);
  this._insertEntry(entry);
};

FSTree.prototype.symlinkSyncFromEntry = function(srcFSTree, srcRelativePath, destRelativePath) {
  const destNormalizedPath = this._normalizePath(destRelativePath === '/' ? '' : destRelativePath);
  const srcNormalizedPath = srcFSTree._normalizePath(srcRelativePath === '/' ? '' : srcRelativePath);

  this._throwIfNotWritable('symlinkSyncFromEntry', destNormalizedPath, true);

  if (destNormalizedPath === '') {
    logger.info('Adding parent to existing tree from symlinkSyncFromEntry');

    if (Array.from(this._unfilteredEntries).length) {
      throw new Error('ENOTEMPTY: directory not empty, rmdir \'\'');
    }

    fs.rmdirSync(this.root);
    symlinkOrCopy.sync(srcFSTree.resolvePath(srcRelativePath), this.root);

    this.parent = srcFSTree.chdir(srcNormalizedPath);

    return;
  }

  const srcResult = srcFSTree.findByRelativePath(srcNormalizedPath);

  if (!srcResult.entry) {
    throw new Error(`ENOENT: no such file or directory, symlink '${srcRelativePath}' -> '${destRelativePath}'`);
  }

  const destResult = this.findByRelativePath(destNormalizedPath);

  if (destResult.entry) {
    throw new Error(`EEXIST: file already exists, symlink '${srcRelativePath}' -> '${destRelativePath}'`);
  }

  let mode;
  let operation;
  let symlink;

  if (srcResult.entry === ROOT || isDirectory(srcResult.entry)) {
    mode = Entry.DIRECTORY_MODE;
    operation = 'mkdir';
    symlink = { tree: srcFSTree.chdir(srcNormalizedPath), entry: ROOT };
  } else {
    mode = 0;
    operation = 'create';
    symlink = srcResult;
  }

  symlinkOrCopy.sync(srcFSTree.resolvePath(srcRelativePath), this.resolvePath(destNormalizedPath));

  const entry = new Entry(destNormalizedPath, 0, Date.now(), mode, null);

  entry._symlink = symlink;

  this._track(operation, entry);
  this._insertEntry(entry);
};

FSTree.prototype.undoRootSymlink = function() {
  this._throwIfStopped('undoRootSymlink');

  if (!this.parent) {
    logger.info('No parent to remove.');

    return;
  }

  if (!this._root) {
    throw new Error('Cannot remove a projection\'s parent if it has no root to fall back on.');
  }

  this.parent = undefined;

  fs.unlinkSync(chompPathSep(this.root));
  fs.mkdirSync(this.root);
};

FSTree.prototype.emptySync = function(relativePath) {
  this._throwIfNotWritable('empty', relativePath, true);

  const result = this.findByRelativePath(relativePath);

  if (!result.entry || result.entry !== ROOT && !isDirectory(result.entry)) {
    throw new Error(`ENOTDIR: not a directory, empty '${relativePath}'`);
  }

  let unfilteredEntries;
  let tempTree;

  // ROOT means the root of *this* tree, as crossing symlinks is already forbidden by _throwIfNotWritable.
  if (result.entry === ROOT) {
    unfilteredEntries = Array.from(this._unfilteredEntries);
  } else {
    tempTree = this.chdir(result.entry.relativePath);
    tempTree._ensureAllScanned();
    unfilteredEntries = Array.from(tempTree._unfilteredEntries).map(entry => {
      return Entry.clone(entry, path.join(result.entry.relativePath, entry.relativePath));
    });
  }

  unfilteredEntries.reverse().forEach(entry => {
    if (isSymlink(entry) || isFile(entry)) {
      this.unlinkSync(entry.relativePath);
    } else {
      this.rmdirSync(entry.relativePath);
    }
  });

  if (tempTree) {
    // This is a temporary tree; remove its parent <-> child relationship so that it can be garbage-collected.
    tempTree.parent = undefined;
  }
};

/**
  reread this tree's root directory, if necessary.  The root directory may also
  have changed.  Note that just as with initial reading, rereading is done lazily.

  This is used when we are not able to track our changes, because our root is
  written to directly, rather than via this facade.  This can happen because either:

    a) our root is a source directory or
    b) our root is the outputPath of a plugin that does not yet utilize this fs facade for writing

  Root changes are discouraged but are supported because broccoli-plugin
  supports plugins with unstable output paths.  Such plugins' out trees will
  necessarily be treated as source trees as those plugins will not be fs facade
  aware, which is why it is an error to change the root of a non-source tree.
*/
FSTree.prototype.reread = function(newRoot) {
  if (!this.parent) {
    if (typeof newRoot !== 'undefined') {
      const resolvedRoot = path.normalize(path.resolve(newRoot));

      if (this.srcTree) {
        // root can be changed for srcTree
        this._root = resolvedRoot;
      } else if (ensurePathSep(resolvedRoot) !== this.root) {
        throw new Error(`Cannot change root from '${this.root}' to '${newRoot}' of a non-source tree.`);
      } else {
        // noop for non-srcTree if the root matches
        return;
      }
    } else if (!this.srcTree) {
      // noop for non-srcTree if root is not changed
      return;
    }
  }

  if (this.srcTree) {
    this._resetCaches();
    this._children.forEach(child => child.reread());

    // stash current entries so we can calculate a diff
    this._prevEntries = this._hasEntries ? Array.from(this._entries) : [];

    this._scanState = STOPPED;

    // don't eagerly read, but invalidate our current entries
    delete this._rawEntries;
  }
};

FSTree.prototype._scanDir = function(rootRelativePath) {

  if (this.parent) {
    this.parent._scanDir(path.join(this.cwd, rootRelativePath));
    return;
  }

  if (!Array.isArray(this._rawEntries)) {
    throw new Error('Entries array missing.  Ensure the root has been scanned.');
  }

  const entries = [];
  const rawPath = path.join(this.cwd, rootRelativePath);
  const resolvedPath = path.join(this._root, rawPath);

  // '' has no entry for tracking whether it has been scanned.
  if (rootRelativePath !== '') {
    let entry = this._rawEntries.find(entry => chompPathSep(entry.relativePath) === rawPath);

    if (!entry) {
      // throw new Error(`Could not find entry for '${rootRelativePath}'.  Ensure its parent has been scanned.`);
      let parentPath = path.dirname(rootRelativePath);
      if(parentPath != '.') {
      this._scanDir(path.dirname(rootRelativePath));
      entry = this._rawEntries.find(entry => chompPathSep(entry.relativePath) === rawPath);
      }
    }

    if (!entry._unscanned) {
      // Nothing to do.
      return;
    }

    delete entry._unscanned;
  }

  // Would prefer const, but then we'd have to wrap everything in a single try/catch.
  let names;

  try {
    names = fs.readdirSync(resolvedPath);
  } catch (ex) {
    if (/^ENOENT\b/.test(ex.message)) {
      // This is typically caused by a projection whose CWD has been deleted from the root.
      logger.info(`Cannot scan missing directory '${rootRelativePath}'.`)

      return;
    }

    throw ex;
  }

  names.forEach(name => {
    const relativePath = path.join(this.cwd, rootRelativePath, name);
    const stats = fs.statSync(path.join(this.root, rootRelativePath, name));
    const entry = new Entry(relativePath, stats.size, stats.mtime, stats.mode);

    if (stats.isDirectory()) {
      entry._unscanned = true;

      if (!this._shouldExclude(relativePath)) {
        entries.push(entry);
      }
    } else {
      if (this._filterMatches(relativePath)) {
        entries.push(entry);
      }
    }
  });

  if (entries.length) {
    this.addEntries(entries);
  }
};

FSTree.prototype._ensureAllScanned = function() {
  if (this.parent) {
    this.parent._ensureAllScanned();

    return;
  }

  this._ensureRootScanned();

  for (let entry of this._rawEntries) {
    if (entry._unscanned) {
      this._scanDir(entry.relativePath);
    }
  }
};

FSTree.prototype._ensureDirScanned = function(relativePath) {
  const result = this.findByRelativePath(relativePath);

  if (result.entry === ROOT) {
    result.tree._ensureRootScanned();
  } else if (result.entry && result.entry._unscanned) {
    result.tree._scanDir(result.entry.relativePath);
  }
};

FSTree.prototype._ensureRootScanned = function() {
  if (this._hasEntries) {
    return;
  }

  if (this.parent) {
    this.parent._ensureDirScanned(this.cwd);
    return;
  }

  // No matter how the root entries are obtained, "scanning" has started.
  this._scanState = STARTED;

  if (this.files && !this.include.length && !this.exclude.length) {
    this._rawEntries = this._processedFiles.map(e => Entry.fromPath(path.join(this.cwd, e)));
    sortAndExpand(this._rawEntries);

    return;
  }

  this._rawEntries = [];

  if (this.root) {
    this._scanDir('');
  }
};

FSTree.prototype._track = function(operation, entry) {
  //If operation is 'create', check if there is an 'unlink' for the same entry.
  //If yes then remove 'unlink' and make it to 'change'. This is done because 
  //if the persistent filter recieves a 'change' then it reads the content of the file to see if
  //anything has changed. If nothing has changed it skips from doing any IO. But when doing 'unlink' and 
  //'create' this check cannot be done which results in more IO's.

  if(operation === 'create' && this._rawChanges.length > 0) {
    this._rawChanges.map((change, i) => { 
      if(change[0] === 'unlink' && change[1] === entryRelativePath(entry)) {
        this._rawChanges.splice(i, 1);
        operation = 'change';
      }
    });
  }

  this._rawChanges.push([
    operation,
    entryRelativePath(entry),
    entry,
  ]);
};

FSTree.prototype._insertEntry = function(entry) {
  // find appropriate position
  // TODO: experiment with binary search since entries are sorted, (may be a perf win)
  for (let position = 0; position < this._rawEntries.length; position++) {
    let current = this._rawEntries[position];
    let currentPath = entryRelativePath(current);
    //TODO: shd call the entryRelativePathWalksyncWithTrailingSlash instead of entryRelativePath
    let entryPath = entryRelativePath(entry);

    if (currentPath === entryPath) {
      // replace
      this._rawEntries[position] = entry;

      return position;
    } else if (currentPath > entryPath) {
      // insert before
      this._rawEntries.splice(position, 0, entry);

      return position;
    } else {
      // do nothing, still waiting to find the right place
    }
  }

  // we are at the end, and have not yet found an appropriate place, this
  // means the end is the appropriate place
  return this._rawEntries.push(entry);
};

FSTree.prototype._removeEntry = function(entry) {
  if (!entry) {
    throw new Error('No entry provided for removal.');
  }

  if (entry === ROOT) {
    throw new Error('Cannot remove a "root" entry.')
  }

  for (let position = 0; position < this._rawEntries.length; ++position) {
    const current = this._rawEntries[position];

    if (entryRelativePath(current) === entryRelativePath(entry)) {
      this._rawEntries.splice(position, 1);

      return;
    }
  }
};

function match(path, matcher) {
  if (matcher instanceof RegExp) {
    return matcher.test(path);
  } else if (matcher instanceof Minimatch) {
    return matcher.match(path);
  } else if (typeof matcher === 'function') {
    return matcher(path);
  }

  throw new Error(`Matcher must be a Minimatch, RegExp, string, or function.  Got '${matcher}'.`);
}

// TODO: split into _resetFilterCaches/_resetAllCaches
FSTree.prototype._resetCaches = function() {
  // Reset cache of which entries match filters.
  this._filterMatchesCache.clear();

  // Reset the cache of which directories have been excluded.
  this._excludedDirectoriesCache.clear();

  // TODO: reset cached _entries
  // TODO: reset cached _changes

  this._children.forEach(child => child._resetCaches());
};

FSTree.prototype._filterMatches = function(relativePath) {
  if (!this._filterMatchesCache.has(relativePath)) {
    const doesMatch = filterMatches(relativePath, this._excludedDirectoriesCache, this.cwd, this._processedFiles, this._processedInclude, this._processedExclude);

    this._filterMatchesCache.set(relativePath, doesMatch);
  }

  return this._filterMatchesCache.get(relativePath);
};

FSTree.prototype._shouldExclude = function(relativePath) {
  // Not cached because this should be called only once per path, per build.
  return shouldExclude(relativePath, this._excludedDirectoriesCache, this._processedExclude);
};

function filterMatches(relativePath, excludedDirectoriesCache, cwd, files, include, exclude) {
  // exclude if outside of cwd
  if (!relativePath.startsWith(cwd) || cwd === ensurePathSep(relativePath)) {
    return false;
  }

  if (files && (include.length || exclude.length)) {
    throw new Error('Cannot pass files option and a include/exlude filter. You can only have one or the other');
  }

  if (cwd) {
    relativePath = relativePath.replace(cwd, '');
  }

  // include only if it matches an entry in files
  if (files) {
    return files.map(chompPathSep).indexOf(chompPathSep(relativePath)) > -1;
  }

  if (shouldExclude(relativePath, excludedDirectoriesCache, exclude)) {
    return false;
  }

  if (include.length > 0) {
    // exclude unless matched by something in includes
    if (include.every(matcher => !match(relativePath, matcher))) {
      return false;
    }
  }

  return true;
}

function shouldExclude(relativePath, excludedDirectoriesCache, exclude) {
  if (exclude.length > 0) {
    // exclude if any ancestor directory matches anything in exclude
    let currentDir = path.dirname(relativePath);

    while (currentDir !== '.') {
      if (!excludedDirectoriesCache.has(currentDir)) {
        excludedDirectoriesCache.set(currentDir, exclude.some(matcher => match(currentDir, matcher)));
      }

      if (excludedDirectoriesCache.get(currentDir)) {
        return true;
      }

      currentDir = path.dirname(currentDir);
    }

    // exclude if matched by anything in exclude
    if (exclude.some(matcher => match(relativePath, matcher))) {
      return true;
    }
  }

  return false;
}

FSTree.prototype.calculatePatch = function(otherFSTree, isEqual) {
  if (arguments.length > 1 && typeof isEqual !== 'function') {
    throw new TypeError('calculatePatch\'s second argument must be a function');
  }

  if (typeof isEqual !== 'function') {
    isEqual = FSTree.defaultIsEqual;
  }

  let ours = this.walkEntries();
  let theirs = otherFSTree.walkEntries();
  let additions = [];

  let i = 0;
  let j = 0;

  let removals = [];

  while (i < ours.length && j < theirs.length) {
    let x = ours[i];
    let y = theirs[j];
    let xpath = entryRelativePath(x);
    let ypath = entryRelativePath(y);

    if (xpath < ypath) {
      // ours
      i++;

      removals.push(removeCommand(x));

      // remove additions
    } else if (xpath > ypath) {
      // theirs
      j++;
      additions.push(addCommand(y));
    } else {
      if (!isEqual(x, y)) {
        let xFile = isFile(x);
        let yFile = isFile(y);

        if(xFile === yFile) {
          // file -> file update or directory -> directory update
          additions.push(updateCommand(y));
        } else {
          // file -> directory or directory -> file
          removals.push(removeCommand(x));
          additions.push(addCommand(y));
        }
      }
      // both are the same
      i++; j++;
    }
  }

  // cleanup ours
  for (; i < ours.length; i++) {
    removals.push(removeCommand(ours[i]));
  }

  // cleanup theirs
  for (; j < theirs.length; j++) {
    additions.push(addCommand(theirs[j]));
  }

  // operations = removals (in reverse) then additions
  return removals.reverse().concat(additions);
};

FSTree.prototype.calculateAndApplyPatch = function(otherFSTree, input, output, delegate) {
  const patch = this.calculatePatch(otherFSTree);

  FSTree.applyPatch(input, output, patch, delegate);
};

FSTree.defaultIsEqual = function defaultIsEqual(entryA, entryB) {
  if (isDirectory(entryA) && isDirectory(entryB)) {
    // ignore directory changes by default
    return true;
  }

  var equal = entryA.size === entryB.size &&
       +entryA.mtime === +entryB.mtime &&
       entryA.mode === entryB.mode;


  if (!equal) {
    logger.info('invalidation reason: \nbefore %o\n entryB %o', entryA, entryB);
  }

  return equal;
};

FSTree.applyPatch = function(input, output, patch, _delegate) {
  const delegate = assign({}, DEFAULT_DELEGATE, _delegate);

  for (let i = 0; i < patch.length; i++) {
    applyOperation(input, output, patch[i], delegate);
  }
};

function applyOperation(input, output, operation, delegate) {
  var method = operation[0];
  var relativePath = operation[1];
  var inputPath = path.join(input, relativePath);
  var outputPath = path.join(output, relativePath);

  var delegateType = typeof delegate[method];
  if (delegateType === 'function') {
    delegate[method](inputPath, outputPath, relativePath);
  } else {
    throw new Error('Unable to apply patch operation: ' + method + '. The value of delegate.' + method + ' is of type ' + delegateType + ', and not a function. Check the `delegate` argument to `FSTree.prototype.applyPatch`.');
  }
}

function addCommand(entry) {
  return [isDirectory(entry) ? 'mkdir' : 'create', entryRelativePath(entry), entry];
}

function removeCommand(entry) {
  return [isDirectory(entry) ? 'rmdir' : 'unlink', entryRelativePath(entry), entry];
}

function updateCommand(entry) {
  return ['change', entryRelativePath(entry), entry];
}
