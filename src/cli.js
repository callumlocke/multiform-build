'use strict';

import path from 'path';
import Promise from 'bluebird';
import {transform} from 'babel-core';
import {Glob} from 'glob';
import {assign, defaults, merge} from 'lodash';
import fs from 'fs';

Promise.promisifyAll(fs);
const del = Promise.promisify(require('del'));


// ensure we finish with the appropriate code
let finished = false;
process.on('beforeExit', function () {
  if (!finished) {
    console.error('Build failed.');
    process.exit(1); // eslint-disable-line
  }
});


// load and normalise the build config
const cwd = process.cwd();
const config = require(path.join(cwd, 'multiform.json'));

defaults(config, {
  source: 'src',
});

config.source = path.resolve(config.source);

config.builds.forEach((build, i) => {
  defaults(build, {
    dir: 'dist-' + i,
  });

  if (!build.options) build.options = {};
  build.options = merge(build.options, config.defaults, (a, b) => {
    if (Array.isArray(a)) return a.concat(b);
  });

  build.dir = path.resolve(build.dir);
});


// start deleting destination directories
const destDirs = config.builds.map(build => path.resolve(cwd, build.dir));
const cleaned = Promise.all(destDirs.map((destDir => del(destDir))));


// fn to 'mkdirp' directories efficiently
const ensureDirExists = (() => {
  const dirPromises = {};
  dirPromises[cwd] = Promise.resolve();

  return function ensureDirExists(dir) {
    if (!dirPromises[dir]) {
      dirPromises[dir] = ensureDirExists(path.dirname(dir))
        .then(() => fs.mkdirAsync(dir).catch(err => {
          if (err.code !== 'EEXIST') throw err;
        }));
    }

    return dirPromises[dir];
  };
})();


// fn to compile a single source file
async function compile(filename) {
  const basename = path.basename(filename);
  const filenameAbs = path.join(config.source, filename);

  const code = await fs.readFileAsync(path.join(config.source, filename), 'utf8');

  await Promise.all(config.builds.map(async function (build) {
    const outFilenameAbs = path.join(build.dir, filename);
    const outDirname = path.dirname(outFilenameAbs);

    let result;
    const options = assign({
      ast: false,
      sourceMap: true,
      sourceMapName: basename,
      sourceFileName: filename,
      sourceRoot: path.relative(outDirname, config.source),
    }, build.options);

    try {
      result = transform(code, options);
    }
    catch (err) {
      console.error('Multiform: Failed to compile file', filenameAbs);
      console.error('to', outFilenameAbs);
      console.error('with options', options);
      throw err;
    }

    const output = result.code + '\n\n//# sourceMappingURL=' + basename + '.map\n';

    delete result.map.names;
    delete result.map.sourcesContent;


    // save the output file and sourcemap
    await cleaned;
    await ensureDirExists(outDirname);
    await Promise.all([
      fs.writeFileAsync(outFilenameAbs, output),
      fs.writeFileAsync(outFilenameAbs + '.map', JSON.stringify(result.map, null, 2)),
    ]);
  }));
}


// scan for files and build them
const jobs = [];

const glob = new Glob('**/*.{js,jsx,es,es6,es7}', {
  cwd: config.source,
  strict: true,
});

glob.on('match', filename => {
  jobs.push(compile(filename));
});

glob.on('err', err => { throw err; });

glob.on('end', () => {
  Promise.all(jobs)
    .then(() => { finished = true; })
    .catch(err => { throw err; });
});
