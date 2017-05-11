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

function TRUE() { return true; }

module.exports = FSTree;

function FSTree(options) {
  options = options || {};

  if (options.parent) {
    this.parent = options.parent;
  } else {
    this.parent = null;
    this._rawEntries = options.entries;

    if (options.sortAndExpand) {
      sortAndExpand(this._rawEntries);
    } else {
      validateSortedUnique(this._rawEntries);
    }
  }

  this.cwd = options.cwd || ''; 
  this.files = options.files ||  null; // TODO: change to []
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
  this.srcTree = !!options.srcTree;

  if ('root' in options) {
    validateRoot(options.root);

    this._root = path.normalize(options.root + path.sep);
  }

  if (!this.parent) {
    this.__changes = [];

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
  return inputPath === '' ? '' : `${chompPathSep(inputPath)}/`;
}

FSTree.prototype = {
  get _changes() {
    const changes = this.parent ? this.parent._changes : this.__changes;

    return changes.filter(change => {
      return filterMatches(change[2].relativePath, this._cwd, this.files, this.include, this.exclude);
    }).map(change => {
      const clonedEntry = Entry.cloneEntry(change[2]);

      clonedEntry.relativePath = clonedEntry.relativePath.replace(this.cwd, '');

      return [change[0], change[1].replace(this.cwd, ''), clonedEntry];
    });
  },

  get _hasEntries() {
    return this.parent ? this.parent._hasEntries : !!this._rawEntries;
  },

  get cwd() {
    return this._cwd;
  },

  set cwd(value) {
    this._cwd = ensureTrailingSlash(value.replace(/^\//, ''));
  },

  get _entries() {
    // TODO: where my dirStack at?
    const entries =  this.parent ? this.parent._entries : this._rawEntries;

    return entries.filter(entry => {
      return filterMatches(entry.relativePath, this._cwd, this.files, this.include, this.exclude);
    }).map(entry => {
      const clonedEntry = Entry.cloneEntry(entry);
      
      return clonedEntry.relativePath = clonedEntry.relativePath.replace(this.cwd, '');
    });
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
    this._parent = value;
  },

  get root() {
    if (this.parent) {
      return path.join(this.parent.root, this.cwd);
    }

    return this._root;
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
      const clonedEntry = Entry.cloneEntry(entry);

      clonedEntry.relativePath = clonedEntry.relativePath.replace(this.cwd, '');
    });
  },
};

function getbasePath(tree, relativePath) {
  let root;

  if (tree.root) {
    root = tree.root;
  } else {
    const entry = tree.findByRelativePath(relativePath).entry;

    if (entry.basePath) {
      root = entry.basePath;
    } else {
      root = entry.absolutePath.replace(entry.relativePath, '');
    }
  }

  return root;
}


FSTree.fromParent = function(tree, options) {
  return new FSTree(Object.assign({}, options || {}, {
    parent: tree,
    srcTree: false,
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

FSTree.prototype.addEntries = function(entries, options) {
  this.throwIfChild('addEntries');

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
  this.addEntries(paths.map(e => Entry.fromPath(e)), options);
};

// TODO: maybe don't allow calls to `start, stop` on child trees?  but instead
// only read state from parent
FSTree.prototype.start = function() {
  this._changes.splice(0, this._changes.length);
 // this._relativePathToChange = Object.create(null);
  this._state = STARTED;
};

FSTree.prototype.stop = function() {
  this._state = STOPPED;
};

FSTree.prototype._normalizePath = function(relativePath) {
  const absolutePath = this.resolvePath(relativePath);

  return path.relative(root, absolutePath);

  // // There are times when the relativePath already includes this.cwd
  // // relativePath = ember-data , cwd = modules/ember-data
  // // cwd = modules relativePath = modules/ember-data
  // const cwd = this.cwd;
  // const normalizedPath = ensureTrailingSlash(relativePath).indexOf(cwd) > -1  ? path.normalize(relativePath) : cwd.indexOf(relativePath) > -1 ? path.normalize(cwd) : path.normalize(`${cwd}${relativePath}`);

  // return lchompPathStart(chompPathSep(normalizedPath));
};

FSTree.prototype.resolvePath = function(relativePath) {
  if (typeof relativePath !== 'string') {
    throw new Error('Relative path must be a string.');
  }

  const root = getbasePath(this, relativePath);
  const resolvedPath = path.resolve(path.join(root, relativePath));

  if (!resolvedPath.startsWith(ensureTrailingSlash(root))) {
    throw new Error(`Invalid path: '${relativePath}' not within root '${root}'`);
  }

  return resolvedPath;
};

FSTree.prototype.findByRelativePath = function(relativePath, options) {
  const applyFilters = options && options.applyFilters !== undefined ? options.applyFilters : true;
  const followSymlinks = options && options.followSymlinks !== undefined ? options.followSymlinks : true;
  const normalizedPath = this._normalizePath(relativePath);

  (applyFilters ? this._entries : this._unfilteredEntries).forEach(entry => {
    const projection = entry._projection;

    // The relativePath in entry and relativePath function parameter matches
    if (entryRelativePath(entry) === chompPathSep(normalizedPath)) {
      if (followSymlinks && projection) {
        return { entry: ROOT, tree: projection.tree };
        // if (projection.entry === ROOT) {
        //   return { entry: projection.entry, tree: projection.tree };
        // } else {
        //   return projection.tree.findByRelativePath(projection.entry.relativePath, options);
        // }
      }

      return { entry, tree: this };
    } else if (followSymlinks && projection && normalizedPath.startsWtih(ensureTrailingSlash(entry.relativePath))) {
      // find the relativePath with respect to the projection's entry
      // eg. relativePath = 'a/b/c/foo.js' and projection's entry is 'd' (c is symlinked to d), with foo.js as its children
      //     search in the projection for d/foo.js
    //  const projectionEntryRelativePath = projection.entry === ROOT ? "." : projection.entry.relativePath;
      const sourceRelativePath = normalizedPath.replace(ensureTrailingSlash(entry.relativePath), '');
     // sourceRelativePath = sourceRelativePath.replace( projection.tree.cwd, '');
      return projection.tree.findByRelativePath(sourceRelativePath, options);
    }
  });

  return { entry: null, tree: null };
};

FSTree.prototype.leastExistingAncestor = function(relativePath) {
  relativePath = this._normalizePath(relativePath);

  let result = { entry: null, tree: null };

  for (let i = 0; i < this._entries.length; i++) {
    const entry = this._entries[i];

    if (entryRelativePath(entry) === chompPathSep(relativePath)) {
      result = { entry: entry, tree: this };
      break;
    }

    if (relativePath.startsWith(ensureTrailingSlash(entry.relativePath))) {
      if (entry._projection) {
        const sourceRelativePath = relativePath.replace(entry.relativePath, chompPathSep(entry._projection.entry.relativePath));

        result = entry._projection.tree.leastExistingAncestor(sourceRelativePath);
        break;
      }

      result = { entry: entry, tree: this };
    }
  }

  while (result.entry && result.entry._projection) {
    result = result.entry._projection;
  }
  return result;
};

FSTree.prototype.statSync = function(relativePath) {
  this._ensureEntriesPopulated();
  return entry2Stat(this.findByRelativePath(relativePath).entry);
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

// We do this for walk-sync, but once we have globs in projections we'll
// implement walkSync ourselves
FSTree.prototype.readdirSync = function(relativePath) {
  this._ensureEntriesPopulated();
  let normalizedPath = this._normalizePath(relativePath);
  let prefix; // TODO: RENAME to TARGETpATH]

  let result;
  let entries = this._entries;



  if (normalizedPath !== '') {
    result = this.findByRelativePath(relativePath);
      if (result.entry) {
        throw new Error(`ENOENT: no such file or directory, ${relativePath}`);
      } else if (isFile(result.entry)) {
        throw new Error(`ENOTDIR: not a directory, ${relativePath}`);
      }

    prefix = result.entry._projection && result.entry._projection.entry === ROOT ? '' : ensureTrailingSlash(result.tree._normalizePath(result.entry.relativePath));
    if (result.entry._projection && result.entry._projection.entry === ROOT){
      result.entry._projection.tree._ensureEntriesPopulated();
      entries = result.entry._projection.tree._entries;
    } else {
      entries = result.tree._entries;
    }
  } else {
      prefix = '';
  }


  return  entries.filter(e => {
    let entryPath = entryRelativePath(e);

    //When the projection entry is pointing to root, it means that we symlinked root to destDir
    // eg. ROOT2/abc is symlinked to ROOT1
    // then when we try to find the children of abc it should return all the children of ROOT1 (not grandchildren),
    // in that case normalizedPath will not be part of entryPath
    if(result && result.entry && result.entry._projection && result.entry._projection.entry === ROOT) {
      return entryPath.indexOf('/', prefix.length) === -1;
    }

    return entryPath !== chompPathSep(normalizedPath) && // make sure entry is a child of the dir we are reading
      entryPath.startsWith(prefix) && // don't return subdirs
      entryPath.indexOf('/', prefix.length) === -1;
  }).map(e => entryRelativePath(e).replace(prefix, ''));
}

FSTree.prototype.walkPaths = function() {
  return this.walkEntries().map(e => e.relativePath);
};

FSTree.prototype.walkEntries = function() {
  this._ensureEntriesPopulated();

  let entries = [];
  this.forEach(entry => {
    entries.push(entry);
    if (entry._projection) {
      entries = entries.concat(entry._projection.tree.walkEntries());
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

// // filter this.entries with files, include and exclude
// // including sort and expand of the matched entries
// FSTree.prototype._filterEntries = function(options) {
//   let filteredEntries = [];
//   let dirStack = [];
//   let dirDepth = 0;

//   let inputsArr  = this.entries;
//   let cwd = options.cwdPostfix ? `${this.cwd}${options.cwdPostfix}`:this.cwd;
//   let filterOptions = options;

//   let tree = this;

//   inputsArr.map(input => {


//     // if input.length is undefined, then input is an entry from this.entry
//     // else, input is an element from this._changes, which entry is its third
//     // indice
//     const entry = (input.length === undefined) ? input : input[2];

//     // if(entry.relativePath.indexOf("styles/jobs-shared/_styles.scss") > -1 ){
//     //   debugger;
//     // }

//     // console.log("---- filterOptions ------ ")
//     // console.log(filterOptions)
//     let cwd = options.cwdPostfix ? `${tree.cwd}${options.cwdPostfix}`: tree.cwd;
//     // create filter
//     const filter = { cwd: cwd, files : tree.files, include : tree.include, exclude: tree.exclude, transform : path => path }
//     options.filters.push(filter);

//    // const filterMatched = filterMatches(entry.relativePath, cwd, this.files, this.include, this.exclude);
//     const filterMatched =  matchesFilterStack(entry.relativePath, filterOptions);

//     options.filters.pop();


//     // being consistent here, by removing trailing slash at end of all relativePath
//     if (filterMatched) {

//       //TODO: Add tests to check if the directories being pushed to filteredEntries
//       // are relevant to the entries being filterMatched
//       /**
//        * eg,  mkdir node_modules
//               mkdir node_modules/rollup
//               mkdir node_modules/rollup/dist
//               create rollup.babelrc
//        first 3 lines should not bes preesnt if include is "rollup.babelrc"
//        */


//       // if matched, push all dir entries from dirStack into filteredEntries
//       for (let i = 0; i < dirStack.length; i++) {
//         if(entry.relativePath.indexOf(dirStack[i]) > -1 ) {
//           filteredEntries.push(dirStack[i]);
//         }
//       }
//       dirStack = [];
//       dirDepth = 0;


//       // Removing entries that are directories since exclude
//       // only excludes files when matched, if a file is not match,
//       // its directories should not be part of entries here, we are
//       // are assuming if we see two directories being added
//       // we should check the directory Depth and remove all directories
//       // with greater directory Depth
//       // eg. subdir1/
//       //     subdir1/subsubdir1/
//       //     subdir2 /
//       //
//       //    when the above happens, we should remove subdir1 & subsubdir1
//       const topElem = filteredEntries[filteredEntries.length-1];
//       if (topElem !== undefined){
//         let topFilteredEntry = (topElem.length === undefined) ? topElem : topElem[2];
//         while (filteredEntries.length !== 0 && isDirectory(topFilteredEntry) && isDirectory(entry) && getDirDepth(topFilteredEntry.relativePath) >= getDirDepth(entry.relativePath)) {
//           filteredEntries.pop();
//           topFilteredEntry = filteredEntries[filteredEntries.length-1];
//         }
//       }
//       filteredEntries.push(input);
//     } else if (isDirectory(entry) && chompPathSep(entry.relativePath).indexOf(cwd) > -1) {
//       // if filters didn't match, but entry is directory, keep the entry in
//       // a stack. We may need it if there is an entry that matched that
//       // requires us to mkdir the parent directories of the file
//       // eg. subdir1/subsubdir1/foo.png
//       //
//       // if the above matched, we must have mkdir for subdir1 and subsubdir1
//       const curDirDepth = getDirDepth(entry.relativePath);
//       while (dirStack.length !== 0 && dirDepth >= curDirDepth) {
//         dirStack.pop();
//         dirDepth--;
//       }
//       dirStack.push(input);
//       dirDepth = curDirDepth;
//     }


//   });

//   return filteredEntries;
// }

function setOptions(tree, options) {
  // here we need a variable for this.cwd, which later on, we will need to prepend options.cwdPostfix to it.
  //If changes is called from projections, then these wont be reset.
  if(options === undefined) {
    options = {
        filters : []
    }
  }
  return options;
}


FSTree.prototype.changes = function(options) {
  let filteredEntries = [];
  options = setOptions(this, options);
  // if srcTree is true or if srcTree is false and changes are empty
  // (might be a case when called from projections) then diff to find patches
  let shouldDiff = this.srcTree || (this._changes.length == 0 && options.fromProjection);
  if (shouldDiff) {
    return diffToFindPatches(this, filteredEntries, options);
  } else {
    return processChanges(this, filteredEntries, options);
  }
};

function diffToFindPatches(tree, filteredEntries, options) {
  let filtersForFiles = tree.files && tree.include.length === 0 && tree.exclude.length === 0;
  if (filtersForFiles) {
    tree._entriesFromFiles();
  } else {
    tree._ensureEntriesPopulated();
  }

  filteredEntries = tree._entries;

  let prevTree;
  if(options.fromProjection) {
    prevTree = FSTree.fromEntries([]);
  } else {
    prevTree = new FSTree.fromEntries(tree.prevEntries);
  }

  const newTree = FSTree.fromEntries(filteredEntries);
  const patches = prevTree.calculatePatch(newTree);
  tree.prevEntries = filteredEntries.slice();
  // if this.cwd is set, we should replace the relativePaths
  if (tree.cwd) {
    return patches.map(patch => {
      const cwd = ensureTrailingSlash(tree.cwd);
      let newEntry = Entry.cloneEntry(patch[2]);
      newEntry.relativePath = newEntry.relativePath.replace(tree.cwd, '');
      return [patch[0], patch[1].replace(cwd, ''), newEntry];
    });
  }

  return patches;
}

function processChanges(tree, filteredEntries, options) {
  tree._changes.forEach(change => {
    if(change[2]._projection) {
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

    let projectedTree = change[2]._projection.tree;

    if (effectiveCwd.startsWith(ensureTrailingSlash(change[1]))) {
      tree = chdir()
    //   options.cwdPostfix = effectiveCwd.replace(ensureTrailingSlash(change[1]), '')
    // } else {
    //   options.cwdPostfix = '';
    }

    // create filter
    const filter = { cwd: effectiveCwd, files : tree.files, include : tree.include, exclude: tree.exclude, transform : generatePathTransform(change) }
    options.filters.push(filter);

    // If projection is present call changes() recursively
    let projectedEntries = change[2]._projection.tree.changes(options);
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
    let newEntry = Entry.cloneEntry(change[2]);
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
    let newEntry = Entry.cloneEntry(projectedChange[2]);
    if (!ensureTrailingSlash(projectedChange[2].relativePath).startsWith(target)) {
      newEntry.relativePath = `${target}${projectedChange[2].relativePath}`;
    }
    projectedChange[2] = newEntry;
  });

  // 2. since we have entries from the current dir, unshift change onto projectedEntries
  change[0] = change[0] === 'mkdir' ? 'mkdirp' : change[0];
  projectedEntries.unshift([change[0], change[1], Entry.cloneEntry(change[2])]);
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
  const source = change[2]._projection.entry === ROOT ? '' : ensureTrailingSlash(change[2]._projection.entry.relativePath);

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
  const normalizedPath = this._normalizePath(relativePath);

  if (normalizedPath === '' || normalizedPath === '.' || normalizedPath === '/') {
    return this;
  }

  const allowEmpty = options && options.allowEmpty;
  const result = this.findByRelativePath(normalizedPath);

  if (result.entry) {
    if (isFile(result.entry)) {
      throw new Error(`ENOTDIR: not a directory, ${relativePath}`);
    }
  } else if (!allowEmpty) {
    throw new Error(`ENOENT: no such file or directory, ${relativePath}`);
  }

  return FSTree.fromParent(this, {
    cwd: normalizedPath,
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
  this._ensureEntriesPopulated();

  const result = this.findByRelativePath(relativePath);

  // if instead of this.root we asked the entry, we could emulate symlinks on
  // readFileSync. (there will be other things to do as well, for example
  // rmdir/unlink etc..
  if (result.entry === null) {
    throw new Error(`ENOENT: no such file or directory, ${relativePath}`);
  }

  return fs.readFileSync(this.resolvePath(relativePath), encoding);
};

// TODO: combine with throwIfStopped, once an appropriate name is selected
FSTree.prototype.throwIfChild = function(operation) {
  if (this.parent) {
    throw new Error(`Cannot '${operation}' on a projection.`);
  }
}

FSTree.prototype._throwIfStopped = function(operation) {
  if (this._state === STOPPED) {
    throw new Error('NOPE, operation: ' + operation);
  }
};

FSTree.prototype.unlinkSync = function(relativePath) {
  this._throwIfChild('unlink');
  this._throwIfStopped('unlink');
  this._ensureEntriesPopulated();

  let result = this.findByRelativePath(relativePath, { followSymlinks: false });
  var entry = result.entry;

  // only unlinkSync when entry !== null
  // TODO: find WHY entry can be null
  if (entry !== null) {
    fs.unlinkSync(path.join(result.tree.root, entry.relativePath));
    result.tree._track('unlink', entry);
    result.tree._removeAt(entry);
  }
};

FSTree.prototype.rmdirSync = function(relativePath) {
  this._throwIfChild('rmdir');
  this._throwIfStopped('rmdir');
  this._ensureEntriesPopulated();

  //var result = this.findByRelativePath(relativePath);
  let result = this.findByRelativePath(relativePath, { followSymlinks: false });
  var entry = result.entry;

  // only rmdirSync when entry !== null
  // TODO: find WHY entry can be null
  if (entry !== null) {
    fs.rmdirSync(path.join(result.tree.root, entry.relativePath));
    result.tree._track('rmdir', entry);
    result.tree._removeAt(entry);
  }
};

FSTree.prototype.mkdirSync = function(relativePath) {
  this._throwIfChild('mkdir');
  this._throwIfStopped('mkdir');
  this._ensureEntriesPopulated();

  const result = this.findByRelativePath(relativePath, {
    applyFilters: false,
    followSymlinks: false,
  });

  let entry = result.entry;

  if (entry) {
    if (isDirectory(entry)) {
      logger.info('mkdirSync %s noop, directory exists', relativePath);

      return;
    } else {
      throw new Error(`EEXIST: file already exists, mkdir '${relativePath}'`);
    }
  }

  let normalizedPath = this._normalizePath(relativePath);

  fs.mkdirSync(`${this.root}${normalizedPath}`);
  entry = new Entry(normalizedPath, 0, Date.now(), Entry.DIRECTORY_MODE, null);

  this._track('mkdir', entry);
  this._insertAt(entry);
};

FSTree.prototype.mkdirpSync = function(relativePath) {
  this._throwIfChild('mkdirp');
  this._throwIfStopped('mkdirp');
  this._ensureEntriesPopulated();

  let result = this.findByRelativePath(relativePath);
  let entry = result.entry;
  if (entry) {
    logger.info('mkdirpSync %s noop, directory exists', relativePath);
    return;
  }

  if(relativePath[0] === '/'){
    relativePath =relativePath.substr(1);
  }

  let paths = relativePath.split("/");
  let subsetPaths = [];

  // TODO: Its O(N2) should change it to O(N)
  for(let i = 0; i < paths.length; i ++ ) {
    if(i != 0) {
      subsetPaths[i] = subsetPaths[i-1] + "/" + paths[i];
    } else {
      subsetPaths[i] = paths[i];
    }
    let result = this.findByRelativePath(subsetPaths[i]);
    if(!result.entry) {
      this.mkdirSync(subsetPaths[i]);
    }
  }
};


FSTree.prototype.writeFileSync = function(relativePath, content, options) {
  this._throwIfChild('writeFile');
  this._throwIfStopped('writeFile');
  this._ensureEntriesPopulated();
  let result = this.findByRelativePath(relativePath, { followSymlinks: false });

  var entry = result.entry;
  // ensureFile, so throw if the entry is a directory
  var mode;
  // TODO: cleanup idempotent stuff
  var checksum = md5hex('' + content);

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

  let normalizedPath = this._normalizePath(relativePath);

  fs.writeFileSync(`${this.root}${normalizedPath}`, content, options);
  entry = new Entry(normalizedPath, content.length, Date.now(), mode || 0, checksum);
  var operation = result.entry ? 'change' : 'create';

  this._track(operation, entry);
  this._insertAt(entry);

};

FSTree.prototype.symlinkSync = function(target, relativePath /*, type */) {
  this._throwIfChild('symlink');
  this._throwIfStopped('symlink');
  this._ensureEntriesPopulated();

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
  this._throwIfChild('symlinkSyncFromEntry');
  this._throwIfStopped('symlinkSyncFromEntry');
  this._ensureEntriesPopulated();
  srcFSTree._ensureEntriesPopulated();

  const normalizedPath = this._normalizePath(destRelativePath);
  let tree = this;
  let parent = path.dirname(normalizedPath);

  if (parent !== ".") {
    // move it to mkdirp
    const result = this.leastExistingAncestor(parent);

    if (result.entry) {
      tree = result.tree;
      normalizedPath = tree._normalizePath(path.join(result.entry.relativePath, path.basename(normalizedPath)));
    }
  }

  let destPath = path.join(tree.root, normalizedPath);
  let sourceEntry;
  let srcAbsolutePath = srcFSTree.resolvePath(srcRelativePath);

  try {
    symlinkOrCopy.sync(srcAbsolutePath, destPath);
  } catch(e) {
    if (!existsSync(`${tree.root}${parent}`)) {
      tree.mkdirpSync(parent);
    }
    try {
      fs.unlinkSync(destPath);
    } catch(e) {}
    symlinkOrCopy.sync(srcAbsolutePath, destPath);
  }

  let entry = new Entry(normalizedPath, 0, Date.now(), Entry.DIRECTORY_MODE, null);
  let sourceTree;

  if (srcRelativePath === "/" || srcRelativePath === "." || srcRelativePath === "") {
    sourceEntry = ROOT;
  } else {
     let projection = srcFSTree.findByRelativePath(srcRelativePath, { followSymlinks: false});
     if(!projection.entry) {
       throw new Error(`ENOENT: no such file or directory, ${srcRelativePath}`)
     }
     sourceEntry = projection.entry;
  }

  sourceTree = srcFSTree.chdir(srcRelativePath);

  entry._projection = {tree: sourceTree, entry: sourceEntry};

  let operation = 'mkdir';

  tree._track(operation, entry);
  tree._insertAt(entry);
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
    throw new Error('NOPE, cannot reread a tree with a parent');
  }

  if (!this.srcTree) {
    if (newRoot && path.normalize(newRoot + path.sep) != this.root) {
      throw new Error(
        `Cannot change root from '${this.root}' to '${newRoot}' of a non-source tree.`
      );
    }
    // reread is a no-op if our entries is populated by an upstream plugin
    return;
  }

  if (newRoot) {
    this.root = path.normalize(path.resolve(newRoot) + path.sep);
  }

  // TODO: stash current entries so we can calculate a diff
  // don't eagerly read, but invalidate our current entries
  this._rawEntries = undefined;
};

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
    return this.parent._ensureEntriesPopulated();
  }

  this._rawEntries = walkSync.entries(this.root);
};

FSTree.prototype._track = function(operation, entry) {
  var relativePath = entryRelativePath(entry);
  // this._relativePathToChange[relativePath] = this._changes.push([
  //   operation,
  //   relativePath,
  //   entry
  // ]) - 1;

  this._changes.push([
    operation,
    relativePath,
    entry
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

    // we are at the end, and have not yet found an appropriate place, this
    // means the end is the appropriate place
    return this._rawEntries.push(entry);
  }
};

FSTree.prototype._removeAt = function(entry) {
  if (!entry) {
    return;
  }

  if (entry === ROOT) {
    throw new Error('NOPE, go back and try again; you probably missed a `followSymlinks` on a call to `findByRelativePath`.')
  }

  for (let position = 0; position < this._entries.length; ++position) {
    const current = this._entries[position];

    if (entryRelativePath(current) === entryRelativePath(entry)) {
      this._entries.splice(position, 1);

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

  if ((files !== null && files.length > 0) && (include.length > 0 || exclude.length > 0)) {
    throw new Error('Cannot pass files option (array or function) and a include/exlude filter. You can only have one or the other');
  }

  // previously, we always assumed cwd did not have a trailing slash, but that was not true
  if (cwd) {
    entryPath = entryPath.replace(cwd, '');
  }

  if (files !== null) {
    // include only if it matches an entry in files
    return files.indexOf(entryPath) > -1;
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
  var patch = this.calculatePatch(otherFSTree);
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
  var delegate = assign({}, DEFAULT_DELEGATE, _delegate);
  for (var i = 0; i < patch.length; i++) {
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
