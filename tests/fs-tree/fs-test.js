'use strict';

const fs = require('fs-extra');
const path = require('path');
const expect = require('chai').expect;
const walkSync = require('walk-sync');
const FSTree = require('../../lib/index');
const Entry = require('../../lib/entry');
const md5hex = require('md5hex');
const fixturify = require('fixturify');
const rimraf = require('rimraf');
const oneLine = require('common-tags').oneLine;

const util = require('./util');
const file = util.file;
const directory = util.directory;

const isDirectory = Entry.isDirectory;

require('chai').config.truncateThreshold = 0;

/** Convert an array of changes into simpler, more comparable objects.
 * 
 * Sanitizes entries using sanitizeEntry and strips trailing slashes from
 * change[1].
 * 
 * If no entry is provided with a change (i.e. the change contains only two
 * elements), an entry will be created based on the operation.
 */
function sanitizeChanges(changes) {
  return changes.map(change => {
    let entry = change[2];

    if (!entry) {
      entry = /mkdirp?|rmdir/.test(change[0]) ? directory(change[1]) : file(change[1]);
    }

    return [change[0], change[1].replace(/\/$/, ''), sanitizeEntry(entry)];
  });
}

/** Sanitize an array of entries using sanitizeEntry. */
function sanitizeEntries(entries) {
  return entries.map(sanitizeEntry);
}

/** Reduces an entry to a simpler, more comparable object.
 * 
 * Only mode and relativePath are retained, the latter with any trailing slash
 * stripped.
 */
function sanitizeEntry(entry) {
  return {
    mode: sanitizeMode(entry.mode),
    relativePath: entry.relativePath.replace(/\/$/, ''),
  };
}

/** Discard permission bits in mode.
 * 
 * Sanitizes a mode by retaining only the type bits.  Further, normal files are
 * translated to a mode of 0, as is the conventional representation in this
 * library.
 */
function sanitizeMode(mode) {
  const type = mode & 61440;  // only retain type bits

  return type === 32768 ? 0 : type;  // return normal files as 0
}

/** Creates an FSTree by walking a root directory. */
function treeFromDisk(root, srcTree) {
  return new FSTree({
    entries: walkSync.entries(root),
    root,
    srcTree,
  });
}

describe('FSTree fs abstraction', function() {
  const ROOT = path.resolve('tmp/fs-test-root/');
  const ROOT2 = path.resolve('tmp/fs-test-root2/');
  const ROOT3 = path.resolve('tmp/fs-test-root3/');

  const originalNow = Date.now;

  let tree;   // Used in most tests.
  let tree2;  // Used in tests which employ symlinkSyncFromEntry.
  let tree3;  // Used in a few tests which symlinkSyncFromEntry multiple trees.

  beforeEach(function() {
    Date.now = (() => 0);

    rimraf.sync(ROOT);
    rimraf.sync(ROOT2);
    rimraf.sync(ROOT3);

    fs.mkdirpSync(ROOT);
    fs.mkdirpSync(ROOT2);
    fs.mkdirpSync(ROOT3);

    fixturify.writeSync(ROOT, {
      'hello.txt': 'Hello, World!\n',
      'my-directory': {},
    });

    tree = treeFromDisk(ROOT);
    tree2 = treeFromDisk(ROOT2);
    tree3 = treeFromDisk(ROOT3);
  });

  afterEach(function() {
    Date.now = originalNow;

    fs.removeSync(ROOT);
    fs.removeSync(ROOT2);
    fs.removeSync(ROOT3);
  });

  describe('fs', function() {
    describe('with parents', function() {
      let childTree;

      beforeEach(function() {
        childTree = FSTree.fromParent(tree);
      });

      it('shares _hasEntries and can populate from parent', function() {
        const lazyTree = new FSTree({
          entries: null,
          root: ROOT,
        });

        childTree = new FSTree({
          parent: lazyTree,
        });

        expect(lazyTree._hasEntries).to.be.false;
        expect(childTree._hasEntries).to.be.false;

        lazyTree._ensureEntriesPopulated();

        expect(lazyTree._hasEntries).to.be.true;
        expect(childTree._hasEntries).to.be.true;
      });

      it('shares _hasEntries and can populate from child', function() {
        const lazyTree = new FSTree({
          entries: null,
          root: ROOT,
        });
        childTree = FSTree.fromParent(lazyTree);

        expect(lazyTree._hasEntries).to.be.false;
        expect(childTree._hasEntries).to.be.false;

        childTree._ensureEntriesPopulated();

        expect(lazyTree._hasEntries).to.be.true;
        expect(childTree._hasEntries).to.be.true;
      });
    });

    describe('.srcTree', function() {
      it('defaults to false', function() {
        expect(new FSTree({
          root: ROOT
        })).to.have.property('srcTree', false);
      });

      it('can be specified as an option', function() {
        expect(new FSTree({
          srcTree: true,
          root: ROOT,
        })).to.have.property('srcTree', true);
      });

      it('matches parent value for projections', () => {
        tree = new FSTree({
          root: ROOT,
          srcTree: true,
        });

        expect(tree.filtered({ files: ['hello.txt']}).srcTree).to.be.true;
        expect(tree2.filtered({ files: ['hello.txt']}).srcTree).to.be.false;
      });
    });

    describe('.reread', function() {
      it('resets entries for source trees', function() {
        tree = new FSTree({
          root: `${ROOT}/my-directory`,
          srcTree: true,
        });

        expect(tree.walkPaths()).to.deep.equal([]);

        fixturify.writeSync(`${ROOT}/my-directory`, {
          a: {
            b: 'hello',
          },
          a2: 'guten tag'
        });

        tree.reread();

        expect(tree.walkPaths()).to.deep.equal([
          'a/',
          'a/b',
          'a2'
        ]);
      });

      it('does not reset entries for non-source trees', function() {
        tree = new FSTree({
          root: `${ROOT}/my-directory`,
          srcTree: false,
        });

        expect(tree.walkPaths()).to.deep.equal([]);

        fixturify.writeSync(`${ROOT}/my-directory`, {
          a: {
            b: 'hello',
          },
          a2: 'guten tag'
        });

        tree.reread();

        expect(tree.walkPaths()).to.deep.equal([]);
      });

      it('does not reset entries for non-source trees when new root matches old root', () => {
        tree = new FSTree({
          root: `${ROOT}/my-directory`,
          srcTree: false,
        });

        expect(tree.walkPaths()).to.deep.equal([]);

        fixturify.writeSync(`${ROOT}/my-directory`, {
          a: {
            b: 'hello',
          },
          a2: 'guten tag'
        });

        tree.reread(`${ROOT}/my-directory`);

        expect(tree.walkPaths()).to.deep.equal([]);
      });

      it('can change roots for source trees', function() {
        fixturify.writeSync(`${ROOT}/my-directory`, {
          a: {
            b: 'hello',
          },
          a2: 'guten tag'
        });

        tree = new FSTree({
          root: `${ROOT}/my-directory`,
          srcTree: true,
        });

        expect(tree.walkPaths()).to.deep.equal([
          'a/',
          'a/b',
          'a2'
        ]);

        tree.reread(`${ROOT}/my-directory/a`);

        expect(tree.walkPaths()).to.deep.equal([
          'b',
        ]);

        expect(tree.root).to.equal(`${ROOT}/my-directory/a/`);
      });

      it('can change roots for source trees without providing absolute path', function() {
        fixturify.writeSync(`${ROOT}/my-directory/`, {
          a: {
            b: 'hello',
          },
          a2: 'guten tag'
        });

        tree = new FSTree({
          root: `${ROOT}`,
          srcTree: true,
        });

        expect(tree.walkPaths()).to.deep.equal([
          'hello.txt',
          'my-directory/',
          'my-directory/a/',
          'my-directory/a/b',
          'my-directory/a2'
        ]);

        //when the absolute path is not passed to reread, it should convert the path to absolute path
        tree.reread(`tmp/fs-test-root/my-directory/a`);
        expect(tree.walkPaths()).to.deep.equal([
          'b',
        ]);
      });

      it('throws if called with a new root for a non-source tree', function() {
        fixturify.writeSync(`${ROOT}/my-directory`, {
          a: {
            b: 'hello',
          },
          a2: 'guten tag'
        });

        tree = new FSTree({
          root: `${ROOT}/my-directory`,
          srcTree: false,
        });

        expect(tree.walkPaths()).to.deep.equal([
          'a/',
          'a/b',
          'a2'
        ]);

        expect(function() {
          tree.reread(`${ROOT}/my-directory/a`);
        }).to.throw(oneLine`
          Cannot change root from '${ROOT}/my-directory/' to
          '${ROOT}/my-directory/a' of a non-source tree.
        `);
      });

      it('throws for trees with parents', () => {
        tree = new FSTree({
          root: `${ROOT}`,
          srcTree: true,
        });

        tree2 = tree.chdir('my-directory');

        expect(() => {
          tree2.reread(`${ROOT}`);
        }).to.throw(/parent/);
      });
    });

    describe('.findByRelativePath', function () {
      it('missing file', function () {
        expect(tree.findByRelativePath('missing/file')).to.deep.equal({
          entry: null,
          tree: null,
        });
      });

      it('file', function () {
        let result = tree.findByRelativePath('hello.txt');
        let entry = result.entry;

        expect(entry).to.not.be.null;
        expect(entry).to.have.property('relativePath', 'hello.txt');
        expect(entry).to.have.property('mode');
        expect(entry).to.have.property('size');
        expect(entry).to.have.property('mtime');
      });

      it('missing directory', function () {
        expect(tree.findByRelativePath('missing/directory')).to.deep.equal({
          entry: null,
          tree: null,
        });
      });

      it('directory with trailing slash', function () {
        const result = tree.findByRelativePath('my-directory/');
        const entry = result.entry;

        expect(entry).to.not.be.null;
        expect(entry).to.have.property('relativePath', 'my-directory/');
        expect(entry).to.have.property('mode');
        expect(entry).to.have.property('size');
        expect(entry).to.have.property('mtime');
      });

      it('directory without trailing slash', function () {
        let result = tree.findByRelativePath('my-directory');
        let entry = result.entry;

        expect(entry).to.not.be.null;
        // we can findByRelativePath without the trailing /, but we get back the
        // same entry we put in, from walk-sync this will have a trailing /
        expect(entry).to.have.property('relativePath', 'my-directory/');
        expect(entry).to.have.property('mode');
        expect(entry).to.have.property('size');
        expect(entry).to.have.property('mtime');
      });

      it('finds root', function() {
        const result = tree.findByRelativePath('');

        expect(result.entry).to.equal('root');
      });

      it('normalizes paths', function() {
        expect(tree.findByRelativePath('my-directory/').entry).to.not.be.null;
        expect(tree.findByRelativePath('my-directory/.').entry).to.not.be.null;
        expect(tree.findByRelativePath('my-directory/foo/..').entry).to.not.be.null;
      });

      it('get entry for file from projections', function() {
        tree.mkdirSync('my-directory/bar');
        tree.writeFileSync('my-directory/bar/baz', 'hello');
        tree2.symlinkSyncFromEntry(tree, 'my-directory', 'b')

        expect(tree2.findByRelativePath('b/bar/baz').entry).to.not.be.null;
      });

      it('get entry for a directory from projections', function() {
        tree.mkdirpSync('my-directory/bar/baz/');
        tree2.symlinkSyncFromEntry(tree, 'my-directory', 'b')

        expect(tree2.findByRelativePath('b/bar/baz/').entry).to.not.be.null;
      });

      it('get entry for a file missing in projections', function() {
        tree.mkdirSync('my-directory/bar');
        tree.writeFileSync('my-directory/bar/baz', 'hello');
        tree2.symlinkSyncFromEntry(tree, 'my-directory', 'b')

        expect(tree2.findByRelativePath('b/bar/baz/abc').entry).to.be.null;
      });

      it('get entry for a directory found in second level projections', function() {
        tree.mkdirpSync('my-directory/bar/baz');
        tree2.mkdirSync('a');
        tree2.symlinkSyncFromEntry(tree, 'my-directory/bar', 'a/foo');
        tree3.symlinkSyncFromEntry(tree2, 'a', 'b');

        expect(tree3.findByRelativePath('b/foo/baz').entry).to.not.be.null;
      });

      it('correctly travserses root links', function() {
        tree2.symlinkSyncFromEntry(tree, '/', 'abc')

        expect(tree2.findByRelativePath('abc/my-directory').entry).to.not.be.null;
      });
    });

    it('does not allow non-absolute paths', function() {
      expect(function() {
        new FSTree({ root: null })
      }).to.throw(`Root must be an absolute path, tree.root: 'null'`);

      expect(function() {
        new FSTree({ root: '' })
      }).to.throw(`Root must be an absolute path, tree.root: ''`);

      expect(function() {
        new FSTree({ root: 'foo' })
      }).to.throw(`Root must be an absolute path, tree.root: 'foo'`);
    });

    it('ensures trailing slash for root', function() {
      expect(new FSTree({ root: '/foo' }).root).to.equal('/foo/');
      expect(new FSTree({ root: '/foo/' }).root).to.equal('/foo/');
      expect(new FSTree({ root: '/foo//' }).root).to.equal('/foo/');
    });

    describe('.readFileSync', function() {
      describe('start/stop', function() {
        it('does not error when stopped', function() {
          tree.stop();
          expect(tree.readFileSync('hello.txt', 'UTF8')).to.equal('Hello, World!\n');
        });
      });

      it('reads existing file', function() {
        expect(tree.readFileSync('hello.txt', 'UTF8')).to.equal('Hello, World!\n');
      });

      it('throws for missing file', function() {
        expect(function() {
          tree.readFileSync('missing.txt', 'UTF8');
        }).to.throw('ENOENT: no such file or directory, open \'missing.txt\'');
      });

      describe('from symlinks', function()  {
        it('reads file in a symlinked directory', function() {
          tree.writeFileSync('my-directory/baz.txt', 'baz');
          tree2.symlinkSyncFromEntry(tree, 'my-directory', 'c');

          expect(tree2.findByRelativePath('c/baz.txt').entry).to.not.be.null;
          expect(tree2.readFileSync('c/baz.txt', 'UTF8')).to.equal('baz');
        });
      });
    });

    describe('.writeFileSync', function() {
      it('throws when stopped', function() {
        tree.stop();

        expect(function() {
          tree.writeFileSync('hello.txt', 'OMG');
        }).to.throw(/stopped/);

        expect(function() {
          tree.writeFileSync('hello.txt', 'OMG');
        }).to.throw(/writeFile/);
      });

      it('adds new file', function() {
        expect(tree.walkPaths()).to.deep.equal([
          'hello.txt',
          'my-directory/',
        ]);

        tree.writeFileSync('new-file.txt', 'new file');

        const entry = tree.findByRelativePath('new-file.txt').entry;

        expect(entry).to.not.be.null;
        expect(entry.relativePath).to.equal('new-file.txt');
        expect(entry.checksum).to.equal(md5hex('new file'));
        expect(entry.mode).to.equal(0);
        expect(entry).to.have.property('mtime');
        expect(tree.readFileSync('new-file.txt', 'UTF8')).to.equal('new file');

        expect(tree.walkPaths()).to.deep.equal([
          'hello.txt',
          'my-directory/',
          'new-file.txt',
        ]);
      });

      it('tracks a change', function() {
        expect(tree.changes()).to.deep.equal([]);

        tree.writeFileSync('new-file.txt', 'new file');

        expect(sanitizeChanges(tree.changes())).to.deep.equal(sanitizeChanges([
          ['create', 'new-file.txt'],
        ]));
      });

      describe('idempotent', function() {
        it('is idempotent files added this session', function() {
          const old = fs.statSync(tree.root + 'hello.txt');
          const oldContent = fs.readFileSync(path.join(tree.root, 'hello.txt'));

          tree.writeFileSync('hello.txt', oldContent);

          const current = fs.statSync(tree.root + 'hello.txt');

          expect(old.mtime.getTime()).to.equal(current.mtime.getTime());
          expect(old.mode).to.equal(current.mode);
          expect(old.size).to.equal(current.size);
          expect(tree.changes()).to.deep.equal([]);

          expect(tree.walkPaths()).to.deep.equal([
            'hello.txt',
            'my-directory/',
          ]);
        });

        it('is idempotent across session', function() {
          tree.writeFileSync('new-file.txt', 'new file');

          const oldChanges = tree.changes();

          tree.writeFileSync('new-file.txt', 'new file');

          expect(oldChanges).to.deep.equal(tree.changes());
        });
      });

      describe('update', function() {
        it('tracks and correctly updates a file -> file', function() {
          tree.writeFileSync('new-file.txt', 'new file');

          let old = fs.statSync(path.join(tree.root, 'new-file.txt'));

          tree.stop();
          tree.start();
          tree.writeFileSync('new-file.txt', 'new different content');

          let current = fs.statSync(path.join(tree.root, 'new-file.txt'));

          expect(current).to.have.property('mtime');
          expect(current.mode).to.equal(old.mode);
          expect(current.size).to.equal(21);

          expect(sanitizeChanges(tree.changes())).to.deep.equal(sanitizeChanges([
            ['change', 'new-file.txt'],
          ]));
        });
      });

      it('throws across projections', function() {
        tree.symlinkSyncFromEntry(tree, 'my-directory', 'other-directory');

        expect(function() {
          tree.writeFileSync('other-directory/foo.txt', 'foo');
        }).to.throw(/symlink/i);
      });
    });

    describe('.symlinkSyncFromEntry', function() {
      it('symlink from root to destDir', function() {
        tree2.symlinkSyncFromEntry(tree, '/', 'b')

        const result = tree2.findByRelativePath('b', { followSymlinks: false });

        expect(result.entry).to.not.be.null;
        expect(result.entry._symlink.tree).to.equal(tree);
      });

      it('when only top level directory is symlinked', function() {
        tree.mkdirSync('my-directory/bar');
        tree.writeFileSync('my-directory/bar/baz', 'hello');
        tree2.symlinkSyncFromEntry(tree, 'my-directory', 'b');

        const result = tree2.findByRelativePath('b', { followSymlinks: false });

        expect(result.entry).to.not.be.null;
        expect(result.entry._symlink.tree.walkPaths()).to.deep.equal([
          'bar',
          'bar/baz',
        ]);
      });

      it('throws across projections', function() {
        tree.mkdirSync('foo');
        tree2.symlinkSyncFromEntry(tree, 'my-directory', 'other-directory');

        expect(function() {
          tree2.symlinkSyncFromEntry(tree, 'foo', 'other-directory/foo');
        }).to.throw(/symlink/i);
      });

      it('when destDir already exists', function() {
        tree.mkdirSync('my-directory/bar');
        tree.writeFileSync('my-directory/bar/baz', 'hello');
        tree2.mkdirSync('abc');
        tree2.writeFileSync('abc/xyz', 'hello');

        expect(function() {
          tree2.symlinkSyncFromEntry(tree, 'my-directory', 'abc');
        }).to.throw(/EEXIST/);

      });

      it('when destfile already exists', function() {
        tree2.writeFileSync('b', 'hello');

        expect(() => {
          tree2.symlinkSyncFromEntry(tree, 'my-directory', 'b');
        }).to.throw(/EEXIST/);
      });

      it('when srcdir does not exist', function() {
        expect(function() {
          tree2.symlinkSyncFromEntry(tree, 'a', 'b')
        }).to.throw(/ENOENT/);
      });
    });

    describe('.symlinkSync', function() {
      it('symlinks files', function() {
        expect(tree.symlinkSync(`${tree.root}hello.txt`, 'my-link'));
        expect(tree.readFileSync('my-link', 'UTF8')).to.equal('Hello, World!\n');

        expect(tree.walkPaths()).to.deep.equal([
          'hello.txt',
          'my-directory/',
          'my-link',
        ]);
      });

      it('tracks a change', function() {
        expect(tree.changes()).to.deep.equal([]);

        expect(sanitizeChanges(tree.changes())).to.deep.equal(sanitizeChanges([
          ['create', 'my-link'],
        ]));
      });

      describe('idempotent', function() {
        it('is idempotent files added this session', function() {
          fs.symlinkSync(`${tree.root}hello.txt`, `${tree.root}hi`);

          let stat = fs.statSync(`${tree.root}hi`);
          let entry = new Entry('hi', stat.size, stat.mtime, stat.mode, `${tree.root}hello.txt`);

          tree.addEntries([entry]);

          let old = fs.statSync(tree.root + 'hi');

          tree.symlinkSync(`${tree.root}hello.txt`, 'hi');

          let current = fs.statSync(tree.root + 'hi');

          expect(old.mtime.getTime()).to.equal(current.mtime.getTime());
          expect(old).to.have.property('mode', current.mode);
          expect(old).to.have.property('size', current.size);
          expect(tree.changes()).to.deep.equal([]);

          expect(tree.walkPaths()).to.deep.equal([
            'hello.txt',
            'hi',
            'my-directory/',
          ]);
        });

        it('is idempotent across session', function() {
          tree.symlinkSync(`${tree.root}hello.txt`, 'hejsan');

          const oldChanges = tree.changes();

          tree.symlinkSync(`${tree.root}hello.txt`, 'hejsan');

          expect(tree.changes()).to.deep.equal(oldChanges);
        });
      });

      describe('update', function() {
        it('tracks and correctly updates a file -> file', function() {
          tree.symlinkSync(path.join(tree.root, 'hello.txt'), 'hi');

          let old = fs.statSync(path.join(tree.root, 'hi'));

          tree.stop();
          tree.start();
          tree.writeFileSync('hi', 'new different content');

          let current = fs.statSync(path.join(tree.root, 'hi'));

          expect(current).to.have.property('mtime');
          expect(current.mode).to.equal(old.mode);
          expect(current.size).to.equal(21);

          expect(sanitizeChanges(tree.changes())).to.deep.equal(sanitizeChanges([
            ['change', 'hi'],
          ]));
        });
      });

      it('throws across projections', function() {
        tree.writeFileSync('foo.txt', 'foo');
        tree.symlinkSyncFromEntry(tree, 'my-directory', 'other-directory');

        expect(function() {
          tree.symlinkSync(`${tree.root}foo.txt`, 'other-directory/foo.txt');
        }).to.throw(/symlink/i);
      });
    });

    describe('.unlinkSync', function() {
      it('removes files', function() {
        tree.unlinkSync('hello.txt');

        expect(tree.walkPaths()).to.deep.equal([
          'my-directory/',
        ]);
      });

      it('tracks a change', function() {
        tree.unlinkSync('hello.txt');

        expect(sanitizeChanges(tree.changes())).to.deep.equal(sanitizeChanges([
          ['unlink', 'hello.txt'],
        ]));
      });

      it('removes symlinked directories', function() {
        tree.symlinkSync(path.join(tree.root, 'my-directory'), 'linked-dir');
        tree.unlinkSync('linked-dir');

        expect(tree.walkPaths()).to.deep.equal([
          'hello.txt',
          'my-directory/',
        ]);
      });

      it('throws when stopped', function() {
        tree.stop();

        expect(function() {
          tree.unlinkSync('hello.txt');
        }).to.throw(/stopped/);

        expect(function() {
          tree.unlinkSync('hello.txt');
        }).to.throw(/unlink/);
      });

      it('throws across projections', function() {
        tree.writeFileSync('my-directory/foo.txt', 'foo');
        tree.symlinkSyncFromEntry(tree, 'my-directory', 'other-directory');

        expect(function() {
          tree.unlinkSync('other-directory/foo.txt');
        }).to.throw(/symlink/i);
      });
    });

    describe('.rmdirSync', function() {
      it('removes directories', function() {
        expect(tree.walkPaths()).to.deep.equal([
          'hello.txt',
          'my-directory/',
        ]);

        tree.rmdirSync('my-directory');

        expect(tree.walkPaths()).to.deep.equal([
          'hello.txt',
        ]);
      });

      it('tracks a change', function() {
        expect(tree.changes()).to.deep.equal([]);

        tree.rmdirSync('my-directory');

        expect(sanitizeChanges(tree.changes())).to.deep.equal(sanitizeChanges([
          ['rmdir', 'my-direcyory'],
        ]));
      });

      it('throws for files', () => {
        expect(() => {
          tree.rmdirSync('hello.txt');
        }).to.throw(/ENOTDIR/);
      });

      it('throws when stopped', function() {
        tree.stop();

        expect(function() {
          tree.rmdirSync('hello.txt');
        }).to.throw(/stopped/);

        expect(function() {
          tree.rmdirSync('hello.txt');
        }).to.throw(/rmdir/);
      });

      it('throws across projections', function() {
        tree.mkdirSync('my-directory/foo');
        tree.symlinkSyncFromEntry(tree, 'my-directory', 'other-directory');

        expect(function() {
          tree.rmdirSync('other-directory/foo');
        }).to.throw(/symlink/i);
      });
    });

    describe('.mkdirSync', function() {
      it('creates a directory', function () {
        expect(tree.walkPaths()).to.deep.equal([
          'hello.txt',
          'my-directory/',
        ]);

        tree.mkdirSync('new-directory');

        expect(tree.walkPaths()).to.deep.equal([
          'hello.txt',
          'my-directory/',
          'new-directory',
        ]);
      });

      it('tracks a change', function () {
        expect(tree.changes()).to.deep.equal([]);

        tree.mkdirSync('new-directory');

        expect(sanitizeChanges(tree.changes())).to.deep.equal(sanitizeChanges([
          ['mkdir', 'new-directory'],
        ]));
      });

      it('is idempotent (exact match)', function() {
        let old = fs.statSync(`${tree.root}/my-directory`);

        tree.mkdirSync('my-directory/');

        let current = fs.statSync(`${tree.root}/my-directory`);

        expect(old.mtime.getTime()).to.equal(current.mtime.getTime());
        expect(old).to.have.property('mode', current.mode);
        expect(old).to.have.property('size', current.size);

        expect(tree.walkPaths()).to.deep.equal([
          'hello.txt',
          'my-directory/',
        ]);
      });

      it('is idempotent (path normalization)', function () {
        let old = fs.statSync(`${tree.root}/my-directory`);

        tree.mkdirSync('my-directory/foo/..');

        let current = fs.statSync(`${tree.root}/my-directory`);

        expect(old.mtime.getTime()).to.equal(current.mtime.getTime());
        expect(old).to.have.property('mode', current.mode);
        expect(old).to.have.property('size', current.size);

        expect(tree.walkPaths()).to.deep.equal([
          'hello.txt',
          'my-directory/',
        ]);
      });

      it('throws when a file exists in the target location', function () {
        expect(function() {
          tree.mkdirSync('hello.txt');
        }).to.throw(/EEXIST/);
      });

      it('does error when stopped', function () {
        tree.stop();

        expect(function () {
          tree.mkdirSync('hello.txt');
        }).to.throw(/stopped/);

        expect(function () {
          tree.mkdirSync('hello.txt');
        }).to.throw(/mkdir/);
      });

      it('throws across projections', function() {
        tree.symlinkSyncFromEntry(tree, 'my-directory', 'other-directory');

        expect(function() {
          tree.mkdirSync('other-directory/foo');
        }).to.throw(/symlink/i);
      });
    });

    describe('.mkdirpSync', function() {
      it('creates directories', function() {
        expect(tree.walkPaths()).to.deep.equal([
          'hello.txt',
          'my-directory/',
        ]);

        tree.mkdirpSync('new-directory/a/b/c/');

        expect(tree.walkPaths()).to.deep.equal([
          'hello.txt',
          'my-directory/',
          'new-directory',
          'new-directory/a',
          'new-directory/a/b',
          'new-directory/a/b/c',
         ]);
      });

      it('tracks changes', function() {
        expect(tree.changes()).to.deep.equal([]);

        tree.mkdirpSync('new-directory/a/b/c/');

        expect(sanitizeChanges(tree.changes())).to.deep.equal(sanitizeChanges([
          ['mkdir', 'new-directory'],
          ['mkdir', 'new-directory/a'],
          ['mkdir', 'new-directory/a/b'],
          ['mkdir', 'new-directory/a/b/c'],
        ]));
      });

      it('is idempotent (exact match)', function testDir2Dir() {
        const old = fs.statSync(`${tree.root}/my-directory`);

        tree.mkdirpSync('my-directory/');

        const current = fs.statSync(`${tree.root}/my-directory`);

        expect(old.mtime.getTime()).to.equal(current.mtime.getTime());
        expect(old).to.have.property('mode', current.mode);
        expect(old).to.have.property('size', current.size);

        expect(tree.walkPaths()).to.deep.equal([
          'hello.txt',
          'my-directory/',
        ]);
      });

      it('is idempotent (path normalization)', function () {
        let old = fs.statSync(`${tree.root}/my-directory`);

        tree.mkdirpSync('my-directory/foo/..');

        let current = fs.statSync(`${tree.root}/my-directory`);

        expect(old.mtime.getTime()).to.equal(current.mtime.getTime());
        expect(old).to.have.property('mode', current.mode);
        expect(old).to.have.property('size', current.size);

        expect(tree.walkPaths()).to.deep.equal([
          'hello.txt',
          'my-directory/',
        ]);
      });

      it('throws when stopped', function() {
        tree.stop();

        expect(function() {
          tree.mkdirpSync('hello.txt');
        }).to.throw(/stopped/);

        expect(function() {
          tree.mkdirpSync('hello.txt');
        }).to.throw(/mkdirp/);
      });
    });

    describe('.resolvePath', function() {
      it('resolves the empty string', function() {
        expect(tree.resolvePath('')).to.equal(ROOT);
      });

      it('resolves .', function() {
        expect(tree.resolvePath('.')).to.equal(ROOT);
      });

      it('resolves paths that exist', function() {
        expect(tree.resolvePath('my-directory')).to.equal(`${ROOT}/my-directory`);
      });

      it('resolves paths that do not exist', function() {
        expect(tree.resolvePath('narnia')).to.equal(`${ROOT}/narnia`);
      });

      it('resolves paths with ..', function() {
        expect(tree.resolvePath('my-directory/uwot/../..')).to.equal(ROOT);
      });

      it('throws for paths that escape root', function() {
        expect(function() {
          tree.resolvePath('..')
        }).to.throw(`Invalid path: '..' not within root '${ROOT}/'`);
      });

      it('throws for paths within a chdir that escape root', function() {
        let myDir = tree.chdir('my-directory');

        expect(function() {
          myDir.resolvePath('..');
        }).to.throw(`Invalid path: '..' not within root '${ROOT}/my-directory/'`);
      });
    });

    describe('.statSync', function() {
      it('returns a stat object for normalized paths that exists', function() {
        let result = tree.statSync('my-directory/../hello.txt');

        expect(result).to.have.property('mode');
        expect(result).to.have.property('mtime');
        expect(result).to.have.property('size');
      });

      it('throws for nonexistent paths', function() {
        expect(function() {
          tree.statSync('foo.js');
        }).to.throw('ENOENT: no such file or directory, stat \'foo.js\'');
      });
    });

    describe('.existsSync', function() {
      it('returns true for paths that resolve to the root dir', function() {
        expect(tree.existsSync('')).to.be.true;
        expect(tree.existsSync('.')).to.be.true;
        expect(tree.existsSync('my-directory/..')).to.be.true;
      });

      it('returns true if the normalized path exists', function() {
        expect(tree.existsSync('hello.txt')).to.be.true;
        expect(tree.existsSync('my-directory')).to.be.true;
        expect(tree.existsSync('./my-directory/foo/..////')).to.be.true;
      });

      it('returns false if the path does not exist', function() {
        expect(tree.existsSync('pretty-sure-this-isnt-real')).to.be.false;
        expect(tree.existsSync('my-directory/still-not-real')).to.be.false;
      });

      // We care about this for now while we're still writing symlinks.  When we
      // actually take advantage of our change tracking, we may not need this,
      // except possibly for the initial state (eg where app is a symlink or
      // perhaps more realistically something within node_modules)
      it('follows symlinks', function() {
        fs.symlinkSync(`${ROOT}/this-dir-isnt-real`, `${ROOT}/broken-symlink`);
        fs.symlinkSync(`${ROOT}/hello.txt`, `${ROOT}/pretty-legit-symlink`);

        const treeWithLinks = treeFromDisk(ROOT);

        expect(treeWithLinks.existsSync('broken-symlink')).to.be.false;
        expect(treeWithLinks.existsSync('pretty-legit-symlink')).to.be.true;
      });
    });

    describe('readdirSync', function() {
      beforeEach(function() {
        tree.mkdirSync('my-directory/subdir');
        tree.writeFileSync('my-directory/ohai.txt', 'hi');
        tree.writeFileSync('my-directory/again.txt', 'hello');
        tree.writeFileSync('my-directory/subdir/sup.txt', 'guten tag');
        tree.writeFileSync('my-directory.annoying-file', 'better test this');
        tree.stop();
        tree.start();
      });

      it('throws if path is a file', function() {
        expect(function() {
          tree.readdirSync('hello.txt');
        }).to.throw('ENOTDIR: not a directory, scandir \'hello.txt\'');
      });

      it('throws if path does not exist', function() {
        expect(function() {
          tree.readdirSync('not-a-real-path');
        }).to.throw('ENOENT: no such file or directory, scandir \'not-a-real-path\'');
      });

      it('returns the contents of a dir', function() {
        expect(tree.readdirSync('my-directory')).to.deep.equal([
          'again.txt',
          'ohai.txt',
          'subdir',
        ]);
      });

      it('returns the contents of root', function() {
        expect(tree.readdirSync('./')).to.deep.equal([
          'hello.txt',
          'my-directory',
          'my-directory.annoying-file',
        ]);
      });

      it('chomps trailing / in returned dirs', function() {
        // reset entries via walksync so that subdir has a trailing slash
        const newTree = treeFromDisk(ROOT);

        expect(newTree.readdirSync('my-directory')).to.deep.equal([
          'again.txt',
          'ohai.txt',
          'subdir',
        ]);
      });

      describe('from symlinks', function() {
        it('should return the correct entries', function() {
          tree.mkdirSync('foo');
          tree.writeFileSync('foo/baz.txt', 'baz');
          tree2.symlinkSyncFromEntry(tree, 'foo', 'c');

          expect(tree2.readdirSync('c')).to.deep.equal([
            'baz.txt',
          ]);
        });
      });

      describe('from symlinks with srcRelativePath as /', function() {
        it('should return the correct entries', function() {
          tree2.symlinkSyncFromEntry(tree, '/', 'c');

          expect(tree2.readdirSync('c')).to.deep.equal([
            'hello.txt',
            'my-directory',
            'my-directory.annoying-file',
          ]);
        });
      });
    });

    describe('.walkPaths', function() {
      it('returns the paths for all entries', function() {
        expect(tree.walkPaths()).to.deep.equal([
          'hello.txt',
          'my-directory/',
        ]);
      });

      it('respects cwd', function() {
        expect(tree.chdir('my-directory').walkPaths()).to.deep.equal([]);
      });

      it('respects filters', function() {
        expect(tree.filtered({
          include: ['*.txt'],
        }).walkPaths()).to.deep.equal([
          'hello.txt',
        ]);
      });
    });

    describe('.walkEntries', function() {
      it('returns all entries', function() {
        expect(tree.walkEntries().map(e => e.relativePath)).to.deep.equal([
          'hello.txt',
          'my-directory/',
        ]);
      });

      it('respects cwd', function() {
        expect(tree.chdir('my-directory').walkEntries()).to.deep.equal([]);
      });

      it('respects filters', function() {
        expect(tree.filtered({
          include: ['*.txt'],
        }).walkEntries().map(e => e.relativePath)).to.deep.equal([
          'hello.txt',
        ]);
      });
    });

    describe('.chdir', function() {
      it('throws if the path is to a file', function() {
        expect(function() {
          tree.chdir('hello.txt');
        }).to.throw('ENOTDIR: not a directory, hello.txt');
      });

      it('returns a new tree', function() {
        const result = tree.chdir('my-directory');

        expect(result).to.not.equal(tree);
        expect(result.parent).to.equal(tree);
        expect(result.cwd).to.equal('my-directory/');
      });

      it('returns the same tree if changing to cwd', function() {
        let result = tree.chdir('/');

        expect(result).to.equal(tree);
        expect(result.cwd).to.equal('');
      });

      it('cannot escape a cwd', () => {
        tree.mkdirSync('my-directory/a');

        const rootedTree = tree.chdir('my-directory/a');

        expect(() => {
          rootedTree.chdir('my-directory');
        }).to.throw(/ENOENT/);
      });

      it('can chdir into projections', function() {
        tree.mkdirSync('my-directory/foo');
        tree.writeFileSync('my-directory/foo/bar.js', 'let bar;');
        tree2.symlinkSyncFromEntry(tree, 'my-directory', 'abc');

        const rootedTree2 = tree2.chdir('abc/foo');

        expect(rootedTree2.cwd).to.equal('abc/foo/');
        debugger;
        expect(rootedTree2.walkPaths()).to.deep.equal([
          'bar.js',
        ]);
      });

      describe('when path does not exist', function() {
        it('throws without allowEmpty: true', function() {
          expect(function() {
            tree.chdir('pretty-sure-this-dir-doesnt-exist');
          }).to.throw('ENOENT: no such file or directory, pretty-sure-this-dir-doesnt-exist');
        });

        it('does not throw with allowEmpty true', function() {
          expect(function() {
            tree.chdir('pretty-sure-this-dir-doesnt-exist', { allowEmpty: true });
          }).to.not.throw();
        });
      });

      describe('other operations', function() {
        beforeEach(function() {
          tree.writeFileSync('my-directory/ohai.txt', 'yes hello');
          tree.stop();
          tree.start();
        });

        it('is respected by statSync', function() {
          expect(tree.findByRelativePath('ohai.txt').entry).to.be.null;

          let newTree = tree.chdir('my-directory');

          let stat = newTree.statSync('ohai.txt');
          expect(stat).to.have.property('mode', 0);
        });

        it('is respected by existsSync', function() {
          expect(tree.existsSync('ohai.txt')).to.be.false;

          let newTree = tree.chdir('my-directory');

          expect(newTree.existsSync('ohai.txt')).to.be.true;
        });

        it('is respected by readFileSync', function() {
          let newTree = tree.chdir('my-directory');

          expect(newTree.readFileSync('ohai.txt', 'UTF8')).to.equal('yes hello');
        });

        it('is respected by unlinkSync (by throwing)', function() {
          expect(tree.statSync('my-directory/ohai.txt')).to.have.property('mode', 0);
          expect(() => {
            tree.chdir('my-directory').unlinkSync('ohai.txt');
          }).to.throw('Cannot \'unlink\' on a projection.');
        });

        it('is respected by rmdirSync (by throwing)', function() {
          tree.mkdirSync('my-directory/subdir');

          expect(tree.statSync('my-directory/subdir')).to.have.property('mode', 16877);
          expect(() => {
            tree.chdir('my-directory').rmdirSync('subdir');
          }).to.throw('Cannot \'rmdir\' on a projection.');
        });

        it('is respected by mkdirSync (by throwing)', function() {
          expect(tree.findByRelativePath('my-directory/subdir').entry).to.be.null;
          expect(() => {
            tree.chdir('my-directory').mkdirSync('subdir');
          }).to.throw('Cannot \'mkdir\' on a projection.');
        });

        it('is respected by mkdirpSync (by throwing)', function() {
          expect(tree.findByRelativePath('my-directory/subdir/a/b/c').entry).to.be.null;
          expect(() => {
            tree.chdir('my-directory').mkdirpSync('subdir/a/b/c');
          }).to.throw('Cannot \'mkdirp\' on a projection.');
        });

        it('is respected by writeFileSync (by throwing)', function() {
          expect(tree.findByRelativePath('my-directory/hello-again.txt').entry).to.be.null;
          expect(() => {
            tree.chdir('my-directory').writeFileSync('hello-again.txt', 'hello again');
          }).to.throw('Cannot \'writeFile\' on a projection.');
        });

        it('is respected by symlinkSync (by throwing)', function() {
          expect(tree.findByRelativePath('my-directory/hello-again.txt').entry).to.be.null;
          expect(() => {
            tree.chdir('my-directory').symlinkSync(`${tree.root}/hello.txt`, 'hello-again.txt');
          }).to.throw('Cannot \'symlink\' on a projection.');
        });

        it('is respected by symlinkSyncFromEntry (by throwing)', function() {
          expect(tree.findByRelativePath('my-directory/foo').entry).to.be.null;

          tree2.mkdirSync('bar');

          expect(() => {
            tree.chdir('my-directory').symlinkSyncFromEntry(tree2, 'bar', 'foo');
          }).to.throw('Cannot \'symlinkSyncFromEntry\' on a projection.');
        });

        it('is respected by readdirSync', function() {
          tree.mkdirSync('my-directory/subdir');
          tree.writeFileSync('my-directory/ohai.txt', 'hi');
          tree.writeFileSync('my-directory/again.txt', 'hello');
          tree.writeFileSync('my-directory/subdir/sup.txt', 'guten tag');

          tree.stop();
          tree.start();

          expect(function() {
            tree.readdirSync('subdir');
          }).to.throw();

          let newTree = tree.chdir('my-directory');

          expect(newTree.readdirSync('subdir')).to.deep.equal([
            'sup.txt',
          ]);
        });

        it('is respected by changes', function() {
          tree.mkdirSync('my-directory/subdir');

          let newTree = tree.chdir('my-directory/subdir');

          newTree.writeFileSync('ohai.txt', 'yes hello again');

          expect(sanitizeChanges(newTree.changes())).to.deep.equal(sanitizeChanges([
            ['create', 'ohai.txt'],
          ]));

          expect(sanitizeChanges(tree.changes())).to.deep.equal(sanitizeChanges([
            ['mkdir', 'my-directory/subdir'],
            ['create', 'my-directory/subdir/ohai.txt'],
          ]));
        });

        // TODO: remove this when match is removed.
        it('is respected by match', function() {
          expect(tree.match({ include: ['*'] }).map(e => e.relativePath)).to.deep.equal([
            'hello.txt',
            'my-directory/'
          ]);

          let newTree = tree.chdir('my-directory');

          expect(newTree.match({ include: ['*'] }).map(e => e.relativePath)).to.deep.equal([
            'ohai.txt',
          ]);
        });
      });
    });

    describe('.filtered', function() {
      it('returns a new tree with filters set', function() {
        expect(tree.include).to.deep.equal([]);
        expect(tree.exclude).to.deep.equal([]);
        expect(tree.files).to.deep.equal([]);
        expect(tree.cwd).to.equal('');

        expect(tree.filtered({ include: ['*.js'] }).include).to.deep.equal(['*.js']);
        expect(tree.filtered({ exclude: ['*.js'] }).exclude).to.deep.equal(['*.js']);
        expect(tree.filtered({ files: ['foo.js'] }).files).to.deep.equal(['foo.js']);
        expect(tree.filtered({ cwd: 'my-directory' }).cwd).to.equal('my-directory/');

        let projection = tree.filtered({
          include: ['*.js'],
          exclude: ['*.css'],
          cwd: 'my-directory',
        });

        expect(projection.parent).to.equal(tree);
        expect(projection.include).to.deep.equal(['*.js']);
        expect(projection.exclude).to.deep.equal(['*.css']);
        expect(projection.cwd).to.equal('my-directory/');
      });
    });

    describe('._hasEntries', function() {
      it('sets _hasEntries to true if entries are specified', function() {
        expect(new FSTree({
          entries: [],
          root: ROOT,
        })._hasEntries).to.be.true;
      });

      it('sets _hasEntries to false if no entries are specified', function() {
        expect(new FSTree({
          entries: null,
          root: ROOT,
        })._hasEntries).to.be.false;
      });

      describe('when entries are not initially read', function() {
        let lazyTree;

        beforeEach(function() {
          lazyTree = new FSTree({
            entries: null,
            root: ROOT,
          });
        });

        it('throws if no root is provided', () => {
          lazyTree = new FSTree({
            entries: null,
          });

          expect(lazyTree._hasEntries).to.be.false;
          expect(() => {
            lazyTree._ensureEntriesPopulated();
          }).to.throw('Cannot scan for entries, as no root was provided.');
        });

        it('lazily populates entries for statSync', function() {
          expect(lazyTree._hasEntries).to.be.false;

          lazyTree.statSync('hello.txt');

          expect(lazyTree._hasEntries).to.be.true;
        });

        it('does not lazily populate entries for existsSync', function() {
          expect(lazyTree._hasEntries).to.be.false;

          lazyTree.existsSync('hello.txt');

          expect(lazyTree._hasEntries).to.be.false;
        });

        it('lazily populates entries for readdirSync', function() {
          expect(lazyTree._hasEntries).to.be.false;

          lazyTree.readdirSync('my-directory');

          expect(lazyTree._hasEntries).to.be.true;
        });

        it('lazily populates entries for readFileSync', function() {
          expect(lazyTree._hasEntries).to.be.false;

          lazyTree.readFileSync('hello.txt', 'UTF8');

          expect(lazyTree._hasEntries).to.be.true;
        });

        it('lazily populates entries for unlinkSync', function() {
          expect(lazyTree._hasEntries).to.be.false;

          lazyTree.unlinkSync('hello.txt');

          expect(lazyTree._hasEntries).to.be.true;
        });

        it('lazily populates entries for rmdirSync', function() {
          expect(lazyTree._hasEntries).to.be.false;

          lazyTree.rmdirSync('my-directory');

          expect(lazyTree._hasEntries).to.be.true;
        });

        it('lazily populates entries for mkdirSync', function() {
          expect(lazyTree._hasEntries).to.be.false;

          lazyTree.mkdirSync('new-dir');

          expect(lazyTree._hasEntries).to.be.true;
        });

        it('lazily populates entries for writeFileSync', function() {
          expect(lazyTree._hasEntries).to.be.false;

          lazyTree.writeFileSync('new-file.txt', 'hai again');

          expect(lazyTree._hasEntries).to.be.true;
        });

        it('lazily populates entries for symlinkSync', function() {
          expect(lazyTree._hasEntries).to.be.false;

          lazyTree.symlinkSync(`${ROOT}/hello.txt`, 'hi.txt');

          expect(lazyTree._hasEntries).to.be.true;
        });

        it('lazily populates entries for symlinkSyncFromEntry', function() {
          expect(lazyTree._hasEntries).to.be.false;

          tree2.mkdirSync('abc');
          lazyTree.symlinkSyncFromEntry(tree2, 'abc', 'def');

          expect(lazyTree._hasEntries).to.be.true;
        });

        it('lazily populates entries for source tree for symlinkSyncFromEntry', function() {
          tree2 = new FSTree({
            entries: null,
            root: ROOT2,
          });

          expect(tree2._hasEntries).to.be.false;

          tree2.symlinkSyncFromEntry(lazyTree, 'my-directory', 'abc');

          expect(tree2._hasEntries).to.be.true;
        });

        it('is idempotent (does not populate entries twice)', function() {
          expect(lazyTree._hasEntries).to.be.false;
          expect(lazyTree._rawEntries).to.not.be.an('array');

          lazyTree._ensureEntriesPopulated();

          expect(lazyTree._hasEntries).to.be.true;
          expect(lazyTree._rawEntries.map(e => e.relativePath)).to.deep.equal(['hello.txt', 'my-directory/']);

          rimraf.sync(ROOT);

          lazyTree._ensureEntriesPopulated();

          expect(lazyTree._hasEntries).to.be.true;
          expect(lazyTree._rawEntries.map(e => e.relativePath)).to.deep.equal(['hello.txt', 'my-directory/']);
        });
      });
    });
  });

  describe('projection', function() {
    beforeEach(function() {
      rimraf.sync(ROOT);
      fs.mkdirpSync(ROOT);

      fixturify.writeSync(ROOT, {
        'hello.txt': 'Hello, World!\n',
        'goodbye.txt': 'Goodbye, World\n',
        'a': {
          'foo': {
            'one.js': '',
            'one.css': '',
            'two.js': '',
            'two.css': '',
          },
          'bar': {
            'two.js': '',
            'two.css': '',
            'three.js': '',
            'three.css': '',
          }
        },
        'b': {},
      });

      tree = treeFromDisk(ROOT);
    });

    describe('files', function() {
      it('returns only matching files', function() {
        let filter = { files: ['hello.txt', 'a/foo/two.js', 'a/bar'] };

        // funnel will cp -r if files:[ 'path/to/dir/' ]
        // so this is semantically different, but i don't think it's actually
        // public API for files to contain a path to a dir
        expect(tree.filtered(filter).walkPaths()).to.deep.equal([
          'a/',
          'a/bar/',
          'a/foo/',
          'a/foo/two.js',
          'hello.txt',
        ]);
      });

      it('respects cwd', function() {
        let filter = { cwd: 'a/foo', files: ['one.js', 'two.css'] };

        expect(tree.filtered(filter).walkPaths()).to.deep.equal([
          'one.js',
          'two.css',
        ]);
      });

      it('is incompatible with include', function() {
        let filter = { files: ['a/foo/one.js'], include: ['a/foo/one.css'] };

        expect(function(){
          tree.filtered(filter).walkPaths()
        }).to.throw('Cannot pass files option and a include/exlude filter. You can only have one or the other');
      });

      it('is incompatible with exclude', function() {
        let filter = { files: ['a/foo/one.js'], exclude: ['a/foo/one.css'] };

        expect(function(){
          tree.filtered(filter).walkPaths()
        }).to.throw('Cannot pass files option and a include/exlude filter. You can only have one or the other');
      });
    });

    describe('include', function() {
      it('matches by regexp', function() {
        let filter = { include: [new RegExp(/(hello|one)\.(txt|js)/)] };

        expect(tree.filtered(filter).walkPaths()).to.deep.equal([
          'a/',
          'a/foo/',
          'a/foo/one.js',
          'hello.txt',
        ]);
      });

      it('matches by function', function() {
        let filter = { include: [p => p === 'a/bar/three.css'] };

        expect(tree.filtered(filter).walkPaths()).to.deep.equal([
          'a/',
          'a/bar/',
          'a/bar/three.css',
        ]);
      });

      it('matches by string globs', function() {
        let filter = { include: ['**/*.{txt,js}'] };

        expect(tree.filtered(filter).walkPaths()).to.deep.equal([
          'a/',
          'a/bar/',
          'a/bar/three.js',
          'a/bar/two.js',
          'a/foo/',
          'a/foo/one.js',
          'a/foo/two.js',
          'goodbye.txt',
          'hello.txt',
        ]);
      });

      it('matches by a mix of matchers', function() {
        let filter = { include: ['**/*.txt', new RegExp(/(hello|one)\.(txt|js)/), p => p === 'a/bar/three.js'] };

        expect(tree.filtered(filter).walkPaths()).to.deep.equal([
          'a/',
          'a/bar/',
          'a/bar/three.js',
          'a/foo/',
          'a/foo/one.js',
          'goodbye.txt',
          'hello.txt',
        ]);
      });

      it('respects cwd', function() {
        let filter = { cwd: 'a/foo', include: ['*.css'] };

        expect(tree.filtered(filter).walkPaths()).to.deep.equal([
          'one.css',
          'two.css',
        ]);
      });
    });

    describe('exclude', function() {
      it('matches by regexp', function() {
        let filter = { exclude: [new RegExp(/(hello|one|two)\.(txt|js)/)] };

        expect(tree.filtered(filter).walkPaths()).to.deep.equal([
          'a/',
          'a/bar/',
          'a/bar/three.css',
          'a/bar/three.js',
          'a/bar/two.css',
          'a/foo/',
          'a/foo/one.css',
          'a/foo/two.css',
          'b/',
          'goodbye.txt',
        ]);
      });

      it('matches by function', function() {
        let filter = { cwd: 'a/bar', exclude: [p => p === 'three.css'] };

        expect(tree.filtered(filter).walkPaths()).to.deep.equal([
          'three.js',
          'two.css',
          'two.js',
        ]);
      });

      it('matches by string globs', function() {
        let filter = { exclude: ['**/*.{txt,css}'] };

        expect(tree.filtered(filter).walkPaths()).to.deep.equal([
          'a/',
          'a/bar/',
          'a/bar/three.js',
          'a/bar/two.js',
          'a/foo/',
          'a/foo/one.js',
          'a/foo/two.js',
          'b/',
        ]);
      });

      it('matches by a mix of matchers', function() {
        let filter = { exclude: ['**/*.css', new RegExp(/(hello|one)\.(txt|js)/), p => p === 'a/bar/three.js'] };

        expect(tree.filtered(filter).walkPaths()).to.deep.equal([
          'a/',
          'a/bar/',
          'a/bar/two.js',
          'a/foo/',
          'a/foo/two.js',
          'b/',
          'goodbye.txt',
        ]);
      });

      it('respects cwd', function() {
        let filter = { cwd: 'a/foo', exclude: ['*.css'] };
        expect(tree.filtered(filter).walkPaths()).to.deep.equal([
          'one.js',
          'two.js',
        ]);
      });

      it('takes precedence over include', function() {
        let filter = { cwd: 'a/foo', include: ['one.css', 'one.js'], exclude: ['*.css'] };

        expect(tree.filtered(filter).walkPaths()).to.deep.equal([
          'one.js',
        ]);
      });
    });
  });

  describe.skip('changes', function() {
    beforeEach(function() {
      tree.writeFileSync('omg.js', 'hi');
      tree.writeFileSync('hello.txt', 'Hello Again, World!\n');
      tree.writeFileSync('my-directory/goodbye.txt', 'Goodbye, World!\n');
    })

    it('hides no changes if all match', function() {
      let filter = { include: ['**/*'] };

      expect(sanitizeChanges(tree.filtered(filter).changes())).to.deep.equal(sanitizeChanges([
        ['create', 'omg.js'],
        ['change', 'hello.txt'],
        ['create', 'my-directory/goodbye.txt'],
      ]));
    });

    it('hides changes if none match', function() {
      expect(tree.filtered({ include: ['NO_MATCH'] }).changes()).to.have.lengthOf(0);
    });

    it('hides changes if they are outside of cwd', function() {
      expect(sanitizeChanges(tree.chdir('my-directory').changes())).to.deep.equal(sanitizeChanges([
        ['create', 'goodbye.txt'],
      ]));
    });

    it('hides changes if they do not match the file projection', function() {
      let filter = { files: ['file-not-here.txt'] };
      let changes = tree.filtered(filter).changes();

      expect(changes).to.have.lengthOf(0);
    });

    it('hides changes if they do not match the include and exclude projection', function() {
      let filter = { include: ['**/include.css'], exclude: [e => e === 'excluded.js'] };
      let changes = tree.filtered(filter).changes();

      expect(changes).to.have.lengthOf(0);
    });

    it('honors chdir on the projected tree', () => {
      tree.mkdirSync('my-directory/foo');
      tree.writeFileSync('my-directory/foo/bar.txt', 'bar');

      const rootedTree = tree.chdir('my-directory');

      tree2.symlinkSyncFromEntry(rootedTree, 'foo', 'abc');

      expect(sanitizeChanges(tree2.changes())).to.deep.equal(sanitizeChanges([
        ['mkdir', 'abc'],
        ['create', 'abc/bar.txt'],
      ]));
    });

    it('follows projections in its own cwd', () => {
      tree.mkdirSync('my-directory/foo');
      tree.writeFileSync('my-directory/foo/bar.txt', 'bar');
      tree2.symlinkSyncFromEntry(tree, 'my-directory', 'abc');

      const rootedTree2 = tree2.chdir('abc/foo');

      expect(sanitizeChanges(rootedTree2.changes())).to.deep.equal(sanitizeChanges([
        ['create', 'bar.txt'],
      ]));
    });

    it('traverses root links', () => {
      tree.writeFileSync('foo.txt', 'foo');
      tree2.symlinkSyncFromEntry(tree, '', 'abc');

      expect(sanitizeChanges(tree2.changes())).to.deep.equal(sanitizeChanges([
        ['mkdir', 'abc'],
        ['create', 'abc/foo.txt'],
      ]));
    });

    it('honors files setting on the projected tree', () => {
      tree.files = ['bar.js'];
      tree.writeFileSync('foo.txt', 'foo');
      tree.writeFileSync('bar.js', 'let bar;');
      tree2.symlinkSyncFromEntry(tree, '', 'abc');

      expect(sanitizeChanges(tree2.changes())).to.deep.equal(sanitizeChanges([
        ['mkdir', 'abc'],
        ['create', 'abc/bar.js'],
      ]));
    });

    it('honors include setting on the projected tree', () => {
      tree.include = [path => path === 'my-directory/bar.js'];
      tree.writeFileSync('my-directory/foo.txt', 'foo');
      tree.writeFileSync('my-directory/bar.js', 'let bar;');
      tree2.symlinkSyncFromEntry(tree, '', 'abc');

      expect(sanitizeChanges(tree2.changes())).to.deep.equal(sanitizeChanges([
        ['mkdir', 'abc'],
        ['mkdir', 'abc/my-directory'],
        ['create', 'abc/my-directory/bar.js'],
      ]));
    });

    it('honors exclude setting on the projected tree', () => {
      tree.exclude = [path => path !== 'my-directory/bar.js'];
      tree.writeFileSync('my-directory/foo.txt', 'foo');
      tree.writeFileSync('my-directory/bar.js', 'let bar;');
      tree2.symlinkSyncFromEntry(tree, '', 'abc');

      expect(sanitizeChanges(tree2.changes())).to.deep.equal(sanitizeChanges([
        ['mkdir', 'abc'],
        ['mkdir', 'abc/my-directory'],
        ['create', 'abc/my-directory/bar.js'],
      ]));
    });

    it('passes down files setting from the root tree', () => {
      tree2.files = ['abc/bar.js'];
      tree.writeFileSync('foo.txt', 'foo');
      tree.writeFileSync('bar.js', 'let bar;');
      tree2.symlinkSyncFromEntry(tree, '', 'abc');

      expect(sanitizeChanges(tree2.changes())).to.deep.equal(sanitizeChanges([
        ['mkdir', 'abc'],
        ['create', 'abc/bar.js'],
      ]));
    });

    it('passes down include setting from the root tree', () => {
      tree2.include = [path => path === 'abc/bar.js'];
      tree.writeFileSync('foo.txt', 'foo');
      tree.writeFileSync('bar.js', 'let bar;');
      tree2.symlinkSyncFromEntry(tree, '', 'abc');

      expect(sanitizeChanges(tree2.changes())).to.deep.equal(sanitizeChanges([
        ['mkdir', 'abc'],
        ['create', 'abc/bar.js'],
      ]));
    });

    it('passes down exclude setting from the root tree', () => {
      tree2.exclude = [path => path !== 'abc/bar.js'];
      tree.writeFileSync('foo.txt', 'foo');
      tree.writeFileSync('bar.js', 'let bar;');
      tree2.symlinkSyncFromEntry(tree, '', 'abc');

      expect(sanitizeChanges(tree2.changes())).to.deep.equal(sanitizeChanges([
        ['mkdir', 'abc'],
        ['create', 'abc/bar.js'],
      ]));
    });

    describe('srcTree is true', function() {
      beforeEach(function() {
        rimraf.sync(ROOT);
        fs.mkdirpSync(ROOT);

        fixturify.writeSync(ROOT, {
          'hello.txt': 'Hello, World!\n',
          'goodbye.txt': 'Goodbye, World\n',
          'a': {
            'foo': {
              'one.js': '',
              'one.css': '',
            },
            'bar': {
              'two.js': '',
              'two.css': '',
            }
          },
          'b': {
            'four.js': '',
            'four.txt': '',
          },
        });

        // Create a srcTree.
        tree = treeFromDisk(ROOT, true);
      });

      it('should throw error when we write to it', function() {
        expect(function() {
          tree.writeFileSync('b/somefile.txt', 'blah')
        }).to.throw('NOPE, operation: writeFile');
      });

      it('include filters with parent dir', function() {
        tree.include = ['**/one.css'];

        expect(sanitizeChanges(tree.changes())).to.deep.equal(sanitizeChanges([
          ['mkdir', 'a'],
          ['mkdir', 'a/foo'],
          ['create', 'a/foo/one.css'],
        ]));
      });

      it('include filters with one symlinked dir', function() {
        tree2.symlinkSyncFromEntry(tree, 'a', 'd')
        tree2.include = ['**/*.css'];

        expect(sanitizeChanges(tree2.changes())).to.deep.equal(sanitizeChanges([
          ['mkdir', 'd'],
          ['mkdir', 'd/bar'],
          ['create', 'd/bar/two.css'],
          ['mkdir', 'd/foo'],
          ['create', 'd/foo/one.css'],
        ]));
      });

      it('include filters with nested symlinked dir', function() {
        tree2.symlinkSyncFromEntry(tree, 'a', 'f');
        tree3.symlinkSyncFromEntry(tree2, 'f', 'd');
        tree3.include = ['**/*.css'];

        expect(sanitizeChanges(tree3.changes())).to.deep.equal(sanitizeChanges([
          ['mkdir', 'd'],
          ['mkdir', 'd/bar'],
          ['create', 'd/bar/two.css'],
          ['mkdir', 'd/foo'],
          ['create', 'd/foo/one.css'],
        ]));
      });

      it('include filters with nested symlinked dir and cwd', function() {
        const rootedTree = tree.chdir('b');

        tree2.symlinkSyncFromEntry(rootedTree, '/', 'c');
        tree2.include = ['c/four.txt']

        expect(sanitizeChanges(tree2.changes())).to.deep.equal(sanitizeChanges([
          ['create', 'c/four.txt'],
        ]));
      });

      it('include filters with multiple symlinked dir', function() {
        tree2.symlinkSyncFromEntry(tree, 'a', 'f');
        tree2.symlinkSyncFromEntry(tree, 'b', 'd');
        tree2.include = ['**/*.css'];

        expect(sanitizeChanges(tree2.changes())).to.deep.equal(sanitizeChanges([
          ['mkdir', 'f'],
          ['mkdir', 'f/bar'],
          ['create', 'f/bar/two.css'],
          ['mkdir', 'f/foo'],
          ['create', 'f/foo/one.css'],
        ]));
      });

      it('include filters with multiple symlinked dir with included files', function() {
        tree2.symlinkSyncFromEntry(tree, 'a', 'f')
        tree2.symlinkSyncFromEntry(tree, 'b', 'd')

        tree3 = FSTree.fromParent(tree2, {
          include: ['**/*.js'],
        });

        expect(sanitizeChanges(tree3.changes())).to.deep.equal(sanitizeChanges([
          ['mkdir', 'd'],
          ['create', 'd/four.js'],
          ['mkdir', 'f'],
          ['mkdir', 'f/bar'],
          ['create', 'f/bar/two.js'],
          ['mkdir', 'f/foo'],
          ['create', 'f/foo/one.js'],
        ]));
      });

      it('exclude filters with parent dir', function() {
        tree.exclude = ['**/*.js', '**/two.css'];

        expect(sanitizeChanges(tree.changes())).to.deep.equal(sanitizeChanges([
          ['mkdir', 'a'],
          ['mkdir', 'a/foo'],
          ['create', 'a/foo/one.css'],
          ['mkdir', 'b'],
          ['create', 'b/four.txt'],
          ['create', 'goodbye.txt'],
          ['create', 'hello.txt'],
        ]));
      });

      it('include and exclude filters with parent dir', function() {
        tree.include = ['**/*.js'];
        tree.exclude = ['**/*.css', '**/*.txt'];

        expect(sanitizeChanges(tree.changes())).to.deep.equal(sanitizeChanges([
          ['mkdir', 'a'],
          ['mkdir', 'a/bar'],
          ['create', 'a/bar/two.js'],
          ['mkdir', 'a/foo'],
          ['create', 'a/foo/one.js'],
          ['mkdir', 'b'],
          ['create', 'b/four.js'],
        ]));
      });

      it('file filters with parent dir', function() {
        tree.files = ['b/four.txt'];

        expect(sanitizeChanges(tree.changes())).to.deep.equal(sanitizeChanges([
          ['mkdir', 'b'],
          ['create', 'b/four.txt'],
        ]));
      });
    });

    describe('order', function() {
      beforeEach(function() {
        tree.mkdirSync('a');
        tree.mkdirSync('a/b');
        tree.mkdirSync('a/b/c');
        tree.writeFileSync('a/b/c/d.txt', 'd is a great letter.');
      });

      it('additions/updates lexicographicaly', function() {
        expect(sanitizeChanges(tree.changes())).to.deep.equal(sanitizeChanges([
          ['mkdir', 'a'],
          ['mkdir', 'a/b'],
          ['mkdir', 'a/b/c'],
          ['create', 'a/b/c/d.txt'],
        ]));
      });

      it('removals reverse lexicographicaly', function() {
        tree.stop();
        tree.start();

        tree.unlinkSync('a/b/c/d.txt');
        tree.rmdirSync('a/b/c');
        tree.rmdirSync('a/b');
        tree.rmdirSync('a');

        expect(sanitizeChanges(tree.changes())).to.deep.equal(sanitizeChanges([
          ['unlink', 'a/b/c/d.txt'],
          ['rmdir', 'a/b/c'],
          ['rmdir', 'a/b'],
          ['rmdir', 'a'],
        ]));
      });
    });
  });

  describe('match', function() {
    beforeEach(function() {
      tree = new FSTree.fromEntries([
        directory('a/'),
        directory('a/b/'),
        directory('a/b/c/'),
        directory('a/b/c/d/'),
        file('a/b/c/d/foo.js'),
        directory('a/b/q/'),
        directory('a/b/q/r/'),
        file('a/b/q/r/bar.js'),
      ]);
    })

    it('ignores nothing, if all match', function() {
      const matched = tree.match({ include: ['**/*.js'] });

      expect(matched.map(entry => entry.relativePath)).to.deep.equal([
        'a',
        'a/b',
        'a/b/c',
        'a/b/c/d',
        'a/b/c/d/foo.js',
        'a/b/q',
        'a/b/q/r',
        'a/b/q/r/bar.js',
      ]);
    });

    it('ignores those that do not match, if all match', function() {
      const matched = tree.match({ include: ['a/b/c/**/*'] });

      expect(matched.map((entry) => entry.relativePath)).to.deep.equal([
        'a',
        'a/b',
        'a/b/c',
        'a/b/c/d',
        'a/b/c/d/foo.js',
      ]);
    });
  });
});