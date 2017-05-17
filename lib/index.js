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

  this.cwd = options.cwd || ''; 
  this.files = options.files ||  [];
  this.exclude = options.exclude || [];
  this.include = options.include || [];

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
      tree => tree.parent ? tree.parent._changes : tree._rawChanges,
      // itemToEntry
      change => change[2],
      // entryToItem
      entry => [isDirectory(entry) ? 'mkdir' : 'create', entry.relativePath, entry],
      // replaceRelativePath
      (change, relativePath) => [change[0], relativePath, Entry.clone(change[2], relativePath)],
      // removeSymlink
      change => {
        const clonedEntry = Entry.clone(change[2]);

        delete clonedEntry._symlink;

        return [change[0], change[1], clonedEntry];
      });


    return filteredChanges.map(change => {
      const clonedEntry = Entry.clone(change[2]);

      clonedEntry.relativePath = clonedEntry.relativePath.replace(this.cwd, '');

      return [change[0], change[1].replace(this.cwd, ''), clonedEntry];
    });
  },

  get cwd() {
    return this._cwd;
  },

  set cwd(value) {
    this._cwd = ensureTrailingSlash(value.replace(/^\//, ''));
  },

  get _entries() {
    const filteredEntries = this._filterItems(
      // treeToItems
      tree => tree.parent ? tree.parent._entries : tree._rawEntries,
      // itemToEntry
      entry => entry,
      // entryToItem
      entry => entry,
      // replaceRelativePath
      (entry, relativePath) => Entry.clone(entry, relativePath),
      // removeSymlink
      entry => {
        const clonedEntry = Entry.clone(entry);

        delete clonedEntry._symlink;

        return clonedEntry;
      });

    return filteredEntries.map(entry => Entry.clone(entry, entry.relativePath.replace(this.cwd, '')));
  },

  get exclude() {
    return this._exclude;
  },

  set exclude(value) {
    // TODO: invalidate caches
    this._exclude = value;
  },

  get files() {
    return this._files;
  },

  set files(value) {
    // TODO: invalidate caches
    this._files = value;
  },

  get _hasEntries() {
    return this.parent ? this.parent._hasEntries : Array.isArray(this._rawEntries);
  },

  get include() {
    return this._include;
  },

  set include(value) {
    // TODO: invalidate caches
    this._include = value;
  },

  get parent() {
    return this._parent;
  },

  set parent(value) {
    // TODO: invalidate caches
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
    const entries =  this.parent ? this.parent._unfilteredEntries : this._rawEntries;

    return entries.filter(entry => {
      return entry.relativePath.startsWith(this.cwd);
    }).map(entry => {
      const clonedEntry = Entry.clone(entry);

      clonedEntry.relativePath = clonedEntry.relativePath.replace(this.cwd, '');

      return clonedEntry;
    });
  },
};

// function getBasePath(tree, relativePath) {
//   let root;

//   if (tree.root) {
//     root = tree.root;
//   } else {
//     const entry = tree.findByRelativePath(relativePath).entry;

//     if (entry.basePath) {
//       root = entry.basePath;
//     } else {
//       root = entry.absolutePath.replace(entry.relativePath, '');
//     }
//   }

//   return root;
// }

FSTree.fromParent = function(tree, options) {
  return new FSTree(Object.assign({}, options || {}, {
    parent: tree,
  }));
};

FSTree.fromPaths = function(paths, options) {
  return new FSTree(merge(options || {}, {
    entries: paths.map(e => Entry.fromPath(e)),
  }));
};

FSTree.fromEntries = function(entries, options) {
  return new FSTree(merge(options || {}, {
    entries: entries,
  }));
};

Object.defineProperty(FSTree.prototype, 'size', {
  get: function() {
    return this._entries.length;
  }
});

FSTree.prototype._getLinkedEntries = function(tree, relativePath) {
  const entries = tree._entries.map(entry => Entry.clone(entry, path.join(relativePath, entry.relativePath)));

  return this._filterItems(
    // treeToItems
    tree => entries,  // I reject your entries and substitute my own.
    // itemToEntry
    entry => entry,
    // entryToItem
    entry => entry,
    // replaceRelativePath
    (entry, relativePath) => Entry.clone(entry, relativePath)
  );
}

FSTree.prototype._filterItems = function(treeToItems, itemToEntry, entryToItem, replaceRelativePath, removeSymlink) {
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

      // Return the items from the target tree, no this one (no items from this tree can match cwd).
      return rootedTree._filterItems(treeToItems, itemToEntry, replaceRelativePath).map(item => {
        return replaceRelativePath(item, path.join(entry.relativePath, itemToEntry(item).relativePath));
      }).filter(item => {
        return filterMatches(itemToEntry(item).relativePath, this.cwd, this.files, this.include, this.exclude);
      });
    }

    if (filterMatches(entry.relativePath, this.cwd, this.files, this.include, this.exclude)) {
      // Remove matched directories which contained only non-matching files.
      if (filteredItems.length) {
        const relativePath = isDirectory(entry) ? ensureTrailingSlash(entry.relativePath) : entry.relativePath;
        let lastItem = filteredItems[filteredItems.length - 1];
        let lastEntry = itemToEntry(lastItem);

        while (filteredItems.length && !explicitlyMatchedItems.has(lastItem) && isDirectory(lastEntry) && !relativePath.startsWith(ensureTrailingSlash(lastEntry.relativePath))) {
          filteredItems.pop();
          lastItem = filteredItems[filteredItems.length - 1];
          lastEntry = itemToEntry(lastItem);
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

      // Add matching entry and items created from its symlink's entries.
      if (entry._symlink) {
        const itemWithoutSymlink = removeSymlink(item);

        explicitlyMatchedItems.add(itemWithoutSymlink);
        filteredItems.push(itemWithoutSymlink);
        filteredItems = filteredItems.concat(this._getLinkedEntries(entry._symlink.tree, entry.relativePath).map(entryToItem));
      } else {
        explicitlyMatchedItems.add(item);
        filteredItems.push(item);
      }
    } else if (entry.relativePath.startsWith(this.cwd)) {
      if (entry._symlink) {
        const linkedEntries = this._getLinkedEntries(entry._symlink.tree, entry.relativePath);

        if (linkedEntries.length) {
          filteredItems.push(removeSymlink(item));
          filteredItems = filteredItems.concat(linkedEntries.map(entryToItem));
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
  this._rawChanges = [];
  this._state = STARTED;
};

FSTree.prototype.stop = function() {
  this._state = STOPPED;
};

FSTree.prototype._normalizePath = function(relativePath) {
  const absolutePath = this.resolvePath(relativePath);

  const root = this.root;

  if (root) {
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
  this._ensureEntriesPopulated();

  const normalizedPath = this._normalizePath(relativePath);

  if (normalizedPath === '') {
    return { entry: ROOT, tree: this };
  }

  const applyFilters = options && options.applyFilters !== undefined ? options.applyFilters : true;
  const followSymlinks = options && options.followSymlinks !== undefined ? options.followSymlinks : true;
  const entries = applyFilters ? this._entries : this._unfilteredEntries;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const symlink = entry._symlink;

    // The relativePath in entry and relativePath function parameter matches
    if (entryRelativePath(entry) === chompPathSep(normalizedPath)) {
      if (followSymlinks && symlink) {
        return { entry: ROOT, tree: symlink.tree };
      }

      return { entry, tree: this };
    } else if (followSymlinks && symlink && normalizedPath.startsWith(ensureTrailingSlash(entry.relativePath))) {
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
  let rootSansPathSep = chompPathSep(this.root);

  if (resolvedPath === rootSansPathSep || !this._hasEntries) {
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

  return tree.filter(entry => chompPathSep(entry.relativePath).indexOf(path.sep) === -1).map(entry => chompPathSep(entry.relativePath));
}

FSTree.prototype.walkPaths = function() {
  return this.walkEntries().map(e => e.relativePath);
};

FSTree.prototype.walkEntries = function() {
  this._ensureEntriesPopulated();

  let entries = [];

  this.forEach(entry => {
    entries.push(entry);

    if (entry._symlink) {
      entries = entries.concat(entry._symlink.tree.walkEntries());
    }
  });

  return entries;
};

// TODO: remove? (see #54)
FSTree.prototype.match = function(globs) {
  const matcher = new MatcherCollection(globs.include);

  return this.filter(function(entry) {
    return matcher.mayContain(entryRelativePath(entry));
  });
};

function getDirDepth(dirPath){
  return dirPath.split(path.sep).length - 1;
}

FSTree.prototype.changes = function(options) {
  this._ensureEntriesPopulated();

  if (this.srcTree) {
    return this._diffToFindPatches(options || {});
  }

  return this._processChanges(options || {});
};

/** Get changes for srcTrees by diffing against a previous set of entries. */
FSTree.prototype._diffToFindPatches = function(options) {
  const prevTree = FSTree.fromEntries(this._prevEntries || []);

  // preserveSrcTreeChanges is used by _processChanges to prevent stomping on
  // _prevEntries when getting symlink changes
  if (!options.preserveSrcTreeChanges) {
    this._prevEntries = this._entries.slice();
  }

  return prevTree.calculatePatch(this);
}

/** Aggregate changes from this tree with symlinked trees. */
FSTree.prototype._processChanges = function(/* options */) {
  const traversedSymlinks = new Set();
  let combinedChanges = this._changes;

  combinedChanges.forEach(change => {
    if (change[2]._symlink) {
      traversedSymlinks.add(change[2].relativePath);
    }
  });

  // Collect the changes from any unchanged symlinks.
  this._entries.forEach(entry => {
    if (entry._symlink && !traversedSymlinks.has(entry.relativePath)) {
      combinedChanges = combinedChanges.concat(entry._symlink.tree.changes({ preserveSrcTreeChanges: true }));
    }
  });

  // TODO: is this really necessary?
  combinedChanges.sort(changeComparator);

  return combinedChanges;
}

function processChanges(tree, filteredEntries, options) {
  tree._changes.forEach(change => {
    if (change[2]._symlink) {
      processChangeWithProjections(tree, change, options, filteredEntries);
    } else {
      processChangeWithoutProjection(tree, change, options, filteredEntries);
    }
  });

  // filteredEntries.sort(compareChanges);

  return filteredEntries;
}

function processChangeWithProjections(tree, change, options, filteredEntries) {
  const effectiveCwd = options.cwdPostfix ? `${tree.cwd}${options.cwdPostfix}` : tree.cwd;

  if (shouldFollowSymlink(change[1], effectiveCwd)) {
    // TODO: clone options
    options.fromProjection = true;

    let projectedTree = change[2]._symlink.tree;

    if (effectiveCwd.startsWith(ensureTrailingSlash(change[1]))) {
      tree = chdir()
    //   options.cwdPostfix = effectiveCwd.replace(ensureTrailingSlash(change[1]), '')
    // } else {
    //   options.cwdPostfix = '';
    }

    // create filter
    const filter = { cwd: effectiveCwd, files : tree.files, include : tree.include, exclude: tree.exclude, transform : generatePathTransform(change) }
    options.filters.push(filter);

    // If symlink is present call changes() recursively
    let projectedEntries = change[2]._symlink.tree.changes(options);
    options.filters.pop();

    if (projectedEntries.length > 0) {
      postProcessPatchesFromProjections(change, projectedEntries, filteredEntries, tree.cwd)
    }
  }
}


function processChangeWithoutProjection(tree, change, options, filteredEntries) {

  let cwd = options.cwdPostfix ? `${tree.cwd}${options.cwdPostfix}`: tree.cwd;
  // create filter
  const filter = { cwd: cwd, files : tree.files, include : tree.include, exclude: tree.exclude, transform : path => path }
  options.filters.push(filter);

 if(matchesFilterStack(change[1], options)) {
    let newEntry = Entry.clone(change[2]);
    newEntry.relativePath = newEntry.relativePath.replace(cwd, '');
    filteredEntries.push([change[0], change[1].replace(cwd, ''), newEntry]);
  }
  options.filters.pop();
}


// 1. Prefix relativePath of current change to the returned patches from changes()
// 2. push current change to patches
// 3. remove CWD from the relativePath of the returned patches
function postProcessPatchesFromProjections(change, projectedEntries, filteredEntries, cwd) {
  let target = ensureTrailingSlash(change[2].relativePath);
  // 1. Here, we need to prefix the relativePath of the current entry to
  // the return patches from changes
   projectedEntries.forEach(projectedChange => {

    // TODO: what condition should we NOT do mkdirp?
    if (projectedChange[0] === 'mkdir') {
      projectedChange[0] = 'mkdirp';
    }
    //use transform function


    // Prevent duplicates. Is this the right way to do it??
    if (!ensureTrailingSlash(projectedChange[1]).startsWith(target)) {
      projectedChange[1] = `${target}${projectedChange[1]}`;
    }
    let newEntry = Entry.clone(projectedChange[2]);
    if (!ensureTrailingSlash(projectedChange[2].relativePath).startsWith(target)) {
      newEntry.relativePath = `${target}${projectedChange[2].relativePath}`;
    }
    projectedChange[2] = newEntry;
  });

  // 2. since we have entries from the current dir, unshift change onto projectedEntries
  change[0] = change[0] === 'mkdir' ? 'mkdirp' : change[0];
  projectedEntries.unshift([change[0], change[1], Entry.clone(change[2])]);
  // 3. Remove cwd from the relativePath
  projectedEntries.forEach(projectedChange => {
    if (projectedChange[1].startsWith(cwd)) {
      // TODO: use the new functon
      projectedChange[1] = projectedChange[1].replace(cwd, '');
      projectedChange[2].relativePath = projectedChange[2].relativePath.replace(cwd, '');
      filteredEntries.push(projectedChange);
    }
  });

}


function generatePathTransform(change) {
  const target = ensureTrailingSlash(change[1]);
  const source = change[2]._symlink.entry === ROOT ? '' : ensureTrailingSlash(change[2]._symlink.entry.relativePath);

  return function(path) {
    return path.replace(source, target);
  }
}

function matchesFilterStack(currentPath, options) {
  for (let i = options.filters.length - 1; i >= 0; i--) {
    const filter = options.filters[i];

    currentPath = filter.transform(currentPath);

    if (!filterMatches(currentPath, filter.cwd, filter.files, filter.include, filter.exclude)) {
      return false;
    }
  }
  return true;
}

function checkDirDepth(prevDirPath, currentDirPath){
  if (currentDirPath.includes(prevDirPath)) {
    if ((currentDirPath.split(path.sep).length - 1) >= (prevDirPath.split(path.sep).length - 1)) {
      return true;
    }
  }

  return false;
}

FSTree.prototype.chdir = function(relativePath, options) {
  const allowEmpty = options && options.allowEmpty;
  const result = this.findByRelativePath(relativePath);

  if (result.entry === ROOT) {
    return result.tree;
  }

  if (result.entry) {
    if (isFile(result.entry)) {
      throw new Error(`ENOTDIR: not a directory, ${relativePath}`);
    }
  } else if (!allowEmpty) {
    throw new Error(`ENOENT: no such file or directory, ${relativePath}`);
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

FSTree.prototype._throwIfNotWritable = function(operation, relativePath) {
  if (this.parent) {
    throw new Error(`Cannot '${operation}' on a projection.`);
  }

  if (this._state === STOPPED) {
    throw new Error(`Cannot '${operation}' on a stopped tree.`);
  }

  if (typeof relativePath !== 'undefined') {
    const normalizedPath = this._normalizePath(relativePath);

    // symlinkSyncFromEntry can target the tree's root
    if (operation !== 'symlinkSyncFromEntry' || normalizedPath !== '') {
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

  const result = this.findByRelativePath(relativePath, { followSymlinks: false });

  if (result.entry) {
    fs.unlinkSync(this.resolvePath(relativePath));
    this._track('unlink', result.entry);
    this._removeAt(result.entry);
  }
};

FSTree.prototype.rmdirSync = function(relativePath) {
  this._throwIfNotWritable('rmdir', relativePath);

  const result = this.findByRelativePath(relativePath, { followSymlinks: false });
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

  const result = this.findByRelativePath(relativePath, {
    applyFilters: false,
    followSymlinks: false,
  });

  if (result.entry) {
    if (isDirectory(result.entry)) {
      logger.info('mkdirSync %s noop, directory exists', relativePath);

      return;
    } else {
      throw new Error(`EEXIST: file already exists, mkdir '${relativePath}'`);
    }
  }

  const normalizedPath = this._normalizePath(relativePath);

  fs.mkdirSync(`${this.root}${normalizedPath}`);
  const entry = new Entry(normalizedPath, 0, Date.now(), Entry.DIRECTORY_MODE, null);

  this._track('mkdir', entry);
  this._insertAt(entry);
};

FSTree.prototype.mkdirpSync = function(relativePath) {
  this._throwIfNotWritable('mkdirp', relativePath);

  const result = this.findByRelativePath(relativePath, {
    applyFilters: false,
    followSymlinks: false,
  });

  if (result.entry) {
    if (isDirectory(result.entry)) {
      logger.info('mkdirpSync %s noop, directory exists', relativePath);
    
      return;
    } else {
      throw new Error(`EEXIST: file already exists, mkdirp '${relativePath}'`);
    }
  }

  // if (relativePath[0] === path.sep){
  //   relativePath = relativePath.substr(1);
  // }

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

  if (!filterMatches(normalizedPath, this.cwd, this.files, this.include, this.exclude)) {
    throw new Error(`Cannot write file which does match current filters '${relativePath}'`);
  }

  const result = this.findByRelativePath(normalizedPath, { followSymlinks: false });

  let entry = result.entry;
  // ensureFile, so throw if the entry is a directory
  let mode;
  // TODO: cleanup idempotent stuff
  const checksum = md5hex('' + content);

  if (entry) {
    mode = entry.mode;

    if (!entry.checksum) {
      // lazily load checksum
      entry.checksum = md5hex(fs.readFileSync(path.join(this.root , relativePath), 'UTF8'));
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

FSTree.prototype.symlinkSync = function(target, relativePath /*, type */) {
  this._throwIfNotWritable('symlink', relativePath);

  let result = this.findByRelativePath(relativePath);

  if (result.entry) {
    // Since we don't have symlinks in our abstraction, we don't care whether
    // the entry that currently exists came from a link or a write.  In either
    // case we will read the correct contents.
    return;
  }

  let normalizedPath = this._normalizePath(relativePath);
  //TODO: RESOLVEPATH(NORMALIZE PATH) TO REMOVE EXTRA SLASHES
  symlinkOrCopy.sync(target, `${this.root}${normalizedPath}`);

  // TODO: do we need this pattern?  used in funnel
  //
  // try {
  //   this.out.symlinkSync(sourcePath, destPath);
  // } catch(e) {
  //   if (!existsSync(destDir)) {
  //     mkdirp.sync(destDir);
  //   }
  //   try {
  //     fs.unlinkSync(destPath);
  //   } catch(e) {

  //   }
  //   symlinkOrCopy.sync(sourcePath, destPath);
  // }

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

  this._throwIfNotWritable('symlinkSyncFromEntry', destNormalizedPath);

  const result = this.findByRelativePath(destNormalizedPath);

  if (result.entry) {
    throw new Error(`EEXIST: file already exists, symlink '${srcRelativePath}' -> '${destRelativePath}'`);
  }

  const srcNormalizedPath = srcFSTree._normalizePath(srcRelativePath === '/' ? '' : srcRelativePath);

  if (destRelativePath === '') {
    logger.info('Adding parent to existing tree from symlinkSyncFromEntry');

    fs.rmdir(this.root);
    symlinkOrCopy.sync(srcFSTree.resolvePath(srcRelativePath), this.resolvePath(destNormalizedPath));

    this.parent = srcFSTree.chdir(srcNormalizedPath);

    return;
  }

  const entry = new Entry(destNormalizedPath, 0, Date.now(), Entry.DIRECTORY_MODE, null);

  entry._symlink = { tree: srcFSTree.chdir(srcNormalizedPath), entry: ROOT };
  symlinkOrCopy.sync(srcFSTree.resolvePath(srcRelativePath), this.resolvePath(destNormalizedPath));

  this._ensureEntriesPopulated();
  this._track('mkdir', entry);
  this._insertAt(entry);
};

/**
  reread this tree's root directory., if necessary.  The root directory may also
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
    throw new Error('Cannot reread a tree with a parent.');
  }

  if (typeof newRoot !== 'undefined') {
    const resolvedRoot = ensureTrailingSlash(path.normalize(path.resolve(newRoot)));

    if (this.srcTree) {
      // root can be changed for srcTree
      this._root = resolvedRoot;
    } else if (resolvedRoot !== this.root) {
      throw new Error(`Cannot change root from '${this.root}' to '${newRoot}' of a non-source tree.`);
    } else {
      // noop for non-srcTree if the root matches
      return;
    }
  } else if (!this.srcTree) {
    // noop for non-srcTree if root is not changed
    return;
  }

  // TODO: stash current entries so we can calculate a diff
  // don't eagerly read, but invalidate our current entries
  this._rawEntries = undefined;
};

/** Populate the tree's entries from the files filter.
 * 
 * (Does nothing if entries are already populated.)
 */
FSTree.prototype._entriesFromFiles = function() {
  if (this._hasEntries) {
    return;
  }

  if (this.parent) {
    return this.parent._entriesFromFiles();
  }

  const tempTree = FSTree.fromPaths(this.files, { sortAndExpand: true });

  this._rawEntries = tempTree._entries;
};

FSTree.prototype._ensureEntriesPopulated = function() {
  if (this._hasEntries) {
    return;
  }

  if (this.parent) {
    this.parent._ensureEntriesPopulated();

    return;
  }

  if (!this.root) {
    throw new Error('Cannot scan for entries, as no root was provided.');
  }

  this._rawEntries = walkSync.entries(this.root);
};

FSTree.prototype._track = function(operation, entry) {
  this._rawChanges.push([
    operation,
    entryRelativePath(entry),
    entry,
  ]);
};

FSTree.prototype._insertAt = function(entry) {
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
    throw new Error('Cannot remove a "root" entry; you probably missed a `followSymlinks` on a call to `findByRelativePath`.')
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


function shouldFollowSymlink(entryPath, cwd){
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

function filterMatches(entryPath, cwd, files, include, exclude) {
  // exclude if outside of cwd
  if (!entryPath.startsWith(cwd) || cwd === ensureTrailingSlash(entryPath)) {
    return false;
  }

  if (files.length && (include.length || exclude.length)) {
    throw new Error('Cannot pass files option and a include/exlude filter. You can only have one or the other');
  }

  if (cwd) {
    entryPath = entryPath.replace(cwd, '');
  }

  // include only if it matches an entry in files
  if (files.length) {
    return files.map(chompPathSep).indexOf(chompPathSep(entryPath)) > -1;
  }

  if (exclude.length > 0) {
    // exclude if matched by anything in exclude or if entryPath equals cwd
    if ((cwd && entryPath === cwd) || exclude.some(matcher => match(entryPath, matcher))) {
      return false;
    }
  }


  if (include.length > 0) {
    // exclude unless matched by something in includes
    if (include.every(matcher => !match(entryPath, matcher))) {
      return false;
    }
  }

  return true;
}

FSTree.prototype.filter = function(fn, context) {
  return this._entries.filter(fn, context);
};

FSTree.prototype.forEach = function(fn, context) {
  this._entries.forEach(fn, context);
};

FSTree.prototype.calculatePatch = function(otherFSTree, isEqual) {
  if (arguments.length > 1 && typeof isEqual !== 'function') {
    throw new TypeError('calculatePatch\'s second argument must be a function');
  }

  if (typeof isEqual !== 'function') {
    isEqual = FSTree.defaultIsEqual;
  }

  this._ensureEntriesPopulated();
  otherFSTree._ensureEntriesPopulated();

  let ours = this._entries;
  let theirs = otherFSTree._entries;
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