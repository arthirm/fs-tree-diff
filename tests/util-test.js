'use strict';

const expect = require('chai').expect;
const Entry = require('../lib/entry');
const util = require('../lib/util');
const treeOptionHelpers = require('../lib/tree-option-helpers');

const entryRelativePath = util.entryRelativePath;
const commonPrefix = util.commonPrefix;
const basename = util.basename;
const compareChanges = util.compareChanges;
const computeImpliedEntries = treeOptionHelpers.computeImpliedEntries;
const sortAndExpand = treeOptionHelpers.sortAndExpand;

require('chai').config.truncateThreshold = 0;

describe('util', function() {
  const originalNow = Date.now;

  beforeEach(function() {
    Date.now = (() => 0);
  });

  afterEach(function() {
    Date.now = originalNow;
  });

  describe('.commonPrefix', function() {
    it('computes no common prefix if none exists', function() {
      expect(commonPrefix('a', 'b')).to.equal('');
    });

    it('computes the common prefix between two strings', function() {
      expect(commonPrefix('a/b/c/', 'a/b/c/d/e/f/', '/')).to.equal('a/b/c/');
    });

    it('strips the suffix (of the common prefix) after the last occurrence of the terminal character', function() {
      expect(commonPrefix('a/b/c/ohai', 'a/b/c/obai', '/')).to.equal('a/b/c/');
    });
  });

  describe('.basename', function() {
    it('computes the basename of files', function() {
      expect(basename(Entry.fromPath('a/b/c'))).to.equal('a/b/');
    });

    it('computes the basename of directories', function() {
      expect(basename(Entry.fromPath('a/b/c/'))).to.equal('a/b/');
    });
  });

  describe('.computeImpliedEntries', function() {
    it('computes implied entries', function() {
      let entries = computeImpliedEntries('a/b/', 'c/d/e/');

      expect(entries).to.deep.equal([
        new Entry('a/b/c/', 0, 0, Entry.DIRECTORY_MODE),
        new Entry('a/b/c/d/', 0, 0, Entry.DIRECTORY_MODE),
        new Entry('a/b/c/d/e/', 0, 0, Entry.DIRECTORY_MODE),
      ]);
    });

    it('does not compute existing entries', function() {
      let entries = computeImpliedEntries('a/', 'b/c/');

      expect(entries.map(e => e.relativePath)).to.deep.equal([
        'a/b', 'a/b/c'
      ]);
    });
  });

  describe('.sortAndExpand', function() {
    it('sorts and expands entries in place', function() {
      let entries = [
        'a/b/q/r/bar.js',
        'a/b/c/d/foo.js',
      ].map(e => Entry.fromPath(e));

      var sortedAndExpandedEntries = sortAndExpand(entries);

      expect(entries).to.equal(sortedAndExpandedEntries);
      expect(sortedAndExpandedEntries.map(function(e) { return e.relativePath;})).to.deep.equal([
        'a',
        'a/b',
        'a/b/c',
        'a/b/c/d',
        'a/b/c/d/foo.js',
        'a/b/q',
        'a/b/q/r',
        'a/b/q/r/bar.js',
      ]);
      expect(sortedAndExpandedEntries).to.deep.equal([
        new Entry('a', 0, 0, Entry.DIRECTORY_MODE),
        new Entry('a/b', 0, 0, Entry.DIRECTORY_MODE),
        new Entry('a/b/c', 0, 0, Entry.DIRECTORY_MODE),
        new Entry('a/b/c/d', 0, 0, Entry.DIRECTORY_MODE),
        new Entry('a/b/c/d/foo.js', 0, 0, 0),
        new Entry('a/b/q', 0, 0, Entry.DIRECTORY_MODE),
        new Entry('a/b/q/r', 0, 0, Entry.DIRECTORY_MODE),
        new Entry('a/b/q/r/bar.js', 0, 0, 0),
      ]);
    });
  });

  describe('.entryRelativePath', function() {
    it('strips nothing for file entries', function() {
      expect(entryRelativePath(new Entry('my-path', 0, 0, 0))).to.eql('my-path');
      expect(entryRelativePath(new Entry('my-path/', 0, 0, 0))).to.eql('my-path/');
      expect(entryRelativePath(new Entry('my-path\\', 0, 0, 0))).to.eql('my-path\\');
    });

    it('strips trailing / or \\ for directory entries', function() {
      expect(
        entryRelativePath(new Entry('my-path', 0, 0, Entry.DIRECTORY_MODE))
      ).to.eql('my-path');
      expect(
        entryRelativePath(new Entry('my-path/', 0, 0, Entry.DIRECTORY_MODE))
      ).to.eql('my-path');
      expect(
        entryRelativePath(new Entry('my-path\\', 0, 0, Entry.DIRECTORY_MODE))
      ).to.eql('my-path');
    });
  });

  describe('.compareChanges', () => {
    it('sorts remove operations together', () => {
      expect(compareChanges(['rmdir', ''], ['rmdir', ''])).to.equal(0);
      expect(compareChanges(['rmdir', ''], ['unlink', ''])).to.equal(0);
      expect(compareChanges(['unlink', ''], ['rmdir', ''])).to.equal(0);
      expect(compareChanges(['unlink', ''], ['unlink', ''])).to.equal(0);
    });

    it('sorts add/update operations together', () => {
      expect(compareChanges(['change', ''], ['change', ''])).to.equal(0);
      expect(compareChanges(['change', ''], ['create', ''])).to.equal(0);
      expect(compareChanges(['change', ''], ['mkdir', ''])).to.equal(0);
      expect(compareChanges(['create', ''], ['change', ''])).to.equal(0);
      expect(compareChanges(['create', ''], ['create', ''])).to.equal(0);
      expect(compareChanges(['create', ''], ['mkdir', ''])).to.equal(0);
      expect(compareChanges(['mkdir', ''], ['change', ''])).to.equal(0);
      expect(compareChanges(['mkdir', ''], ['create', ''])).to.equal(0);
      expect(compareChanges(['mkdir', ''], ['mkdir', ''])).to.equal(0);
    });

    it('sorts remove operations above add/update operations', () => {
      expect(compareChanges(['rmdir', ''], ['mkdir', ''])).to.equal(-1);
      expect(compareChanges(['mkdir', ''], ['rmdir', ''])).to.equal(1);
    });

    it('sorts remove operations in reverse lexicographic order', () => {
      expect(compareChanges(['rmdir', 'a'], ['rmdir', 'b'])).to.equal(1);
      expect(compareChanges(['rmdir', 'b'], ['rmdir', 'a'])).to.equal(-1);
    });

    it('sorts add/update operations in lexicographic order', () => {
      expect(compareChanges(['mkdir', 'a'], ['mkdir', 'b'])).to.equal(-1);
      expect(compareChanges(['mkdir', 'b'], ['mkdir', 'a'])).to.equal(1);
    });

    it('sorts by operation before path', () => {
      expect(compareChanges(['rmdir', 'a'], ['mkdir', 'b'])).to.equal(-1);
      expect(compareChanges(['rmdir', 'b'], ['mkdir', 'a'])).to.equal(-1);
      expect(compareChanges(['mkdir', 'a'], ['rmdir', 'b'])).to.equal(1);
      expect(compareChanges(['mkdir', 'b'], ['rmdir', 'a'])).to.equal(1);
    });
  });
});
