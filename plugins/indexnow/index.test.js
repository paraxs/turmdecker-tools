const assert = require('node:assert/strict');
const { mkdtemp, mkdir, readFile, readdir, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { onPostBuild, onSuccess } = require('./index.js');

test('production deploys baseline once, then submit changed and removed canonical pages', async () => {
  const originalContext = process.env.CONTEXT;
  const originalCwd = process.cwd();
  const originalFetch = global.fetch;
  const root = await mkdtemp(path.join(os.tmpdir(), 'indexnow-'));
  const publish = path.join(root, 'site');
  const requests = [];
  let cached;
  let postStatus = 200;
  const context = {
    constants: { PUBLISH_DIR: publish, IS_LOCAL: false },
    utils: { cache: {
      restore: async file => {
        if (!cached) return false;
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, cached);
        return true;
      },
      save: async file => { cached = await readFile(file, 'utf8'); return true; },
    } },
  };
  const html = (url, text) => `<link rel="canonical" href="${url}"><main>${text}</main>`;

  try {
    process.chdir(root);
    process.env.CONTEXT = 'production';
    await mkdir(publish);
    await writeFile(path.join(publish, 'index.html'), '<link href=https://tools.turmdecker.com/ rel=canonical><main>first</main>');
    await writeFile(path.join(publish, 'about.html'), html('https://tools.turmdecker.com/about/', 'about'));
    await writeFile(path.join(publish, 'foreign.html'), html('https://other.example/', 'foreign'));
    global.fetch = async (url, options) => {
      if (url.includes('api.indexnow.org')) requests.push(JSON.parse(options.body));
      return { ok: true, status: url.includes('api.indexnow.org') ? postStatus : 200, text: async () => {
        const [keyFile] = (await readdir(publish)).filter(name => /^[a-f0-9]{32}\.txt$/.test(name));
        return readFile(path.join(publish, keyFile), 'utf8');
      } };
    };

    await onPostBuild(context);
    await onSuccess(context);
    assert.equal(requests.length, 0, 'first production deploy only establishes baseline');
    assert.equal(Object.keys(JSON.parse(cached).pages).length, 2, 'minified canonical and ordinary canonical are saved');

    await onSuccess(context);
    assert.equal(requests.length, 0, 'unchanged deploy does not notify');

    await writeFile(path.join(publish, 'index.html'), html('https://tools.turmdecker.com/', 'updated'));
    await rm(path.join(publish, 'about.html'));
    await writeFile(path.join(publish, 'new.html'), html('https://tools.turmdecker.com/new/', 'new'));
    await onSuccess(context);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].urlList, ['https://tools.turmdecker.com/', 'https://tools.turmdecker.com/about/', 'https://tools.turmdecker.com/new/']);
    assert.equal(requests[0].host, 'tools.turmdecker.com');

    await onSuccess(context);
    assert.equal(requests.length, 1, 'successful submission advances baseline');

    const submittedBaseline = cached;
    await writeFile(path.join(publish, 'index.html'), html('https://tools.turmdecker.com/', 'third'));
    postStatus = 500;
    await onSuccess(context);
    assert.equal(cached, submittedBaseline, 'failed IndexNow request keeps the last submitted baseline');
    postStatus = 200;
    await onSuccess(context);
    assert.equal(requests.length, 3, 'failed request is retried on the next deploy');

    process.env.CONTEXT = 'deploy-preview';
    await onSuccess(context);
    assert.equal(requests.length, 3, 'preview deploy does not notify');
    process.env.CONTEXT = 'production';
    await onSuccess({ ...context, constants: { ...context.constants, IS_LOCAL: true } });
    assert.equal(requests.length, 3, 'local build does not notify');
  } finally {
    process.chdir(originalCwd);
    if (originalContext === undefined) delete process.env.CONTEXT;
    else process.env.CONTEXT = originalContext;
    global.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
