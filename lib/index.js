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
const merge = require('lodash.merge');
const existsSync = require('exists-sync');
const walkSync = require('walk-sync');
const Minimatch = require('minimatch').Minimatch;
const symlink = util.symlink;

const changeComparator = util.changeComparator;
const chompPathSep = util.chompPathSep;
const chompLeadAndTrailingPathSep = util.chompLeadAndTrailingPathSep;
const lchompPathStart = util.lchompPathStart;
const entry2Stat = util.entry2Stat;
const sortAndExpand = treeOptionHelpers.sortAndExpand;
const entryRelativePath = util.entryRelativePath;
const sortPatches = util.sortPatches;
const validateSortedUnique = treeOptionHelpers.validateSortedUnique;
const isFile = Entry.isFile;
const isDirectory = Entry.isDirectory;

const ROOT = 'root';

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

  if (options.parent) {
    this.parent = options.parent;
  } else {
    this.parent = null;

    if (options.entries) {
      this._rawEntries = options.entries;

      if (options.sortAndExpand) {
        sortAndExpand(this._rawEntries);
      } else {
        validateSortedUnique(this._rawEntries);
      }
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

  if ('root' in options) {
    validateRoot(options.root);

    this._root = path.normalize(options.root);
  }

  if (!this.parent) {
    this._rawChanges = [];

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

function ensureTrailingSlash(inputPath) {
  return inputPath === '' ? '' : `${chompPathSep(inputPath)}${path.sep}`;
}

FSTree.prototype = {
  get _changes() {
    const filteredChanges = this._filterItems(
      // treeToItems
      tree => {
        if (tree.parent) {
          return tree.parent._changes;
        }
        
        // Attempting to read _changes on a srcTree occurs when a CWD on a non-srcTree crosses a symlink into a srcTree.
        return tree.srcTree ? tree._diffToFindPatches() : tree._rawChanges;
      },
      // itemToEntry
      change => change[2],
      // entryToItem
      entry => [isDirectory(entry) ? 'mkdir' : 'create', entry.relativePath, entry],
      // replaceRelativePath
      (change, relativePath) => [change[0], relativePath, Entry.clone(change[2], relativePath)]);

    return filteredChanges.map(change => {
      const clonedEntry = Entry.clone(change[2], change[2].relativePath.replace(this.cwd, ''));

      return [change[0], change[1].replace(this.cwd, ''), clonedEntry];
    });
  },

  get cwd() {
    return this._cwd;
  },

  set cwd(value) {
    this._cwd = ensureTrailingSlash((value || '').replace(/^\//, ''));
  },

  get _entries() {
    this._ensureEntriesPopulated();

    const filteredEntries = this._filterItems(
      // treeToItems
      tree => tree.parent ? tree.parent._entries : tree._rawEntries,
      // itemToEntry
      entry => entry,
      // entryToItem
      entry => entry,
      // replaceRelativePath
      (entry, relativePath) => Entry.clone(entry, relativePath));

    return filteredEntries.map(entry => Entry.clone(entry, entry.relativePath.replace(this.cwd, '')));
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
    const newValue = value === undefined ? null : value;

    if (newValue !== null && !Array.isArray(newValue)) {
      throw new Error(`files must be null or an array, got ${value}`);
    }

    // TODO: compare if newValue is deep equal to old value?

    this._resetCaches();
    this._files = newValue;
  },

  get _hasEntries() {
    return this.parent ? this.parent._hasEntries : Array.isArray(this._rawEntries);
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
    this._parent = value;
  },

  get root() {
    if (this.parent) {
      return ensureTrailingSlash(path.join(this.parent.root, this.cwd));
    }

    return this._root ? ensureTrailingSlash(this._root) : '';
  },

  get srcTree() {
    return this.parent ? this.parent.srcTree : this._srcTree;
  },

  /** Get all entries, even those which don't match filters.
   * 
   * Still respects CWD.  Also ignores ancestor filters.
   */
  get _unfilteredEntries() {  // TODO: rename?
    this._ensureEntriesPopulated();

    const entries = this.parent ? this.parent._unfilteredEntries : this._rawEntries;

    return entries.filter(entry => {
      return entry.relativePath.startsWith(this.cwd);
    }).map(entry => Entry.clone(entry, entry.relativePath.replace(this.cwd, '')));
  },
};

FSTree.fromParent = function(tree, options) {
  return new FSTree(Object.assign({}, options || {}, {
    parent: tree,
  }));
};

FSTree.fromPaths = function(paths, options) {
 // return new FSTree(merge(options || {}, {
  return new FSTree(Object.assign({}, options || {}, {
    entries: paths.map(e => Entry.fromPath(e)),
  }));
};

FSTree.fromEntries = function(entries, options) {
  //return new FSTree(merge(options || {}, {
  return new FSTree(Object.assign({}, options || {}, {
    entries: entries,
  }));
};

Object.defineProperty(FSTree.prototype, 'size', {
  get: function() {
    return this._entries.length;
  }
});

FSTree.prototype._setFilter = function(filter, value) {
  const newValue = value || [];

  if (!Array.isArray(newValue)) {
    throw new Error(`${filter} must be an array, got ${value}`);
  }

  // TODO: compare if newValue is deep equal to old value?

  this._resetCaches();
  this[`_${filter}`] = newValue;
};

FSTree.prototype._getLinkedEntries = function(tree, relativePath) {
  const entries = tree._entries.map(entry => Entry.clone(entry, path.join(relativePath, entry.relativePath)));

  return this._filterItems(
    // treeToItems
    tree => tree === this ? entries : tree._entries,  // I reject your entries and substitute my own.
    // itemToEntry
    entry => entry,
    // entryToItem
    entry => entry,
    // replaceRelativePath
    (entry, relativePath) => Entry.clone(entry, relativePath)
  );
}

FSTree.prototype._filterItems = function(treeToItems, itemToEntry, entryToItem, replaceRelativePath) {
  let dirStack = [];
  let dirDepth = 0;
  let filteredItems = [];
  const explicitlyMatchedItems = new Set();
  const rawItems = treeToItems(this);
  
  for (let i = 0; i < rawItems.length; i++) {
    const item = rawItems[i];
    const entry = itemToEntry(item);

    if (entry._symlink && this.cwd.startsWith(ensureTrailingSlash(entry.relativePath))) {
      // Can't use chdir, as that calls findByRelativePath, which reads _entries, which calls this.
      const rootedTree = new FSTree({ parent: entry._symlink.tree, cwd: this.cwd.replace(entry.relativePath, '') });

      // Return the items from the target tree, not this one (no items from this tree can match cwd).
      return rootedTree._filterItems(treeToItems, itemToEntry, entryToItem, replaceRelativePath).map(item => {
        return replaceRelativePath(item, path.join(entry.relativePath, itemToEntry(item).relativePath));
      }).filter(item => {
        return this._filterMatches(itemToEntry(item).relativePath);
      });
    }

    if (this._filterMatches(entry.relativePath)) {
      // Remove matched directories which contained only non-matching files.
      if (filteredItems.length) {
        const relativePath = isDirectory(entry) ? ensureTrailingSlash(entry.relativePath) : entry.relativePath;
        let lastItem = filteredItems[filteredItems.length - 1];
        let lastEntry = itemToEntry(lastItem);

        while (filteredItems.length && !explicitlyMatchedItems.has(lastItem) && isDirectory(lastEntry) && !relativePath.startsWith(ensureTrailingSlash(lastEntry.relativePath))) {
          filteredItems.pop();

          if (filteredItems.length) {
            lastItem = filteredItems[filteredItems.length - 1];
            lastEntry = itemToEntry(lastItem);
          }
        }
      }

      // Add non-matched directories which contain matching files.
      dirStack.forEach(dir => {
        if (entry.relativePath.startsWith(ensureTrailingSlash(itemToEntry(dir).relativePath))) {
          filteredItems.push(dir);
        }
      });

      dirStack = [];
      dirDepth = 0;

      // Add matching entry.
      explicitlyMatchedItems.add(item);
      filteredItems.push(item);
    } else if (entry.relativePath.startsWith(this.cwd)) {
      if (entry._symlink) {
        const linkedEntries = this._getLinkedEntries(entry._symlink.tree, entry.relativePath);

        // Only include item if it's symlink target contains entries that match all filters.
        if (linkedEntries.length) {
          explicitlyMatchedItems.add(item);
          filteredItems.push(item);
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

  return filteredItems.filter(item => {
    // Chomp path set at end of relativePath so that it cannot match cwd entirely (which always has trailing slash).
    return chompPathSep(itemToEntry(item).relativePath).startsWith(this.cwd);
  });
}

FSTree.prototype.addEntries = function(entries, options) {
  this._throwIfNotWritable('addEntries');

  if (!Array.isArray(entries)) {
    throw new TypeError('entries must be an array');
  }
  if (options && options.sortAndExpand) {
    sortAndExpand(entries);
  } else {
    validateSortedUnique(entries);
  }
  var fromIndex = 0;
  var toIndex = 0;
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
};

FSTree.prototype.addPaths = function(paths, options) {
  this._throwIfNotWritable('addPaths');

  this.addEntries(paths.map(e => Entry.fromPath(e)), options);
};

FSTree.prototype.start = function() {
  if (!this.srcTree && !this.parent) {
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

  if (resolvedPath !== chompPathSep(root) && !resolvedPath.startsWith(ensureTrailingSlash(root))) {
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

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const symlink = entry._symlink;

    // The relativePath in entry and relativePath function parameter matches
    if (entryRelativePath(entry) === chompPathSep(normalizedPath)) {
      if (resolveSymlinks && symlink) {
        return { entry: ROOT, tree: symlink.tree };
      }

      return { entry, tree: this };
    } else if (symlink && normalizedPath.startsWith(ensureTrailingSlash(entry.relativePath))) {
      // find the relativePath with respect to the symlink's entry
      // eg. relativePath = 'a/b/c/foo.js' and symlink's entry is 'd' (c is symlinked to d), with foo.js as its children
      //     search in the symlink for d/foo.js
      const sourceRelativePath = normalizedPath.replace(ensureTrailingSlash(entry.relativePath), '');

      return symlink.tree.findByRelativePath(sourceRelativePath, options);
    }
  };

  return { entry: null, tree: null };
};

FSTree.prototype.statSync = function(relativePath) {
  const entry = this.findByRelativePath(relativePath).entry;

  if (!entry) {
    throw new Error(`ENOENT: no such file or directory, stat '${relativePath}'`);
  }

  return entry2Stat(entry);
};

FSTree.prototype.existsSync = function(relativePath) {
  let resolvedPath = this.resolvePath(relativePath);

  if (resolvedPath === this.root || !this._hasEntries) {
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

  return tree._entries.filter(entry => chompPathSep(entry.relativePath).indexOf(path.sep) === -1).map(entry => chompPathSep(entry.relativePath));
}

FSTree.prototype.walkPaths = function() {
  return this.walkEntries().map(e => e.relativePath);
};

FSTree.prototype.walkEntries = function() {
  let entries = [];

  this._entries.forEach(entry => {
    entries.push(entry);

    if (entry._symlink) {
      const linkedEntries = entry._symlink.tree.walkEntries().map(linkedEntry => {
        // Prepend CWD and entry relativePath so that we can pass through _filterItems.
        const relativePath = path.join(this.cwd, entry.relativePath, linkedEntry.relativePath);

        return Entry.clone(linkedEntry, relativePath);
      });
    
      entries = entries.concat(this._filterItems(
        // treeToItems
        tree => tree === this ? linkedEntries : tree._entries, // substitute our own set of entries
        // itemToEntry
        entry => entry,
        // entryToItem
        entry => entry,
        // replaceRelativePath
        (entry, relativePath) => Entry.clone(entry, relativePath)
      ).map(entry => Entry.clone(entry, entry.relativePath.replace(this.cwd, ''))));
    }
  });
 

  return entries;
};

function getDirDepth(dirPath){
  return dirPath.split(path.sep).length - 1;
}

FSTree.prototype.changes = function() {
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
    }) : this

    return prevTree.calculatePatch(currentTree);
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

  this._changes.forEach(change => {
    combinedChanges.push(change);

    if (change[2]._symlink) {
      const linkedChanges = change[2]._symlink.tree.walkEntries().map(entry => {
        const relativePath = path.join(change[2].relativePath, entry.relativePath);

        return [isDirectory(entry) ? 'mkdir' : 'create', relativePath, Entry.clone(entry, relativePath)];
      });

      // TODO: probably need to add/strip CWD around _filterItems call?
      combinedChanges = combinedChanges.concat(this._filterItems(
        // treeToItems
        tree => tree === this ? linkedChanges : tree._changes, // substitute our own set of changes
        // itemToEntry
        change => change[2],
        // entryToItem
        entry => [isDirectory(entry) ? 'mkdir' : 'create', entry.relativePath, Entry.clone(entry)],
        // replaceRelativePath
        (change, relativePath) => [change[0], relativePath, Entry.clone(entry, relativePath)]
      ));

      traversedSymlinks.add(change[2].relativePath);
    }
  });

  // Collect the changes from any unchanged symlinks.
  this._entries.forEach(entry => {  
    if (entry._symlink && !traversedSymlinks.has(entry.relativePath)) {
      combinedChanges = combinedChanges.concat(this._filterItems(
        // treeToItems
        tree => tree === this ? entry._symlink.tree.changes() : tree._changes, // substitute our own set of changes
        // itemToEntry
        change => change[2],
        // entryToItem
        entry => [isDirectory(entry) ? 'mkdir' : 'create', entry.relativePath, Entry.clone(entry)],
        // replaceRelativePath
        (change, relativePath) => [change[0], relativePath, Entry.clone(entry, relativePath)]
      ).map(change => {
        const clonedEntry = Entry.clone(change[2], path.join(entry.relativePath, change[2].relativePath));

        return [change[0], path.join(entry.relativePath, change[1]), clonedEntry];
      }));
    }
  });

  // TODO: is this really necessary?
  combinedChanges.sort(changeComparator);

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

  if (result.entry) {
    fs.unlinkSync(this.resolvePath(relativePath));
    this._track('unlink', result.entry);
    this._removeAt(result.entry);
  }
};

FSTree.prototype.rmdirSync = function(relativePath) {
  this._throwIfNotWritable('rmdir', relativePath);

  const result = this.findByRelativePath(relativePath);
  const entry = result.entry;

  if (entry !== null) {
    if (!isDirectory(entry)) {
      throw new Error(`ENOTDIR: not a directory, rmdir '${relativePath}'`);
    }

    fs.rmdirSync(result.tree.resolvePath(entry.relativePath));
    result.tree._track('rmdir', entry);
    result.tree._removeAt(entry);
  } else {
    logger.info(`rmdirSync ${relativePath} noop, directory does not exist`);
  }
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
  this._insertAt(entry);
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
  this._insertAt(entry);
};

FSTree.prototype.symlinkSync = function(target, relativePath) {
  this._throwIfNotWritable('symlink', relativePath);

  let result = this.findByRelativePath(relativePath);

  if (result.entry) {
    throw new Error(`EEXIST: file already exists, symlink '${target}' -> '${relativePath}'`);
  }

  let normalizedPath = this._normalizePath(relativePath);

  symlinkOrCopy.sync(target, this.resolvePath(normalizedPath));

  // TODO: should we read the file here so our entry has size, mode & checksum?
  // this turns 1 io -> 2 io (symlink -> symlink + stat)

  let mode = 0;
  let entry = new Entry(normalizedPath, 0, Date.now(), mode);
  let operation = result.entry ? 'change' : 'create';

  this._track(operation, entry);
  this._insertAt(entry);
};

FSTree.prototype.symlinkSyncFromEntry = function(srcFSTree, srcRelativePath, destRelativePath) {
  const destNormalizedPath = this._normalizePath(destRelativePath === '/' ? '' : destRelativePath);
  const srcNormalizedPath = srcFSTree._normalizePath(srcRelativePath === '/' ? '' : srcRelativePath);

  this._throwIfNotWritable('symlinkSyncFromEntry', destNormalizedPath, true);

  if (destNormalizedPath === '') {
    logger.info('Adding parent to existing tree from symlinkSyncFromEntry');

    fs.rmdirSync(this.root);
    symlinkOrCopy.sync(srcFSTree.resolvePath(srcRelativePath), this.root);

    this.parent = srcFSTree.chdir(srcNormalizedPath);

    return;
  }

  const result = this.findByRelativePath(destNormalizedPath);

  if (result.entry) {
    throw new Error(`EEXIST: file already exists, symlink '${srcRelativePath}' -> '${destRelativePath}'`);
  }

  const entry = new Entry(destNormalizedPath, 0, Date.now(), Entry.DIRECTORY_MODE, null);

  entry._symlink = { tree: srcFSTree.chdir(srcNormalizedPath), entry: ROOT };
  symlinkOrCopy.sync(srcFSTree.resolvePath(srcRelativePath), this.resolvePath(destNormalizedPath));

  this._track('mkdir', entry);
  this._insertAt(entry);
};

// TODO: tests
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

// TODO: tests
FSTree.prototype.emptySync = function(relativePath) {
  this._throwIfNotWritable('empty', relativePath, true);

  // TODO: ensure directory

  // FIXME: always operates on the root!
  const unfilteredEntries = this._unfilteredEntries.slice().reverse();

  unfilteredEntries.forEach(entry => {
    if (entry._symlink || !isDirectory(entry)) {
      this.unlinkSync(entry.relativePath);
    } else {
      this.rmdirSync(entry.relativePath);
    }
  });
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
  if (this.parent) {
    // No-op for projections; srcTrees will have been reread earlier in the build chain.
    return;
  }

  if (typeof newRoot !== 'undefined') {
    const resolvedRoot = path.normalize(path.resolve(newRoot));

    if (this.srcTree) {
      // root can be changed for srcTree
      this._root = resolvedRoot;
    } else if (ensureTrailingSlash(resolvedRoot) !== this.root) {
      throw new Error(`Cannot change root from '${this.root}' to '${newRoot}' of a non-source tree.`);
    } else {
      // noop for non-srcTree if the root matches
      return;
    }
  } else if (!this.srcTree) {
    // noop for non-srcTree if root is not changed
    return;
  }

  // stash current entries so we can calculate a diff
  if (this._rawEntries) {
    this._prevEntries = this._entries.slice();
  }

  // don't eagerly read, but invalidate our current entries
  this._rawEntries = undefined;
};

FSTree.prototype._ensureEntriesPopulated = function() {
  if (this._hasEntries) {
    return;
  }

  if (this.parent) {
    this.parent._ensureEntriesPopulated();

    return;
  }

  // FIXME: Conflict (?) between old API (`tree.calculatePatch(new FSTree())`,
  // see ember-browserify stub generator) and lazy trees.
  // if (!this.root) {
  //   throw new Error('Cannot scan for entries, as no root was provided.');
  // }

  this._rawEntries = this.root ? walkSync.entries(this.root) : [];
};

FSTree.prototype._track = function(operation, entry) {
  this._rawChanges.push([
    operation,
    entryRelativePath(entry),
    entry,
  ]);
};

FSTree.prototype._insertAt = function(entry) {
    this._ensureEntriesPopulated();

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

FSTree.prototype._removeAt = function(entry) {
  if (!entry) {
    return;
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
  } else if (typeof matcher === 'string') {
    // TODO: preprocess filters (eg cache minimatch instances the way funnel does)
    return new Minimatch(matcher).match(path);
  } else if (typeof matcher === 'function') {
    return matcher(path);
  }

  throw new Error('wat is happening');
}


function shouldFollowSymlink(entryPath, cwd) {
  // We should follow symlink if cwd equals entryPath or if entryPath starts with cwd
  // If the above is false, we can still descend if we have a partial match
  // when cwd starts with entryPath. In that case, we will return the portion
  // of the cwd that was not match. This indicates a partial match.

  // TODO: its too inconsistent when cwd and when relativePath has trailing slashes
  cwd = chompLeadAndTrailingPathSep(cwd);
  entryPath = chompLeadAndTrailingPathSep(entryPath);
  var val = cwd === entryPath || entryPath.startsWith(cwd) || cwd.startsWith(ensureTrailingSlash(entryPath));
  return val;
}

FSTree.prototype._resetCaches = function() {
  // Reset cache of which entries match filters.
  this._filterMatchesCache.clear();

  // Reset the cache of which directories have been excluded.
  this._excludedDirectoriesCache.clear();

  // TODO: reset cached _entries
  // TODO: reset cached _changes
};

FSTree.prototype._filterMatches = function(relativePath) {
  if (!this._filterMatchesCache.has(relativePath)) {
    const doesMatch = filterMatches(relativePath, this._excludedDirectoriesCache, this.cwd, this.files, this.include, this.exclude);

    this._filterMatchesCache.set(relativePath, doesMatch);
  }

  return this._filterMatchesCache.get(relativePath);
};

function filterMatches(relativePath, excludedDirectoriesCache, cwd, files, include, exclude) {
  // exclude if outside of cwd
  if (!relativePath.startsWith(cwd) || cwd === ensureTrailingSlash(relativePath)) {
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

  if (exclude.length > 0) {
    // exclude if any ancestor directory matches anything in exclude
    let currentDir = path.dirname(relativePath);

    while (currentDir !== '.') {
      if (!excludedDirectoriesCache.has(currentDir)) {
        excludedDirectoriesCache.set(currentDir, exclude.some(matcher => match(currentDir, matcher)));
      }

      if (excludedDirectoriesCache.get(currentDir)) {
        return false;
      }

      currentDir = path.dirname(currentDir);
    }

    // exclude if matched by anything in exclude
    if (exclude.some(matcher => match(relativePath, matcher))) {
      return false;
    }
  }


  if (include.length > 0) {
    // exclude unless matched by something in includes
    if (include.every(matcher => !match(relativePath, matcher))) {
      return false;
    }
  }

  return true;
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