'use strict';

const util = require('./util');

const chompLeadAndTrailingPathSep = util.chompLeadAndTrailingPathSep;
const isDirectory = util.isDirectory;
const isFile = util.isFile;
const isSymlink = util.isSymlink;

const ARBITRARY_START_OF_TIME = 0;
const DIRECTORY_MODE = 0o40777;
const SYMLINK_MODE = 0o120777;

module.exports = Entry;

function Entry(relativePath, size, mtime, mode, checksum) {
  const modeType = typeof mode;

  if (modeType !== 'number') {
    throw new TypeError('Expected `mode` to be of type `number` but was of type `' + modeType + '` instead.');
  }

  this.mode = mode;
  // ----------------------------------------------------------------------
  // required properties
  this.relativePath = isDirectory(this) ? chompLeadAndTrailingPathSep(relativePath) : relativePath;
  this.size = size;
  this.mtime = mtime;
  this.checksum = checksum;
}

Entry.isDirectory = isDirectory;
Entry.isFile = isFile;
Entry.isSymlink = isSymlink;

Entry.clone = function(originalEntry, newRelativePath) {
  const newEntry = Object.create(Entry.prototype);

  Object.keys(originalEntry).forEach(key => {
    newEntry[key] = originalEntry[key];
  });

  if (typeof newRelativePath !== 'undefined') {
    newEntry.relativePath = newRelativePath;
  }

  return newEntry;
}

Entry.fromStat = function(relativePath, stat) {
  return new this(relativePath, stat.size, stat.mtime, stat.mode);
};

Entry.fromPath = function (relativePath) {
  const mode = relativePath.charAt(relativePath.length - 1) === '/' ? DIRECTORY_MODE : 0;

  return new this(relativePath, 0, ARBITRARY_START_OF_TIME, mode);
}

Entry.DIRECTORY_MODE = DIRECTORY_MODE;
Entry.SYMLINK_MODE = SYMLINK_MODE;

Entry.prototype.isDirectory = function() {
  return isDirectory(this);
}
