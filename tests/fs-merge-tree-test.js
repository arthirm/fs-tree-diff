'use strict';

const FSMergeTree = require('../lib/fs-merge-tree');
const FSTree = require('../');
const expect = require('chai').expect;
const path = require('path');
const fixturify = require('fixturify');
const rimraf = require('rimraf');
const fs = require('fs-extra');
const walkSync = require('walk-sync');

function mapBy(array, property) {
  return array.map(function (item) {
    return item[property];
  });
}

/** Creates an FSTree by walking a root directory. */
function treeFromDisk(root, srcTree) {
  return new FSTree({
    entries: walkSync.entries(root),
    root,
    srcTree,
  });
}

function applyChanges(changes, outTree) {
  changes.forEach(function(change) {
    var operation = change[0];
    var relativePath = change[1];
    var entry = change[2];
    const inputFilePath = entry.tree.resolvePath(entry.relativePath);

    switch (operation) {
      case 'mkdir':     {
        if (entry.linkDir) {
          return outTree.symlinkSyncFromEntry(entry.tree, relativePath, relativePath);
        } else {
          return outTree.mkdirSync(relativePath);
        }
      }
      case 'rmdir':   {
        if (entry.linkDir) {
          return outTree.unlinkSync(relativePath);
        } else {
          return outTree.rmdirSync(relativePath);
        }
      }
      case 'unlink':  {
        return outTree.unlinkSync(relativePath);
      }
      case 'create':    {
        return outTree.symlinkSync(inputFilePath, relativePath);
      }
      case 'change':    {
        if (entry.isDirectory()) {
          if (entry.linkDir) {
            outTree.rmdirSync(relativePath);
            outTree.symlinkSync(inputFilePath, relativePath , entry.linkDir);
          } else {
            outTree.unlinkSync(relativePath);
            outTree.mkdirSync(relativePath);
            return
          }
        } else {
          // file changed
          outTree.unlinkSync(relativePath);
          return outTree.symlinkSync(inputFilePath, relativePath);
        }

      }
    }
  }, this);
}

describe('FSMergeTree', function () {
  const ROOT = path.resolve('tmp/fs-test-root/');
  // const ROOT2 = path.resolve('tmp/fs-test-root2/');
  // const ROOT3 = path.resolve('tmp/fs-test-root3/');

  beforeEach(function () {
    rimraf.sync(ROOT);

    fs.mkdirpSync(ROOT);
  });

  afterEach(function () {
    fs.removeSync(ROOT);
  });

  describe('constructor', function () {
    it('supports empty inputs', function () {
      let tree = new FSMergeTree({
        inputs: []
      });

      expect(tree.length).to.equal(0);
      expect(tree).to.not.have.property(0);
    });

    it('supports multiple inputs', function () {
      let tree = new FSMergeTree({
        inputs: [ROOT + 'foo', ROOT + 'bar']
      });

      expect(tree.length).to.equal(2);
      expect(tree).to.have.property(0);
      expect(tree).to.have.property(1);
      expect(tree).to.not.have.property(2);
    });

    it('supports tree inputs', function () {
      let tree = new FSTree({
        root: ROOT
      });
      let fsMergeTree = new FSMergeTree({
        inputs: [tree]
      });

      expect(fsMergeTree.length).to.equal(1);
      expect(fsMergeTree).to.have.property(0);
      expect(fsMergeTree).to.not.have.property(1);
    });

    it('sets srcTree to true for string inputs', function () {
      let tree = new FSTree({
        root: `${ROOT}/guten-tag`,
      });
      let fsMergeTree = new FSMergeTree({
        inputs: [tree, `${ROOT}/hello`]
      });

      expect(fsMergeTree).to.have.deep.property('0.srcTree', false);
      expect(fsMergeTree).to.have.deep.property('1.srcTree', true);
    });
  });

  describe('.map', function () {
    it('maps over no inputs', function () {
      let result = new FSMergeTree({
        inputs: []
      }).map((entry, index) => [entry, index])

      expect(result.length).to.equal(0);
    });

    it('maps over multiple inputs', function () {
      let result = new FSMergeTree({
        inputs: [ROOT + '/foo', ROOT + '/bar']
      }).map((entry, index) => [entry, index])

      expect(result.length).to.equal(2);
      expect(result[0][0].root).to.eql(ROOT + '/foo/');
      expect(result[0][1]).to.eql(0);
      expect(result[1][0].root).to.eql(ROOT + '/bar/');
      expect(result[1][1]).to.eql(1);
    });
  });

  describe('_mergeRelativePaths', function () {
    it('returns an array of file infos', function () {
      fixturify.writeSync(`${ROOT}/a`, {
        bar: {
          baz: 'hello',
        }, qux: 'guten tag'
      });

      fixturify.writeSync(`${ROOT}/b`, {
        c: {
          d: 'hello',
        }, e: 'guten tag'
      });

      let mergeTrees = new FSMergeTree({
        inputs: [`${ROOT}/a`, `${ROOT}/b`]
      });

      let fileInfos = mergeTrees._mergeRelativePath(null, '');
      let entries = mapBy(fileInfos, 'entry');

      //expect(mapBy(entries, 'relativePath')).to.deep.equal(['bar/', 'c/', 'e', 'qux']);
      expect(mapBy(entries, 'relativePath')).to.deep.equal(['bar', 'c', 'e', 'qux']);
    });

    it('merges files', function () {
      fixturify.writeSync(`${ROOT}/a`, {
        foo: '1', qux: 'guten tag'
      });

      fixturify.writeSync(`${ROOT}/a`, {
        bar: '1', baz: 'guten tag'
      });

      let mergeTrees = new FSMergeTree({
        inputs: [`${ROOT}/a`]
      });

      let fileInfos = mergeTrees._mergeRelativePath(null, '');
      let entries = mapBy(fileInfos, 'entry');

      expect(mapBy(entries, 'relativePath')).to.deep.equal(['bar', 'baz', 'foo', 'qux']);
    })

    it('merges empty directories', function () {
      fixturify.writeSync(`${ROOT}/a`, {
        foo: {}, qux: {}
      });

      fixturify.writeSync(`${ROOT}/b`, {
        bar: {}, baz: {}
      });

      let mergeTrees = new FSMergeTree({
        inputs: [`${ROOT}/a`, `${ROOT}/b`]
      });

      let fileInfos = mergeTrees._mergeRelativePath(null, '');
      let entries = mapBy(fileInfos, 'entry');

      //expect(mapBy(entries, 'relativePath')).to.deep.equal(['bar/', 'baz/', 'foo/', 'qux/']);
      expect(mapBy(entries, 'relativePath')).to.deep.equal(['bar', 'baz', 'foo', 'qux']);
    });

    it('refuses to overwrite files when overwrite is false or null and overwrites if its true', function () {
      fixturify.writeSync(`${ROOT}/a`, {
        bar: {
          baz: 'hello',
        }, qux: 'guten tag'
      });

      fixturify.writeSync(`${ROOT}/b`, {
        c: {
          d: 'hello',
        }, qux: 'guten tag'
      });

      let mergeTrees = new FSMergeTree({
        inputs: [`${ROOT}/a`, `${ROOT}/b`],
      });

      expect(() => mergeTrees._mergeRelativePath(null, '')).to.throw(
        /Merge error: file qux exists in .* and [^]* overwrite: true .*/);
      expect(() => mergeTrees._mergeRelativePath({overwrite: false}, '')).to.throw(
        /Merge error: file qux exists in .* and [^]* overwrite: true .*/);

      let fileInfos = mergeTrees._mergeRelativePath({overwrite: true}, '');
      let entries = mapBy(fileInfos, 'entry');
      //expect(mapBy(entries, 'relativePath')).to.deep.equal(['bar/', 'c/', 'qux']);
      expect(mapBy(entries, 'relativePath')).to.deep.equal(['bar', 'c', 'qux']);

    });

    it('refuses to honor conflicting capitalizations for a directory, with overwrite: false and true and null', function () {
      fixturify.writeSync(`${ROOT}/a`, {
        bar: {
          baz: 'hello',
        }
      });

      fixturify.writeSync(`${ROOT}/b`, {
        Bar: {
          d: 'hello',
        }
      });

      let mergeTrees = new FSMergeTree({
        inputs: [`${ROOT}/a`, `${ROOT}/b`],
      });
      expect(() => mergeTrees._mergeRelativePath(null, '')).to.throw(
        /Merge error: conflicting capitalizations:\nbar in .*\nBar in .*\nRemove/);
      expect(() => mergeTrees._mergeRelativePath({overwrite: false}, '')).to.throw(
        /Merge error: conflicting capitalizations:\nbar in .*\nBar in .*\nRemove/);
      expect(() => mergeTrees._mergeRelativePath({overwrite: true}, '')).to.throw(
        /Merge error: conflicting capitalizations:\nbar in .*\nBar in .*\nRemove/);
    });

    it('refuses to honor conflicting capitalizations for file, with overwrite: false and true and null', function () {
      fixturify.writeSync(`${ROOT}/a`, {
        bar: 'abcd'
      });

      fixturify.writeSync(`${ROOT}/b`, {
        Bar: 'hello'
      });

      let mergeTrees = new FSMergeTree({
        inputs: [`${ROOT}/a`, `${ROOT}/b`],
      });
      expect(() => mergeTrees._mergeRelativePath(null, '')).to.throw(
        /Merge error: conflicting capitalizations:\nbar in .*\nBar in .*\nRemove/);
      expect(() => mergeTrees._mergeRelativePath({overwrite: false}, '')).to.throw(
        /Merge error: conflicting capitalizations:\nbar in .*\nBar in .*\nRemove/);
      expect(() => mergeTrees._mergeRelativePath({overwrite: true}, '')).to.throw(
        /Merge error: conflicting capitalizations:\nbar in .*\nBar in .*\nRemove/);
    });

    it('rejects directories colliding with files, with overwrite: false and true and null', function () {
      fixturify.writeSync(`${ROOT}/a`, {
        bar: {
          baz: 'hello',
        }
      });

      fixturify.writeSync(`${ROOT}/b`, {
        bar: 'hello'
      });

      let mergeTrees = new FSMergeTree({
        inputs: [`${ROOT}/a`, `${ROOT}/b`],
      });

      expect(() => mergeTrees._mergeRelativePath({overwrite: true}, '')).to.throw(
        /Merge error: conflicting file types: bar is a directory in .* but a file in .*/);
      expect(() => mergeTrees._mergeRelativePath({overwrite: false}, '')).to.throw(
        /Merge error: conflicting file types: bar is a directory in .* but a file in .*/);
      expect(() => mergeTrees._mergeRelativePath(null, '')).to.throw(
        /Merge error: conflicting file types: bar is a directory in .* but a file in .*/);
    });
  });

  describe('changes', function () {
    it('merges directories with same name with one symlinked directory', function () {
      fixturify.writeSync(ROOT, {
        source: {
          index: {
            abc: 'abc',
            def: 'def',
          },
        },
        in1: {},
        in2: {
          index: {
            ghi: 'ghi',
            jkl: 'jkl',
          },
        },
        out: {},
      });

      const sourceTree = treeFromDisk(path.join(ROOT, 'source'));
      const inTree1 = treeFromDisk(path.join(ROOT, 'in1'));
      const inTree2 = treeFromDisk(path.join(ROOT, 'in2'));
      const outTree = treeFromDisk(path.join(ROOT, 'out')); 

      // On one side, index is a symlink.
      inTree1.symlinkSyncFromEntry(sourceTree, 'index', 'index');

      const mergedTree = new FSMergeTree({
        inputs: [inTree1, inTree2],
      });

      // Applying the changes in disk
      applyChanges(mergedTree.changes(null), outTree);

      expect(fixturify.readSync(`${ROOT}/out`)).to.deep.equal({
        index: {
          abc: 'abc',
          def: 'def',
          ghi: 'ghi',
          jkl: 'jkl',
        },
      });
    });

    it('merges directories with same name with both symlinked directory', function () {
      fixturify.writeSync(ROOT, {
        source1: {
          index: {
            abc: 'abc',
            def: 'def',
          },
        },
        source2: {
          index: {
            ghi: 'ghi',
            jkl: 'jkl',
          },
        },
        in1: {},
        in2: {},
        out: {},
      });

      const sourceTree1 = treeFromDisk(path.join(ROOT, 'source1'));
      const sourceTree2 = treeFromDisk(path.join(ROOT, 'source2'));
      const inTree1 = treeFromDisk(path.join(ROOT, 'in1'));
      const inTree2 = treeFromDisk(path.join(ROOT, 'in2'));
      const outTree = treeFromDisk(path.join(ROOT, 'out')); 

      // On both sides, index is a symlink.
      inTree1.symlinkSyncFromEntry(sourceTree1, 'index', 'index');
      inTree2.symlinkSyncFromEntry(sourceTree2, 'index', 'index');

      const mergedTree = new FSMergeTree({
        inputs: [inTree1, inTree2],
      });

      // Applying the changes in disk
      applyChanges(mergedTree.changes(null), outTree);

      expect(fixturify.readSync(`${ROOT}/out`)).to.deep.equal({
        index: {
          abc: 'abc',
          def: 'def',
          ghi: 'ghi',
          jkl: 'jkl',
        },
      });
    });

    it('merges symlinks when srcTree is true', () => {
      fixturify.writeSync(ROOT, {
        source: {
          index: {
            abc: 'abc',
            def: 'def',
          },
        },
        in1: {},
        in2: {
          index: {
            ghi: 'ghi',
            jkl: 'jkl',
          },
        },
        out: {},
      });

      fs.symlinkSync(path.join(ROOT, 'source', 'index'), path.join(ROOT, 'in1', 'index'));

      const outTree = treeFromDisk(path.join(ROOT, 'out')); 

      const mergedTree = new FSMergeTree({
        inputs: [path.join(ROOT, 'in1'), path.join(ROOT, 'in2')],
      });

      // Applying the changes in disk
      applyChanges(mergedTree.changes(null), outTree);

      expect(fixturify.readSync(`${ROOT}/out`)).to.deep.equal({
        index: {
          abc: 'abc',
          def: 'def',
          ghi: 'ghi',
          jkl: 'jkl',
        },
      });
    });
  });
});
