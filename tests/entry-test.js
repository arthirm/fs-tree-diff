'use strict';

const fs = require('fs-extra');
const expect = require('chai').expect;
const Entry = require('../lib/entry');

const isDirectory = Entry.isDirectory;

const FIXTURE_DIR = 'fixture';

require('chai').config.truncateThreshold = 0;

describe('Entry', function() {
  describe('constructor', function() {
    var size = 1337;
    var mtime = Date.now();

    it('supports including manually defined mode', function() {
      var entry = new Entry('/foo.js', size, mtime, 1);
      expect(entry.relativePath).to.equal('/foo.js');
      expect(entry.size).to.equal(size);
      expect(entry.mtime).to.equal(mtime);
      expect(entry.mode).to.equal(1);
      expect(isDirectory(entry)).to.not.be.ok;
    });

    it('errors on a non-number mode', function() {
      expect(function() {
        return new Entry('/foo.js', size, mtime, '1');
      }).to.throw('Expected `mode` to be of type `number` but was of type `string` instead.')
    });

    it('strips trailing /', function() {
      expect(new Entry('/foo/', 0, 0, Entry.DIRECTORY_MODE).relativePath).to.eql('foo');
    });
  });

  describe('#isDirectory', () => {
    it('returns false for files', () => {
      expect(new Entry('foo.js', 0, 0, 0o100777).isDirectory()).to.be.false;
    });

    it('returns true for directories', () => {
      expect(new Entry('foo/', 0, 0, 0o40777).isDirectory()).to.be.true;
    });

    it('returns false for symlinks to files', () => {
      const symlink = new Entry('foo.js', 0, 0, 0);

      symlink._symlink = {
        tree: { root: '/i/am/a/tree/' },
        entry: new Entry('bar.js', 0, 0, 0o100777),
      };

      expect(symlink.isDirectory()).to.be.false;
    });

    it('returns true for symlinks to directories', () => {
      const symlink = new Entry('foo/', 0, 0, 0);

      symlink._symlink = {
        tree: { root: '/i/am/a/tree/' },
        entry: 'root',
      };

      expect(symlink.isDirectory()).to.be.true;
    });
  });

  describe('.clone', () => {
    it('clones Entry instances', () => {
      const entry = new Entry('foo.js', 0, 0, 0);
      const clone = Entry.clone(entry);

      entry.mode = 32768;

      expect(clone).to.be.an.instanceOf(Entry);
      expect(clone).to.not.equal(entry);
      expect(clone.mode).to.equal(0);
    });

    it('clones ad-hoc entries (e.g. from walkSync)', () => {
      const entry = { relativePath: 'foo.js', size: 0, mtime: 0, mode: 0 };
      const clone = Entry.clone(entry);

      entry.mode = 32768;

      expect(clone).to.be.an.instanceOf(Entry);
      expect(clone).to.not.equal(entry);
      expect(clone.mode).to.equal(0);
    });

    // This occurs when walkSync encounters a broken symlink.
    it('clones entries with a mode of `undefined`', () => {
      const entry = { mode: undefined };

      let clone;

      expect(() => clone = Entry.clone(entry)).to.not.throw();
      expect(clone).to.have.property('mode', undefined);
    });

    it('preserves symlinks', () => {
      const entry = new Entry('foo.js', 0, 0, 0);

      entry._symlink = {
        tree: { root: '/i/am/a/tree/' },
        entry: new Entry('bar.js', 0, 0, 0),
      };

      const clone = Entry.clone(entry);

      expect(clone._symlink).to.be.ok;
      expect(clone._symlink.tree).to.equal(entry._symlink.tree);
      expect(clone._symlink.entry).to.equal(entry._symlink.entry);
    });

    it('replaces the relativePath, if provided', () => {
      const entry = new Entry('foo.js', 0, 0, 0);
      const clone = Entry.clone(entry, 'bar/foo.js');

      expect(clone.relativePath).to.equal('bar/foo.js');
    });
  });

  describe('.fromPath', function () {
    it('infers directories from trailing /', function() {
      let entry = Entry.fromPath('/foo/');
      expect(entry.relativePath).to.equal('foo');
      expect(isDirectory(entry)).to.eql(true);
    });

    it('infers files from lack of trailing /', function() {
      let entry = Entry.fromPath('/foo');
      expect(entry.relativePath).to.equal('/foo');
      expect(isDirectory(entry)).to.eql(false);
    });
  });

  describe('.fromStat', function() {
    afterEach(function() {
      fs.removeSync(FIXTURE_DIR);
    });

    it('creates a correct entry for a file', function() {
      var path = FIXTURE_DIR + '/index.js';

      fs.outputFileSync(path, '');

      var stat = fs.statSync(path);
      var entry = Entry.fromStat(path, stat);

      expect(isDirectory(entry)).to.not.be.ok;
      expect(entry.mode).to.equal(stat.mode);
      expect(entry.size).to.equal(stat.size);
      expect(entry.mtime).to.equal(stat.mtime);
      expect(entry.relativePath).to.equal(path);

      fs.unlinkSync(path);
    });

    it('creates a correct entry for a directory', function() {
      var path = FIXTURE_DIR + '/foo/';

      fs.mkdirpSync(path);

      var stat = fs.statSync(path);
      var entry = Entry.fromStat(path, stat);

      expect(isDirectory(entry)).to.be.ok;
      expect(entry.mode).to.equal(stat.mode);
      expect(entry.size).to.equal(stat.size);
      expect(entry.mtime).to.equal(stat.mtime);
      expect(entry.relativePath).to.equal(FIXTURE_DIR + '/foo');
    });
  });
});
